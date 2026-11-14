//! Configuration: defaults < TOML file < environment < CLI flags. Secrets are NEVER stored here: only the *name* of the
//! environment variable (or the keystore path) that holds them, so `Debug` of the config cannot leak a key.
use alloy::primitives::Address;
use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser};
use serde::Deserialize;
use std::{net::SocketAddr, path::PathBuf, str::FromStr};

#[derive(Parser, Debug)]
#[command(name = "perp-keeper", version, about = "Permissionless keeper for the Perps exchange (UNAUDITED prototype)")]
pub struct Cli {
    /// Optional TOML config file (keys are the long flag names with underscores).
    #[arg(long, env = "KEEPER_CONFIG")]
    pub config: Option<PathBuf>,
    #[command(flatten)]
    pub raw: RawConfig,
}

#[derive(Args, Deserialize, Default, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RawConfig {
    /// HTTP(S) JSON-RPC endpoint (primary). Combine with --rpc-urls for failover.
    #[arg(long, env = "KEEPER_RPC_URL")]
    pub rpc_url: Option<String>,
    /// Additional/fallback JSON-RPC endpoints (comma separated). Order = preference; `rpc_url` (if set) is tried first.
    #[arg(long, env = "KEEPER_RPC_URLS", value_delimiter = ',')]
    pub rpc_urls: Option<Vec<String>>,
    /// Seconds a failed RPC endpoint is avoided before it is retried.
    #[arg(long, env = "KEEPER_RPC_COOLDOWN_SECS")]
    pub rpc_cooldown_secs: Option<u64>,
    /// An endpoint whose head trails the best endpoint by more than this many blocks is treated as unhealthy.
    #[arg(long, env = "KEEPER_RPC_MAX_LAG_BLOCKS")]
    pub rpc_max_lag_blocks: Option<u64>,
    /// Max concurrent RPC requests for batched reads (Multicall3 chunks, or single calls in the fallback path).
    #[arg(long, env = "KEEPER_RPC_CONCURRENCY")]
    pub rpc_concurrency: Option<usize>,
    /// `auto` (use Multicall3 if deployed), `on` (require it), `off` (parallel eth_calls only).
    #[arg(long, env = "KEEPER_MULTICALL")]
    pub multicall: Option<String>,
    /// Multicall3 address (default: the canonical 0xcA11...CA11).
    #[arg(long, env = "KEEPER_MULTICALL_ADDRESS")]
    pub multicall_address: Option<String>,
    /// Max sub-calls per aggregate3.
    #[arg(long, env = "KEEPER_MULTICALL_CHUNK")]
    pub multicall_chunk: Option<usize>,
    /// Number of recent block hashes kept for reorg detection (and max reorg depth that can be undone).
    #[arg(long, env = "KEEPER_REORG_WINDOW")]
    pub reorg_window: Option<u64>,
    /// USD price of one native gas token, used only to compare gas cost with the liquidation reward.
    #[arg(long, env = "KEEPER_NATIVE_USD_PRICE")]
    pub native_usd_price: Option<f64>,
    /// Required profit (USD, reward minus gas) for a liquidation to be sent.
    #[arg(long, env = "KEEPER_MIN_PROFIT_USD")]
    pub min_profit_usd: Option<f64>,
    /// Send liquidations even when the estimated gas cost exceeds the keeper reward.
    #[arg(long, env = "KEEPER_FORCE_UNPROFITABLE", num_args = 0..=1, default_missing_value = "true")]
    pub force_unprofitable: Option<bool>,
    /// Random delay (0..=N ms) before submitting a liquidation. Only desynchronises identical keepers; it does NOT win races.
    #[arg(long, env = "KEEPER_SUBMIT_JITTER_MS")]
    pub submit_jitter_ms: Option<u64>,
    /// Sign locally but broadcast the raw transaction (eth_sendRawTransaction) to this endpoint instead of the public RPC
    /// (private-relay / flashbots-style). There is NO fallback to the public mempool.
    #[arg(long, env = "KEEPER_SEND_RAW_VIA")]
    pub send_raw_via: Option<String>,
    /// Exchange router address (the single address behind which all modules run).
    #[arg(long, env = "KEEPER_EXCHANGE")]
    pub exchange: Option<String>,
    /// First block to scan for events when no checkpoint exists (use the deployment block).
    #[arg(long, env = "KEEPER_START_BLOCK")]
    pub start_block: Option<u64>,
    /// Checkpoint/state file (accounts, conditional + TWAP orders, scan position).
    #[arg(long, env = "KEEPER_STATE_FILE")]
    pub state_file: Option<PathBuf>,
    #[arg(long, env = "KEEPER_POLL_INTERVAL_MS")]
    pub poll_interval_ms: Option<u64>,
    /// Only scan logs up to head - confirmations (reorg safety on real chains).
    #[arg(long, env = "KEEPER_CONFIRMATIONS")]
    pub confirmations: Option<u64>,
    /// Max block span per eth_getLogs request.
    #[arg(long, env = "KEEPER_LOG_CHUNK")]
    pub log_chunk: Option<u64>,
    /// Override: poke every market this often. Default: each market's own `fundingInterval` from getMarket.
    #[arg(long, env = "KEEPER_FUNDING_INTERVAL_SECS")]
    pub funding_interval_secs: Option<u64>,
    #[arg(long, env = "KEEPER_ENABLE_FUNDING", num_args = 0..=1, default_missing_value = "true")]
    pub enable_funding: Option<bool>,
    #[arg(long, env = "KEEPER_ENABLE_LIQUIDATION", num_args = 0..=1, default_missing_value = "true")]
    pub enable_liquidation: Option<bool>,
    #[arg(long, env = "KEEPER_ENABLE_CONDITIONAL", num_args = 0..=1, default_missing_value = "true")]
    pub enable_conditional: Option<bool>,
    #[arg(long, env = "KEEPER_ENABLE_TWAP", num_args = 0..=1, default_missing_value = "true")]
    pub enable_twap: Option<bool>,
    #[arg(long, env = "KEEPER_ENABLE_ADL", num_args = 0..=1, default_missing_value = "true")]
    pub enable_adl: Option<bool>,
    /// Sweep flat, negative accounts with the permissionless `writeOff` (records bad debt so ADL can clear it).
    #[arg(long, env = "KEEPER_ENABLE_WRITEOFF", num_args = 0..=1, default_missing_value = "true")]
    pub enable_writeoff: Option<bool>,
    /// Call `syncBackstop` (records the backstop's mark-to-market deficit / repays earlier draws).
    #[arg(long, env = "KEEPER_ENABLE_SYNC_BACKSTOP", num_args = 0..=1, default_missing_value = "true")]
    pub enable_sync_backstop: Option<bool>,
    /// `syncBackstop` pays nothing on-chain; sent only if the estimated gas cost is <= this many USD (or --force-unprofitable).
    #[arg(long, env = "KEEPER_SYNC_BACKSTOP_MAX_GAS_USD")]
    pub sync_backstop_max_gas_usd: Option<f64>,
    /// Periodic `syncBackstop` check interval (it is also checked whenever a mark changes while the backstop holds inventory).
    #[arg(long, env = "KEEPER_SYNC_BACKSTOP_INTERVAL_SECS")]
    pub sync_backstop_interval_secs: Option<u64>,
    /// Backstop Phase 2: `pokeBackstop(market)` starts/stops the elevation clock when the backstop's inventory notional crosses `softNotional`.
    #[arg(long, env = "KEEPER_ENABLE_POKE_BACKSTOP", num_args = 0..=1, default_missing_value = "true")]
    pub enable_poke_backstop: Option<bool>,
    #[arg(long, env = "KEEPER_POKE_BACKSTOP_MAX_GAS_USD")]
    pub poke_backstop_max_gas_usd: Option<f64>,
    /// Backstop Phase 2: `unwindBackstop` closes ranked profitable opposite-side accounts at mark once a market has been elevated for `maxAge`.
    #[arg(long, env = "KEEPER_ENABLE_UNWIND_BACKSTOP", num_args = 0..=1, default_missing_value = "true")]
    pub enable_unwind_backstop: Option<bool>,
    #[arg(long, env = "KEEPER_UNWIND_BACKSTOP_MAX_GAS_USD")]
    pub unwind_backstop_max_gas_usd: Option<f64>,
    /// Minimum seconds between inventory checks per keeper (they cost 3 reads per market).
    #[arg(long, env = "KEEPER_BACKSTOP_INVENTORY_INTERVAL_SECS")]
    pub backstop_inventory_interval_secs: Option<u64>,
    /// `writeOff` pays the keeper nothing on-chain; it is sent only if the estimated gas cost is <= this many USD (or --force-unprofitable).
    #[arg(long, env = "KEEPER_WRITEOFF_MAX_GAS_USD")]
    pub writeoff_max_gas_usd: Option<f64>,
    /// Push signed Pyth price updates (from Hermes) to the Pyth contract when the on-chain price gets old. Default off.
    #[arg(long, env = "KEEPER_ENABLE_PYTH_PUSH", num_args = 0..=1, default_missing_value = "true")]
    pub enable_pyth_push: Option<bool>,
    /// Pyth contract address on this chain (required with --enable-pyth-push).
    #[arg(long, env = "KEEPER_PYTH_CONTRACT")]
    pub pyth_contract: Option<String>,
    /// Pyth price feed ids to keep fresh (comma separated 32-byte hex; optional label as `BTC=0x..`). One per market.
    #[arg(long, env = "KEEPER_PYTH_FEED_IDS", value_delimiter = ',')]
    pub pyth_feed_ids: Option<Vec<String>>,
    /// Hermes base URL (default https://pyth.dourolabs.app/hermes). May be a provider URL that embeds its key: it is never logged in full.
    #[arg(long, env = "KEEPER_HERMES_URL")]
    pub hermes_url: Option<String>,
    /// Name of the HTTP header that carries the Hermes API key (default `Authorization`).
    #[arg(long, env = "KEEPER_HERMES_API_KEY_HEADER")]
    pub hermes_api_key_header: Option<String>,
    /// Text put in front of the key in the header value (default `Bearer `; set to an empty string with `x-api-key`).
    #[arg(long, env = "KEEPER_HERMES_API_KEY_PREFIX")]
    pub hermes_api_key_prefix: Option<String>,
    /// Name of the env var holding the Hermes API key VALUE (default KEEPER_HERMES_API_KEY). Unset/empty = no auth header.
    #[arg(long, env = "KEEPER_HERMES_API_KEY_ENV")]
    pub hermes_api_key_env: Option<String>,
    /// Per-request Hermes timeout, seconds.
    #[arg(long, env = "KEEPER_HERMES_TIMEOUT_SECS")]
    pub hermes_timeout_secs: Option<u64>,
    /// How often the on-chain Pyth ages are checked (a push happens only when one is old enough). Default 20.
    #[arg(long, env = "KEEPER_PYTH_PUSH_INTERVAL_SECS")]
    pub pyth_push_interval_secs: Option<u64>,
    /// The exchange's oracle max age in seconds (MedianOracle `maxAge`, default 3600): beyond it reads revert `OracleDegraded`.
    #[arg(long, env = "KEEPER_PYTH_MAX_AGE_SECS")]
    pub pyth_max_age_secs: Option<u64>,
    /// Push when any feed's on-chain publishTime is at least this old. Default: pyth_max_age_secs / 2.
    #[arg(long, env = "KEEPER_PYTH_PUSH_WHEN_AGE_SECS")]
    pub pyth_push_when_age_secs: Option<u64>,
    /// Hard cap on the Pyth update fee (wei) for one push. Never overridden by --force-unprofitable.
    #[arg(long, env = "KEEPER_PYTH_MAX_FEE_WEI")]
    pub pyth_max_fee_wei: Option<u64>,
    /// Send a push only if its estimated gas cost is <= this many USD (pushes pay nothing); --force-unprofitable overrides.
    #[arg(long, env = "KEEPER_PYTH_MAX_GAS_USD")]
    pub pyth_max_gas_usd: Option<f64>,
    /// Rolling one-hour spend ceiling (update fee + worst-case gas, wei). Never overridden by --force-unprofitable.
    #[arg(long, env = "KEEPER_PYTH_HOURLY_BUDGET_WEI")]
    pub pyth_hourly_budget_wei: Option<u64>,
    /// +/- percent random jitter on the check interval and on retry backoff (0..=50).
    #[arg(long, env = "KEEPER_PYTH_JITTER_PCT")]
    pub pyth_jitter_pct: Option<u64>,
    /// Simulate (eth_call) everything but never send a transaction. A signing key is then optional.
    #[arg(long, env = "KEEPER_DRY_RUN", num_args = 0..=1, default_missing_value = "true")]
    pub dry_run: Option<bool>,
    #[arg(long, env = "KEEPER_METRICS_ADDR")]
    pub metrics_addr: Option<String>,
    #[arg(long, env = "KEEPER_TX_TIMEOUT_SECS")]
    pub tx_timeout_secs: Option<u64>,
    #[arg(long, env = "KEEPER_MAX_BUMP_ATTEMPTS")]
    pub max_bump_attempts: Option<u32>,
    /// Fee bump per replacement attempt, percent (minimum 12 is enforced; nodes require >= 10%).
    #[arg(long, env = "KEEPER_GAS_BUMP_PCT")]
    pub gas_bump_pct: Option<u64>,
    /// Extra gas limit headroom over eth_estimateGas, percent.
    #[arg(long, env = "KEEPER_GAS_BUFFER_PCT")]
    pub gas_buffer_pct: Option<u64>,
    /// Refuse to bid above this max fee per gas (gwei).
    #[arg(long, env = "KEEPER_MAX_FEE_GWEI")]
    pub max_fee_gwei: Option<u64>,
    /// Upper bound on transactions per kind per poll cycle.
    #[arg(long, env = "KEEPER_MAX_ACTIONS_PER_TICK")]
    pub max_actions_per_tick: Option<usize>,
    /// Name of the env var holding a hex private key (default KEEPER_PRIVATE_KEY).
    #[arg(long, env = "KEEPER_PRIVATE_KEY_ENV")]
    pub private_key_env: Option<String>,
    /// Path to an encrypted JSON keystore (alternative to a raw key).
    #[arg(long, env = "KEEPER_KEYSTORE_PATH")]
    pub keystore_path: Option<PathBuf>,
    /// Name of the env var holding the keystore password (default KEEPER_KEYSTORE_PASSWORD).
    #[arg(long, env = "KEEPER_KEYSTORE_PASSWORD_ENV")]
    pub keystore_password_env: Option<String>,
    /// `text` or `json`.
    #[arg(long, env = "KEEPER_LOG_FORMAT")]
    pub log_format: Option<String>,
    /// /readyz fails when the scan position trails head by more than this many blocks.
    #[arg(long, env = "KEEPER_MAX_READY_LAG_BLOCKS")]
    pub max_ready_lag_blocks: Option<u64>,
}

impl RawConfig {
    /// `self` wins; gaps are filled from `lower`.
    pub fn overlay(self, lower: RawConfig) -> RawConfig {
        macro_rules! pick { ($($f:ident),*) => { RawConfig { $($f: self.$f.or(lower.$f)),* } } }
        pick!(rpc_url, rpc_urls, rpc_cooldown_secs, rpc_max_lag_blocks, rpc_concurrency, multicall, multicall_address, multicall_chunk,
              reorg_window, native_usd_price, min_profit_usd, force_unprofitable, submit_jitter_ms, send_raw_via, exchange, start_block, state_file, poll_interval_ms, confirmations, log_chunk, funding_interval_secs,
              enable_funding, enable_liquidation, enable_conditional, enable_twap, enable_adl, enable_writeoff, writeoff_max_gas_usd, enable_sync_backstop, sync_backstop_max_gas_usd, sync_backstop_interval_secs, enable_poke_backstop, poke_backstop_max_gas_usd, enable_unwind_backstop, unwind_backstop_max_gas_usd, backstop_inventory_interval_secs, dry_run, metrics_addr,
              enable_pyth_push, pyth_contract, pyth_feed_ids, hermes_url, hermes_api_key_header, hermes_api_key_prefix, hermes_api_key_env, hermes_timeout_secs,
              pyth_push_interval_secs, pyth_max_age_secs, pyth_push_when_age_secs, pyth_max_fee_wei, pyth_max_gas_usd, pyth_hourly_budget_wei, pyth_jitter_pct,
              tx_timeout_secs, max_bump_attempts, gas_bump_pct, gas_buffer_pct, max_fee_gwei, max_actions_per_tick,
              private_key_env, keystore_path, keystore_password_env, log_format, max_ready_lag_blocks)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogFormat { Text, Json }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MulticallMode { Auto, On, Off }

/// `scheme://host[:port]` of any URL string (no userinfo, path or query); `<invalid>` if it does not parse.
pub fn redact_url(u: &str) -> String {
    match u.trim().parse::<alloy::transports::http::reqwest::Url>() {
        Ok(p) => format!("{}://{}{}", p.scheme(), p.host_str().unwrap_or("?"), p.port().map(|x| format!(":{x}")).unwrap_or_default()),
        Err(_) => "<invalid>".into(),
    }
}

/// A URL that may embed credentials (userinfo, path token, query key). `Debug`/`Display` show only `scheme://host[:port]`.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretUrl(String);

impl SecretUrl {
    pub fn parse(s: &str) -> Result<SecretUrl> {
        let u = s.trim().parse::<alloy::transports::http::reqwest::Url>().map_err(|e| anyhow!("invalid hermes_url: {e}"))?;
        if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
            bail!("hermes_url must be an http(s) URL");
        }
        Ok(SecretUrl(s.trim().to_string()))
    }
    /// The full URL. Only for building requests; never log it.
    pub fn expose(&self) -> &str { &self.0 }
    /// `scheme://host[:port]` only (no userinfo, path or query).
    pub fn redacted(&self) -> String { redact_url(&self.0) }
}

impl std::fmt::Debug for SecretUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}/<redacted>", self.redacted()) }
}

/// Pyth pusher settings (only meaningful with `enable_pyth_push`). Holds env-var NAMES, never the API key value.
#[derive(Clone, Debug)]
pub struct PythCfg {
    pub contract: Address,
    /// `(label, feed id)`; the label is only for metrics/logs (default: the id's first 4 bytes).
    pub feeds: Vec<(String, alloy::primitives::B256)>,
    pub hermes_url: SecretUrl,
    pub api_key_header: String,
    /// Prepended to the key to form the header value (default `Bearer `).
    pub api_key_prefix: String,
    /// Env var NAME holding the key; `HERMES_API_KEY` is also tried when this one is empty.
    pub api_key_env: String,
    pub hermes_timeout_secs: u64,
    pub push_interval_secs: u64,
    pub max_age_secs: u64,
    pub push_when_age_secs: u64,
    pub max_fee_wei: u64,
    pub max_gas_usd: f64,
    pub hourly_budget_wei: u64,
    pub jitter_pct: u64,
}

pub const DEFAULT_HERMES_URL: &str = "https://pyth.dourolabs.app/hermes";
/// Fallback env var for the Hermes key (the name used in contracts/.env).
pub const FALLBACK_HERMES_KEY_ENV: &str = "HERMES_API_KEY";

impl PythCfg {
    fn from_raw(r: &RawConfig) -> Result<PythCfg> {
        let contract = Address::from_str(r.pyth_contract.as_deref().ok_or_else(|| anyhow!("enable_pyth_push needs pyth_contract (--pyth-contract / KEEPER_PYTH_CONTRACT)"))?)
            .map_err(|e| anyhow!("invalid pyth_contract: {e}"))?;
        let mut feeds: Vec<(String, alloy::primitives::B256)> = vec![];
        for raw in r.pyth_feed_ids.clone().unwrap_or_default() {
            let raw = raw.trim();
            if raw.is_empty() { continue; }
            let (label, id) = match raw.split_once('=') { Some((l, i)) => (Some(l.trim().to_string()), i.trim()), None => (None, raw) };
            let id = alloy::primitives::B256::from_str(id).map_err(|e| anyhow!("invalid pyth feed id `{id}` (need 32-byte hex): {e}"))?;
            if feeds.iter().any(|(_, f)| *f == id) { bail!("duplicate pyth feed id {id}"); }
            let label = label.filter(|l| !l.is_empty()).unwrap_or_else(|| format!("{id:#x}")[..10].to_string());
            if label.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == 'x')) {
                bail!("pyth feed label `{label}` may only contain letters, digits, `_` and `-`");
            }
            feeds.push((label, id));
        }
        if feeds.is_empty() { bail!("enable_pyth_push needs at least one pyth_feed_ids entry"); }
        let hermes_url = SecretUrl::parse(r.hermes_url.as_deref().unwrap_or(DEFAULT_HERMES_URL))?;
        let api_key_header = r.hermes_api_key_header.clone().unwrap_or_else(|| "Authorization".into());
        api_key_header.parse::<alloy::transports::http::reqwest::header::HeaderName>().map_err(|e| anyhow!("invalid hermes_api_key_header: {e}"))?;
        let max_age_secs = r.pyth_max_age_secs.unwrap_or(3600);
        if max_age_secs < 2 { bail!("pyth_max_age_secs must be >= 2"); }
        let push_when_age_secs = r.pyth_push_when_age_secs.unwrap_or(max_age_secs / 2);
        if push_when_age_secs == 0 || push_when_age_secs >= max_age_secs {
            bail!("pyth_push_when_age_secs must be in 1..pyth_max_age_secs ({max_age_secs}), got {push_when_age_secs}");
        }
        let max_gas_usd = r.pyth_max_gas_usd.unwrap_or(0.50);
        if !max_gas_usd.is_finite() || max_gas_usd < 0.0 { bail!("pyth_max_gas_usd must be a finite number >= 0"); }
        let jitter_pct = r.pyth_jitter_pct.unwrap_or(10);
        if jitter_pct > 50 { bail!("pyth_jitter_pct must be <= 50"); }
        let hermes_timeout_secs = r.hermes_timeout_secs.unwrap_or(10);
        if hermes_timeout_secs == 0 { bail!("hermes_timeout_secs must be > 0"); }
        Ok(PythCfg {
            contract,
            feeds,
            hermes_url,
            api_key_header,
            api_key_prefix: r.hermes_api_key_prefix.clone().unwrap_or_else(|| "Bearer ".into()),
            api_key_env: r.hermes_api_key_env.clone().unwrap_or_else(|| "KEEPER_HERMES_API_KEY".into()),
            hermes_timeout_secs,
            push_interval_secs: r.pyth_push_interval_secs.unwrap_or(20).max(1),
            max_age_secs,
            push_when_age_secs,
            max_fee_wei: r.pyth_max_fee_wei.unwrap_or(100_000_000_000_000),
            max_gas_usd,
            hourly_budget_wei: r.pyth_hourly_budget_wei.unwrap_or(5_000_000_000_000_000),
            jitter_pct,
        })
    }

    /// Placeholder used when the feature is disabled (never read).
    fn disabled() -> PythCfg {
        PythCfg {
            contract: Address::ZERO,
            feeds: vec![],
            hermes_url: SecretUrl(DEFAULT_HERMES_URL.into()),
            api_key_header: "Authorization".into(),
            api_key_prefix: "Bearer ".into(),
            api_key_env: "KEEPER_HERMES_API_KEY".into(),
            hermes_timeout_secs: 10,
            push_interval_secs: 20,
            max_age_secs: 3600,
            push_when_age_secs: 1800,
            max_fee_wei: 0,
            max_gas_usd: 0.0,
            hourly_budget_wei: 0,
            jitter_pct: 10,
        }
    }
}

#[derive(Clone)]
pub struct Config {
    /// Ordered, de-duplicated endpoints (at least one).
    pub rpc_urls: Vec<String>,
    pub rpc_cooldown_secs: u64,
    pub rpc_max_lag_blocks: u64,
    pub rpc_concurrency: usize,
    pub multicall: MulticallMode,
    pub multicall_address: Address,
    pub multicall_chunk: usize,
    pub reorg_window: u64,
    pub native_usd_price: f64,
    pub min_profit_usd: f64,
    pub force_unprofitable: bool,
    pub submit_jitter_ms: u64,
    pub send_raw_via: Option<String>,
    pub exchange: Address,
    pub start_block: u64,
    pub state_file: PathBuf,
    pub poll_interval_ms: u64,
    pub confirmations: u64,
    pub log_chunk: u64,
    /// `None` = per-market `fundingInterval`.
    pub funding_interval_secs: Option<u64>,
    pub enable_funding: bool,
    pub enable_liquidation: bool,
    pub enable_conditional: bool,
    pub enable_twap: bool,
    pub enable_adl: bool,
    pub enable_writeoff: bool,
    pub enable_sync_backstop: bool,
    pub enable_poke_backstop: bool,
    pub enable_unwind_backstop: bool,
    pub poke_backstop_max_gas_usd: f64,
    pub unwind_backstop_max_gas_usd: f64,
    pub backstop_inventory_interval_secs: u64,
    pub enable_pyth_push: bool,
    pub pyth: PythCfg,
    pub sync_backstop_max_gas_usd: f64,
    pub sync_backstop_interval_secs: u64,
    pub writeoff_max_gas_usd: f64,
    pub dry_run: bool,
    pub metrics_addr: SocketAddr,
    pub tx_timeout_secs: u64,
    pub max_bump_attempts: u32,
    pub gas_bump_pct: u64,
    pub gas_buffer_pct: u64,
    pub max_fee_gwei: u64,
    pub max_actions_per_tick: usize,
    pub private_key_env: String,
    pub keystore_path: Option<PathBuf>,
    pub keystore_password_env: String,
    pub log_format: LogFormat,
    pub max_ready_lag_blocks: u64,
}

impl std::fmt::Debug for Config {
    /// Endpoint URLs may embed API keys: they are printed as `scheme://host[:port]` only.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let rpc_urls: Vec<String> = self.rpc_urls.iter().map(|u| redact_url(u)).collect();
        let send_raw_via = self.send_raw_via.as_deref().map(redact_url);
        f.debug_struct("Config")
            .field("rpc_urls", &rpc_urls)
            .field("rpc_cooldown_secs", &self.rpc_cooldown_secs)
            .field("rpc_max_lag_blocks", &self.rpc_max_lag_blocks)
            .field("rpc_concurrency", &self.rpc_concurrency)
            .field("multicall", &self.multicall)
            .field("multicall_address", &self.multicall_address)
            .field("multicall_chunk", &self.multicall_chunk)
            .field("reorg_window", &self.reorg_window)
            .field("native_usd_price", &self.native_usd_price)
            .field("min_profit_usd", &self.min_profit_usd)
            .field("force_unprofitable", &self.force_unprofitable)
            .field("submit_jitter_ms", &self.submit_jitter_ms)
            .field("send_raw_via", &send_raw_via)
            .field("exchange", &self.exchange)
            .field("start_block", &self.start_block)
            .field("state_file", &self.state_file)
            .field("poll_interval_ms", &self.poll_interval_ms)
            .field("confirmations", &self.confirmations)
            .field("log_chunk", &self.log_chunk)
            .field("funding_interval_secs", &self.funding_interval_secs)
            .field("enable_funding", &self.enable_funding)
            .field("enable_liquidation", &self.enable_liquidation)
            .field("enable_conditional", &self.enable_conditional)
            .field("enable_twap", &self.enable_twap)
            .field("enable_adl", &self.enable_adl)
            .field("enable_writeoff", &self.enable_writeoff)
            .field("enable_sync_backstop", &self.enable_sync_backstop)
            .field("enable_poke_backstop", &self.enable_poke_backstop)
            .field("enable_unwind_backstop", &self.enable_unwind_backstop)
            .field("poke_backstop_max_gas_usd", &self.poke_backstop_max_gas_usd)
            .field("unwind_backstop_max_gas_usd", &self.unwind_backstop_max_gas_usd)
            .field("backstop_inventory_interval_secs", &self.backstop_inventory_interval_secs)
            .field("enable_pyth_push", &self.enable_pyth_push)
            .field("pyth", &self.pyth)
            .field("sync_backstop_max_gas_usd", &self.sync_backstop_max_gas_usd)
            .field("sync_backstop_interval_secs", &self.sync_backstop_interval_secs)
            .field("writeoff_max_gas_usd", &self.writeoff_max_gas_usd)
            .field("dry_run", &self.dry_run)
            .field("metrics_addr", &self.metrics_addr)
            .field("tx_timeout_secs", &self.tx_timeout_secs)
            .field("max_bump_attempts", &self.max_bump_attempts)
            .field("gas_bump_pct", &self.gas_bump_pct)
            .field("gas_buffer_pct", &self.gas_buffer_pct)
            .field("max_fee_gwei", &self.max_fee_gwei)
            .field("max_actions_per_tick", &self.max_actions_per_tick)
            .field("private_key_env", &self.private_key_env)
            .field("keystore_path", &self.keystore_path)
            .field("keystore_password_env", &self.keystore_password_env)
            .field("log_format", &self.log_format)
            .field("max_ready_lag_blocks", &self.max_ready_lag_blocks)
            .finish()
    }
}


impl Config {
    pub fn load(cli: Cli) -> Result<Config> {
        let file = match &cli.config {
            Some(p) => {
                let txt = std::fs::read_to_string(p).with_context(|| format!("reading config {}", p.display()))?;
                toml::from_str::<RawConfig>(&txt).with_context(|| format!("parsing config {}", p.display()))?
            }
            None => RawConfig::default(),
        };
        Config::from_raw(cli.raw.overlay(file))
    }

    pub fn from_raw(r: RawConfig) -> Result<Config> {
        let enable_pyth_push = r.enable_pyth_push.unwrap_or(false);
        let pyth = if enable_pyth_push { PythCfg::from_raw(&r)? } else { PythCfg::disabled() };
        let mut rpc_urls: Vec<String> = vec![];
        for u in r.rpc_url.into_iter().chain(r.rpc_urls.unwrap_or_default()) {
            let u = u.trim().to_string();
            if !u.is_empty() && !rpc_urls.contains(&u) {
                rpc_urls.push(u);
            }
        }
        if rpc_urls.is_empty() {
            bail!("rpc_url is required (--rpc-url / KEEPER_RPC_URL, optionally --rpc-urls for failover)");
        }
        let multicall = match r.multicall.as_deref().unwrap_or("auto") {
            "auto" => MulticallMode::Auto,
            "on" => MulticallMode::On,
            "off" => MulticallMode::Off,
            o => bail!("multicall must be `auto`, `on` or `off`, got `{o}`"),
        };
        let multicall_address = match r.multicall_address {
            Some(a) => Address::from_str(&a).map_err(|e| anyhow!("invalid multicall_address: {e}"))?,
            None => crate::batch::MULTICALL3,
        };
        let multicall_chunk = r.multicall_chunk.unwrap_or(200);
        if multicall_chunk == 0 { bail!("multicall_chunk must be > 0"); }
        let rpc_concurrency = r.rpc_concurrency.unwrap_or(8);
        if rpc_concurrency == 0 { bail!("rpc_concurrency must be > 0"); }
        let reorg_window = r.reorg_window.unwrap_or(64);
        if reorg_window == 0 { bail!("reorg_window must be > 0"); }
        for (name, v) in [("native_usd_price", r.native_usd_price), ("min_profit_usd", r.min_profit_usd)] {
            if matches!(v, Some(x) if !x.is_finite() || x < 0.0) { bail!("{name} must be a finite number >= 0"); }
        }
        if let Some(u) = &r.send_raw_via {
            u.parse::<alloy::transports::http::reqwest::Url>().map_err(|e| anyhow!("invalid send_raw_via: {e}"))?;
        }
        let exchange = Address::from_str(&r.exchange.ok_or_else(|| anyhow!("exchange is required (--exchange / KEEPER_EXCHANGE)"))?)
            .map_err(|e| anyhow!("invalid exchange address: {e}"))?;
        let poll_interval_ms = r.poll_interval_ms.unwrap_or(2000);
        if poll_interval_ms == 0 { bail!("poll_interval_ms must be > 0"); }
        let log_chunk = r.log_chunk.unwrap_or(2000);
        if log_chunk == 0 { bail!("log_chunk must be > 0"); }
        let funding_interval_secs = r.funding_interval_secs;
        if funding_interval_secs == Some(0) { bail!("funding_interval_secs must be > 0"); }
        let log_format = match r.log_format.as_deref().unwrap_or("text") {
            "text" => LogFormat::Text,
            "json" => LogFormat::Json,
            o => bail!("log_format must be `text` or `json`, got `{o}`"),
        };
        let metrics_addr = SocketAddr::from_str(r.metrics_addr.as_deref().unwrap_or("127.0.0.1:9100"))
            .map_err(|e| anyhow!("invalid metrics_addr: {e}"))?;
        Ok(Config {
            rpc_urls,
            rpc_cooldown_secs: r.rpc_cooldown_secs.unwrap_or(30),
            rpc_max_lag_blocks: r.rpc_max_lag_blocks.unwrap_or(10),
            rpc_concurrency,
            multicall,
            multicall_address,
            multicall_chunk,
            reorg_window,
            native_usd_price: r.native_usd_price.unwrap_or(3000.0),
            min_profit_usd: r.min_profit_usd.unwrap_or(0.0),
            force_unprofitable: r.force_unprofitable.unwrap_or(false),
            submit_jitter_ms: r.submit_jitter_ms.unwrap_or(0),
            send_raw_via: r.send_raw_via,
            exchange,
            start_block: r.start_block.unwrap_or(0),
            state_file: r.state_file.unwrap_or_else(|| PathBuf::from("keeper-state.json")),
            poll_interval_ms,
            confirmations: r.confirmations.unwrap_or(0),
            log_chunk,
            funding_interval_secs,
            enable_funding: r.enable_funding.unwrap_or(true),
            enable_liquidation: r.enable_liquidation.unwrap_or(true),
            enable_conditional: r.enable_conditional.unwrap_or(true),
            enable_twap: r.enable_twap.unwrap_or(true),
            enable_adl: r.enable_adl.unwrap_or(true),
            enable_writeoff: r.enable_writeoff.unwrap_or(true),
            enable_sync_backstop: r.enable_sync_backstop.unwrap_or(true),
            enable_poke_backstop: r.enable_poke_backstop.unwrap_or(true),
            enable_unwind_backstop: r.enable_unwind_backstop.unwrap_or(true),
            poke_backstop_max_gas_usd: r.poke_backstop_max_gas_usd.unwrap_or(0.50),
            unwind_backstop_max_gas_usd: r.unwind_backstop_max_gas_usd.unwrap_or(1.00),
            backstop_inventory_interval_secs: r.backstop_inventory_interval_secs.unwrap_or(15).max(1),
            enable_pyth_push,
            pyth,
            sync_backstop_max_gas_usd: r.sync_backstop_max_gas_usd.unwrap_or(0.50),
            sync_backstop_interval_secs: r.sync_backstop_interval_secs.unwrap_or(60).max(1),
            writeoff_max_gas_usd: r.writeoff_max_gas_usd.unwrap_or(0.50),
            dry_run: r.dry_run.unwrap_or(false),
            metrics_addr,
            tx_timeout_secs: r.tx_timeout_secs.unwrap_or(30),
            max_bump_attempts: r.max_bump_attempts.unwrap_or(4),
            gas_bump_pct: r.gas_bump_pct.unwrap_or(15).max(12),
            gas_buffer_pct: r.gas_buffer_pct.unwrap_or(25),
            max_fee_gwei: r.max_fee_gwei.unwrap_or(500),
            max_actions_per_tick: r.max_actions_per_tick.unwrap_or(20),
            private_key_env: r.private_key_env.unwrap_or_else(|| "KEEPER_PRIVATE_KEY".into()),
            keystore_path: r.keystore_path,
            keystore_password_env: r.keystore_password_env.unwrap_or_else(|| "KEEPER_KEYSTORE_PASSWORD".into()),
            log_format,
            max_ready_lag_blocks: r.max_ready_lag_blocks.unwrap_or(50),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

    fn base() -> RawConfig {
        RawConfig { rpc_url: Some("http://127.0.0.1:8545".into()), exchange: Some(ADDR.into()), ..Default::default() }
    }

    #[test]
    fn defaults_apply() {
        let c = Config::from_raw(base()).unwrap();
        assert_eq!(c.poll_interval_ms, 2000);
        assert!(c.enable_liquidation && !c.dry_run);
        assert_eq!(c.private_key_env, "KEEPER_PRIVATE_KEY");
        assert_eq!(c.log_format, LogFormat::Text);
    }

    #[test]
    fn missing_required_fields_error() {
        assert!(Config::from_raw(RawConfig::default()).is_err());
        let mut r = base();
        r.exchange = Some("nope".into());
        assert!(Config::from_raw(r).is_err());
    }

    #[test]
    fn overlay_prefers_higher_priority() {
        let cli = RawConfig { poll_interval_ms: Some(10), ..Default::default() };
        let file: RawConfig = toml::from_str(&format!("rpc_url='http://x'\nexchange='{ADDR}'\npoll_interval_ms=999\ndry_run=true\n")).unwrap();
        let c = Config::from_raw(cli.overlay(file)).unwrap();
        assert_eq!(c.poll_interval_ms, 10);
        assert!(c.dry_run);
        assert_eq!(c.rpc_urls, vec!["http://x".to_string()]);
    }

    #[test]
    fn unknown_toml_keys_rejected() {
        assert!(toml::from_str::<RawConfig>("bogus=1").is_err());
    }

    #[test]
    fn bump_floor_and_zero_checks() {
        let mut r = base();
        r.gas_bump_pct = Some(1);
        assert_eq!(Config::from_raw(r).unwrap().gas_bump_pct, 12);
        let mut r = base();
        r.poll_interval_ms = Some(0);
        assert!(Config::from_raw(r).is_err());
    }

    #[test]
    fn debug_never_contains_secret_material() {
        // config only holds env-var NAMES / paths, never values
        std::env::set_var("KEEPER_TEST_SECRET_VALUE", "0xdeadbeef");
        let mut r = base();
        r.private_key_env = Some("KEEPER_TEST_SECRET_VALUE".into());
        let c = Config::from_raw(r).unwrap();
        assert!(!format!("{c:?}").contains("deadbeef"));
    }

    #[test]
    fn debug_redacts_endpoint_urls_that_may_embed_keys() {
        let mut r = base();
        r.rpc_urls = Some(vec!["https://user:pw@rpc.example.com:8545/v2/SECRETKEY1?k=SECRETKEY2".into()]);
        r.send_raw_via = Some("https://relay.example/SECRETKEY3".into());
        let c = Config::from_raw(r).unwrap();
        let d = format!("{c:?}");
        assert!(!d.contains("SECRET") && !d.contains("pw@"), "{d}");
        assert!(d.contains("https://rpc.example.com:8545") && d.contains("https://relay.example"), "{d}");
        assert!(d.contains("poll_interval_ms"), "other fields still printed");
        // the real values are untouched
        assert!(c.rpc_urls.iter().any(|u| u.contains("SECRETKEY1")));
    }

    #[test]
    fn rpc_urls_merge_dedupe_and_order() {
        let mut r = base();
        r.rpc_urls = Some(vec!["http://b".into(), "http://127.0.0.1:8545".into(), " http://c ".into()]);
        let c = Config::from_raw(r).unwrap();
        assert_eq!(c.rpc_urls, vec!["http://127.0.0.1:8545", "http://b", "http://c"]);
        let mut only = RawConfig { exchange: Some(ADDR.into()), rpc_urls: Some(vec!["http://z".into()]), ..Default::default() };
        assert_eq!(Config::from_raw(only.clone()).unwrap().rpc_urls, vec!["http://z"]);
        only.rpc_urls = Some(vec![]);
        assert!(Config::from_raw(only).is_err());
    }

    #[test]
    fn new_option_validation_and_defaults() {
        let c = Config::from_raw(base()).unwrap();
        assert_eq!(c.multicall, MulticallMode::Auto);
        assert_eq!(c.multicall_address, crate::batch::MULTICALL3);
        assert_eq!(c.funding_interval_secs, None);
        assert_eq!(c.reorg_window, 64);
        assert!(!c.force_unprofitable && c.submit_jitter_ms == 0 && c.send_raw_via.is_none());
        for bad in [
            RawConfig { multicall: Some("maybe".into()), ..base() },
            RawConfig { multicall_chunk: Some(0), ..base() },
            RawConfig { rpc_concurrency: Some(0), ..base() },
            RawConfig { reorg_window: Some(0), ..base() },
            RawConfig { native_usd_price: Some(f64::NAN), ..base() },
            RawConfig { min_profit_usd: Some(-1.0), ..base() },
            RawConfig { funding_interval_secs: Some(0), ..base() },
            RawConfig { send_raw_via: Some("not a url".into()), ..base() },
            RawConfig { multicall_address: Some("0x12".into()), ..base() },
        ] {
            assert!(Config::from_raw(bad).is_err());
        }
    }

    #[test]
    fn config_file_loading_and_cli_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("keeper.toml");
        std::fs::write(
            &p,
            format!(
                "rpc_url='http://file-primary'\nrpc_urls=['http://file-backup']\nexchange='{ADDR}'\npoll_interval_ms=777\n\
                 log_format='json'\nmulticall='off'\nforce_unprofitable=true\nreorg_window=12\nfunding_interval_secs=9\n"
            ),
        )
        .unwrap();
        // file only
        let cli = Cli::try_parse_from(["perp-keeper", "--config", p.to_str().unwrap()]).unwrap();
        let c = Config::load(cli).unwrap();
        assert_eq!(c.rpc_urls, vec!["http://file-primary", "http://file-backup"]);
        assert_eq!(c.poll_interval_ms, 777);
        assert_eq!(c.log_format, LogFormat::Json);
        assert_eq!(c.multicall, MulticallMode::Off);
        assert!(c.force_unprofitable);
        assert_eq!((c.reorg_window, c.funding_interval_secs), (12, Some(9)));
        // CLI flags override the file
        let cli = Cli::try_parse_from(["perp-keeper", "--config", p.to_str().unwrap(), "--poll-interval-ms", "5", "--rpc-url", "http://cli", "--log-format", "text"]).unwrap();
        let c = Config::load(cli).unwrap();
        assert_eq!(c.poll_interval_ms, 5);
        assert_eq!(c.rpc_urls[0], "http://cli");
        assert_eq!(c.log_format, LogFormat::Text);
        assert_eq!(c.multicall, MulticallMode::Off, "unspecified keys still come from the file");
    }

    #[test]
    fn config_file_errors_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let missing = Cli::try_parse_from(["perp-keeper", "--config", dir.path().join("nope.toml").to_str().unwrap()]).unwrap();
        assert!(Config::load(missing).unwrap_err().to_string().contains("reading config"));
        let p = dir.path().join("bad.toml");
        std::fs::write(&p, "rpc_url = 5\nbogus_key = true\n").unwrap();
        let bad = Cli::try_parse_from(["perp-keeper", "--config", p.to_str().unwrap()]).unwrap();
        assert!(Config::load(bad).unwrap_err().to_string().contains("parsing config"));
    }

    #[test]
    fn example_toml_parses_with_and_without_the_pyth_block() {
        let txt = include_str!("../config.example.toml");
        let c = Config::from_raw(toml::from_str::<RawConfig>(txt).expect("example parses")).unwrap();
        assert!(!c.enable_pyth_push, "pusher is off in the shipped example");
        let mut on = String::new();
        let mut inside = false;
        for l in txt.lines() {
            if l.contains("# --- pyth-begin") { inside = true; continue; }
            if l.contains("# --- pyth-end") { inside = false; continue; }
            on.push_str(&if inside { l.strip_prefix("# ").unwrap_or(l).to_string() } else { l.to_string() });
            on.push('\n');
        }
        let c = Config::from_raw(toml::from_str::<RawConfig>(&on).expect("uncommented example parses")).unwrap();
        assert!(c.enable_pyth_push);
        assert_eq!(c.pyth.feeds.len(), 3);
        assert_eq!(c.pyth.feeds[0].0, "BTC");
        assert_eq!((c.pyth.push_interval_secs, c.pyth.push_when_age_secs, c.pyth.max_fee_wei, c.pyth.hourly_budget_wei), (20, 1800, 100_000_000_000_000, 5_000_000_000_000_000));
    }

    #[test]
    fn comma_separated_rpc_urls_flag() {
        let cli = Cli::try_parse_from(["perp-keeper", "--exchange", ADDR, "--rpc-urls", "http://a,http://b"]).unwrap();
        assert_eq!(Config::load(cli).unwrap().rpc_urls, vec!["http://a", "http://b"]);
    }
}
