use clap::{Args as ClapArgs, Parser, Subcommand};
use perps_indexer::api::{router, App};
use perps_indexer::events::Decoder;
use perps_indexer::indexer::{fetch_market_meta, Indexer, IndexerCfg, RpcChain};
use perps_indexer::ratelimit::Limiter;
use perps_indexer::redis::RedisClient;
use perps_indexer::reindex::reindex_from_raw;
use perps_indexer::rpc::Rpc;
use perps_indexer::security::{generate_key, parse_cidrs, Security, SecurityCfg};
use perps_indexer::shared::Shared;
use perps_indexer::store::{EventStore, PgStore};
use perps_indexer::tracker::TxTracker;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;

/// Event indexer + read API for the Perps exchange.
/// Derived infrastructure: balances and margin here are NEVER authoritative; the chain is.
#[derive(Parser, Debug)]
#[command(version)]
struct Cli {
    #[command(flatten)]
    run: RunArgs,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Manage read-only API keys (stored hashed in Postgres)
    Keys {
        #[command(subcommand)]
        action: KeyCmd,
    },
    /// Re-run the decoder over the stored raw topics+data and rewrite decoded events (after an ABI refresh)
    ReindexFromRaw {
        /// Decode with this ABI JSON instead of the embedded one
        #[arg(long, env = "ABI_FILE")]
        abi_file: Option<String>,
        #[arg(long, default_value_t = 2000)]
        chunk: usize,
    },
}

#[derive(Subcommand, Debug)]
enum KeyCmd {
    /// Create a key. The plaintext key is printed ONCE; only its hash is stored.
    Create {
        #[arg(long)]
        label: String,
        /// requests/second for this key (default: --key-rate-rps of the server)
        #[arg(long)]
        rps: Option<f64>,
        #[arg(long)]
        burst: Option<f64>,
    },
    /// Revoke a key by id (effective on running servers within --key-refresh-secs)
    Revoke { id: String },
    /// List keys (id, label, state); never prints secrets
    List,
}

#[derive(ClapArgs, Debug)]
struct RunArgs {
    /// JSON-RPC endpoint of the execution node
    #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8545")]
    rpc_url: String,
    /// PostgreSQL connection string
    #[arg(long, env = "DATABASE_URL", default_value = "host=localhost user=postgres dbname=perps_indexer", global = true)]
    database_url: String,
    /// Deployment JSON written by contracts/scripts/deploy.js (provides exchange, chainId, market names)
    #[arg(long, env = "DEPLOYMENT")]
    deployment: Option<String>,
    /// Exchange (router) address; overrides --deployment
    #[arg(long, env = "EXCHANGE")]
    exchange: Option<String>,
    /// First block to index when the database is empty
    #[arg(long, env = "START_BLOCK", default_value_t = 0)]
    start_block: u64,
    #[arg(long, env = "LISTEN", default_value = "127.0.0.1:8080")]
    listen: SocketAddr,
    /// Blocks per ingestion batch
    #[arg(long, default_value_t = 200)]
    batch: u64,
    /// Page size when walking stored block hashes back to a fork point. Reorgs deeper than this are still
    /// re-anchored (page by page) and raise an operator alert; see --block-retention for the real limit.
    #[arg(long, default_value_t = 128)]
    reorg_window: usize,
    /// Keep block hashes for this many blocks behind the tip and prune older ones (0 = keep all). A reorg deeper
    /// than this cannot be anchored and halts indexing.
    #[arg(long, default_value_t = 100_000)]
    block_retention: u64,
    /// Persist a read-model snapshot every N blocks (0 = never); startup/reorg replay is bounded by this
    #[arg(long, default_value_t = 5000)]
    snapshot_every: u64,
    /// Snapshots kept
    #[arg(long, default_value_t = 4)]
    snapshot_keep: usize,
    /// Fills kept in memory (per process); older trades are served from Postgres
    #[arg(long, default_value_t = perps_indexer::state::DEFAULT_MAX_FILLS)]
    mem_fills: usize,
    /// Do not index the newest N blocks
    #[arg(long, default_value_t = 0)]
    confirmations: u64,
    #[arg(long, default_value_t = 300)]
    poll_ms: u64,
    /// Block headers per JSON-RPC batch request (1 = unbatched, one request per block)
    #[arg(long, default_value_t = 50)]
    rpc_batch_size: usize,
    /// Concurrent header batch requests
    #[arg(long, default_value_t = 4)]
    header_concurrency: usize,
    /// Disable prefetching the next batch while the current one is committed
    #[arg(long, default_value_t = false)]
    no_prefetch: bool,
    /// Decode with this ABI JSON instead of the embedded one (see scripts/refresh-abi.sh)
    #[arg(long, env = "ABI_FILE", global = true)]
    abi_file: Option<String>,

    /// Token-bucket refill rate per client IP for requests without an API key (requests/second); 0 disables
    #[arg(long, default_value_t = 50.0)]
    rate_rps: f64,
    #[arg(long, default_value_t = 100.0)]
    rate_burst: f64,
    /// Default token-bucket rate per API key (a key may override it)
    #[arg(long, default_value_t = 200.0)]
    key_rate_rps: f64,
    #[arg(long, default_value_t = 400.0)]
    key_rate_burst: f64,
    /// Extra CORS origins (comma separated, exact match) or `*`. Localhost origins are always allowed; default: nothing else.
    #[arg(long, env = "CORS_ORIGINS", default_value = "")]
    cors_origins: String,
    /// Proxies (comma separated IPs / CIDRs) allowed to set X-Forwarded-For. Default: none, the header is ignored.
    #[arg(long, env = "TRUSTED_PROXIES", default_value = "")]
    trusted_proxies: String,
    /// Reject /v1 requests that do not carry a valid API key
    #[arg(long, default_value_t = false)]
    require_api_key: bool,
    /// How often running servers reload the API key table (seconds)
    #[arg(long, default_value_t = 5)]
    key_refresh_secs: u64,
    /// Share rate-limit state between replicas through Redis (redis://[:pw@]host:port[/db]); in-memory if unset
    #[arg(long, env = "REDIS_URL")]
    redis_url: Option<String>,
    /// Per-websocket-client outbound queue capacity; overflow drops the client (close code 4008)
    #[arg(long, default_value_t = 256)]
    ws_queue: usize,
    /// /readyz fails when lag exceeds this many blocks
    #[arg(long, default_value_t = 5)]
    ready_max_lag: u64,
    /// Drop all indexer tables before starting (forces a full re-index)
    #[arg(long, default_value_t = false)]
    wipe: bool,
    /// Enable the opt-in receipt tracker (POST /v1/tx/track, GET /v1/tx/{hash})
    #[arg(long, default_value_t = false)]
    enable_tx_tracker: bool,
    #[arg(long, default_value_t = 600)]
    tx_track_timeout_secs: i64,
    #[arg(long, default_value_t = 10_000)]
    tx_track_max_pending: usize,
}

fn decoder(abi_file: &Option<String>) -> anyhow::Result<Decoder> {
    match abi_file {
        Some(p) => Decoder::from_abi_json(&std::fs::read_to_string(p)?),
        None => Decoder::embedded(),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let cli = Cli::parse();
    match cli.cmd {
        None => run(cli.run).await,
        Some(Cmd::Keys { action }) => keys(&cli.run, action).await,
        Some(Cmd::ReindexFromRaw { abi_file, chunk }) => {
            let pg = PgStore::connect(&cli.run.database_url).await?;
            pg.ensure_schema().await?;
            let dec = decoder(&abi_file.or(cli.run.abi_file.clone()))?;
            let rep = reindex_from_raw(&pg, &dec, chunk).await?;
            println!(
                "reindex-from-raw: scanned={} changed={} without_raw={} still_unknown={}",
                rep.scanned, rep.changed, rep.without_raw, rep.still_unknown
            );
            if rep.changed > 0 {
                println!("snapshots were cleared; the next indexer start replays the full log once");
            }
            if rep.without_raw > 0 {
                println!(
                    "note: {} rows predate raw-log storage and cannot be re-derived (re-index from the chain with --wipe if needed)",
                    rep.without_raw
                );
            }
            Ok(())
        }
    }
}

async fn keys(a: &RunArgs, action: KeyCmd) -> anyhow::Result<()> {
    let pg = PgStore::connect(&a.database_url).await?;
    pg.ensure_schema().await?;
    match action {
        KeyCmd::Create { label, rps, burst } => {
            let (rec, full) = generate_key(&label, rps, burst, now())?;
            pg.create_api_key(&rec).await?;
            println!("id:    {}\nlabel: {}\nkey:   {full}\n\nStore the key now: it is not recoverable (only its hash is kept). Send it as `X-API-Key: <key>`.\nKeys are READ-ONLY.", rec.id, rec.label);
        }
        KeyCmd::Revoke { id } => {
            if pg.revoke_api_key(&id, now()).await? {
                println!("revoked {id} (running servers pick this up within --key-refresh-secs)");
            } else {
                anyhow::bail!("no live key with id {id}");
            }
        }
        KeyCmd::List => {
            for k in pg.list_api_keys().await? {
                println!(
                    "{}  {:<24} {}  rps={} burst={}",
                    k.id,
                    k.label,
                    if k.revoked_at.is_some() { "REVOKED" } else { "active " },
                    k.rps.map(|x| x.to_string()).unwrap_or_else(|| "default".into()),
                    k.burst.map(|x| x.to_string()).unwrap_or_else(|| "default".into())
                );
            }
        }
    }
    Ok(())
}

async fn run(a: RunArgs) -> anyhow::Result<()> {
    let mut exchange = a.exchange.clone();
    let mut names: HashMap<u8, String> = HashMap::new();
    let mut dep_chain: Option<u64> = None;
    if let Some(p) = &a.deployment {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p)?)?;
        if exchange.is_none() {
            exchange = v.get("exchange").and_then(|x| x.as_str()).map(String::from);
        }
        dep_chain = v.get("chainId").and_then(|x| x.as_u64());
        if let Some(m) = v.get("marketIds").and_then(|x| x.as_object()) {
            for (n, id) in m {
                if let Some(id) = id.as_u64() {
                    names.insert(id as u8, n.clone());
                }
            }
        }
    }
    let exchange = exchange.ok_or_else(|| anyhow::anyhow!("--exchange or --deployment is required"))?;
    let rpc = Rpc::new(&a.rpc_url)?;
    let chain_id = rpc.chain_id().await?;
    if let Some(d) = dep_chain {
        if d != chain_id {
            anyhow::bail!("deployment chainId {d} != node chainId {chain_id}");
        }
    }

    let pg = PgStore::connect(&a.database_url).await?;
    if a.wipe {
        pg.wipe().await?;
        tracing::warn!("wiped indexer tables");
    }
    let store: Arc<dyn EventStore> = Arc::new(pg);
    store.init(chain_id, &exchange).await?;

    let shared = Arc::new(Shared::new(a.ws_queue, a.ready_max_lag));
    {
        let mut c = shared.chain.write().unwrap();
        c.chain_id = chain_id;
        c.exchange = exchange.clone();
        shared.state.write().unwrap().max_fills = a.mem_fills.max(1);
    }
    match fetch_market_meta(&rpc, &exchange, &names).await {
        Ok(m) => {
            tracing::info!(markets = m.len(), "loaded market metadata via eth_call");
            shared.state.write().unwrap().meta = m;
        }
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "could not load market metadata (continuing without it)")
        }
    }

    let mut rpc_chain = RpcChain::new(rpc, exchange.clone(), decoder(&a.abi_file)?);
    rpc_chain.batch_size = a.rpc_batch_size;
    rpc_chain.concurrency = a.header_concurrency;
    let chain: Arc<dyn perps_indexer::indexer::ChainSource> = Arc::new(rpc_chain);
    let idx = Arc::new(Indexer::new(
        chain.clone(),
        store.clone(),
        shared.clone(),
        IndexerCfg {
            start_block: a.start_block,
            batch: a.batch.max(1),
            reorg_window: a.reorg_window,
            confirmations: a.confirmations,
            poll_ms: a.poll_ms,
            snapshot_every: a.snapshot_every,
            snapshot_keep: a.snapshot_keep,
            block_retention: a.block_retention,
            prefetch: !a.no_prefetch,
        },
    ));
    idx.bootstrap().await?;
    let i2 = idx.clone();
    tokio::spawn(async move { i2.run().await });

    // ---- security: CORS, keys, rate limits
    let scfg = SecurityCfg {
        cors_origins: a.cors_origins.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
        trusted_proxies: parse_cidrs(&a.trusted_proxies)?,
        require_api_key: a.require_api_key,
        ip_rps: a.rate_rps,
        ip_burst: a.rate_burst,
        key_rps: a.key_rate_rps,
        key_burst: a.key_rate_burst,
    };
    let (ip_lim, key_lim) = match &a.redis_url {
        Some(u) => {
            let r = Arc::new(RedisClient::from_url(u)?);
            match r.ping().await {
                Ok(()) => tracing::info!("rate limits are shared through Redis"),
                Err(e) => tracing::warn!(error = %format!("{e:#}"), "Redis not reachable at startup; falling back to in-memory limits until it is"),
            }
            (Limiter::with_redis("rl:ip", r.clone()), Limiter::with_redis("rl:key", r))
        }
        None => (Limiter::local("ip"), Limiter::local("key")),
    };
    let security = Arc::new(Security::new(scfg, Some(store.clone()), ip_lim, key_lim));
    match security.refresh_keys().await {
        Ok(n) => tracing::info!(keys = n, require = a.require_api_key, "API keys loaded"),
        Err(e) => {
            if a.require_api_key {
                return Err(e.context("cannot load API keys"));
            }
            tracing::warn!(error = %format!("{e:#}"), "could not load API keys");
        }
    }
    {
        let sec = security.clone();
        let every = Duration::from_secs(a.key_refresh_secs.max(1));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                if let Err(e) = sec.refresh_keys().await {
                    tracing::warn!(error = %format!("{e:#}"), "API key refresh failed (keeping the previous table)");
                }
            }
        });
    }

    if a.enable_tx_tracker {
        let t = TxTracker {
            chain: chain.clone(),
            store: store.clone(),
            timeout_secs: a.tx_track_timeout_secs,
            recheck_depth: a.reorg_window as u64,
        };
        tokio::spawn(async move { t.run(Duration::from_secs(2)).await });
    }

    let mut app_state = App::new(shared, security);
    app_state.store = Some(store);
    app_state.tx_tracking = a.enable_tx_tracker;
    app_state.tx_track_max_pending = a.tx_track_max_pending;
    let app = router(app_state);
    let listener = tokio::net::TcpListener::bind(a.listen).await?;
    tracing::info!(listen = %a.listen, exchange = %exchange, chain_id, "indexer API up");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}
