//! Durable storage for the canonical *event log*, block hashes, read-model snapshots and the checkpoint.
//!
//! Read models are rebuilt by the pure reducer in `state.rs`: startup loads the newest snapshot at or below the
//! checkpoint and replays only the tail of the log (`Indexer::rebuild_state`); a reorg does the same from the fork
//! point. The log is keyed by `(block_number, log_index)` so re-inserting a log is a no-op (idempotent ingestion), and
//! it stores the raw topics + data next to the decoded event so decoders can be re-run (`reindex-from-raw`).
//!
//! PostgreSQL is the target (`PgStore`). `MemStore` is the same contract in memory for unit tests.

use crate::events::{pos_key, Ev, EventRecord, Meta, RawData};
use crate::state::FillRow;
use alloy_primitives::B256;
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockRef {
    pub number: u64,
    pub hash: B256,
    pub parent_hash: B256,
    pub ts: u64,
}

/// A persisted read-model snapshot: the reducer state after applying every event of blocks `<= block`.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub block: u64,
    pub block_hash: B256,
    pub state: String,
}

/// Fill lookup against the persisted log (for history older than the in-memory window).
/// Matches fills with `lo_excl < key <= hi_incl`, optionally filtered by market and by account (maker or taker).
#[derive(Clone, Debug, Default)]
pub struct FillQuery {
    pub market: Option<u8>,
    pub acct: Option<B256>,
    pub lo_excl: Option<u128>,
    pub hi_incl: Option<u128>,
    pub limit: usize,
    pub desc: bool,
}

#[derive(Clone, Debug)]
pub struct ApiKeyRec {
    pub id: String,
    /// keccak256 of the full key string (the key itself is never stored)
    pub hash: String,
    pub label: String,
    pub rps: Option<f64>,
    pub burst: Option<f64>,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
}

/// Receipt-based status of a transaction submitted through `/v1/tx/track`. Reverted transactions emit no contract
/// events, so this is the only place they can show up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackedTx {
    pub tx_hash: B256,
    /// pending | success | reverted | dropped
    pub status: String,
    pub submitted_at: i64,
    pub checked_at: Option<i64>,
    pub block_number: Option<u64>,
    pub block_hash: Option<B256>,
    pub gas_used: Option<u64>,
}

#[async_trait]
pub trait EventStore: Send + Sync {
    /// Create schema; pin the DB to (chain id, exchange address). Refuses a mismatching existing DB.
    async fn init(&self, chain_id: u64, exchange: &str) -> anyhow::Result<()>;
    /// Highest block recorded (the checkpoint).
    async fn tip(&self) -> anyhow::Result<Option<BlockRef>>;
    /// Most recent `limit` blocks, newest first.
    async fn recent_blocks(&self, limit: usize) -> anyhow::Result<Vec<BlockRef>>;
    /// Up to `limit` stored blocks with number `< number`, newest first (walks the hash chain beyond any window).
    async fn blocks_before(&self, number: u64, limit: usize) -> anyhow::Result<Vec<BlockRef>>;
    /// Lowest stored block.
    async fn oldest_block(&self) -> anyhow::Result<Option<BlockRef>>;
    /// Atomically record a block (hash chain + checkpoint) and its events. Duplicate event keys are ignored.
    /// Returns the number of newly inserted events.
    async fn commit_block(&self, blk: &BlockRef, events: &[EventRecord]) -> anyhow::Result<usize>;
    /// Delete every block, event and snapshot after `number` (`None` = delete everything). Returns removed event count.
    async fn rollback_after(&self, number: Option<u64>) -> anyhow::Result<u64>;
    /// Events with key > `after` in ascending order (without raw payloads).
    async fn load_events(&self, after: Option<u128>, limit: usize) -> anyhow::Result<Vec<EventRecord>>;
    /// Like `load_events` but includes the stored raw topics/data (None for rows that predate raw storage).
    async fn load_events_raw(&self, after: Option<u128>, limit: usize) -> anyhow::Result<Vec<EventRecord>>;
    /// Overwrite the decoded form (`ev`, `name`) of already stored events, keyed by `(block, log_index)`.
    async fn update_decoded(&self, recs: &[EventRecord]) -> anyhow::Result<u64>;
    /// Drop block-hash rows older than `keep_from` (events are kept forever).
    async fn prune_blocks(&self, keep_from: u64) -> anyhow::Result<()>;

    async fn save_snapshot(&self, snap: &Snapshot) -> anyhow::Result<()>;
    /// Newest snapshot whose block is `<= block`.
    async fn latest_snapshot(&self, block: u64) -> anyhow::Result<Option<Snapshot>>;
    /// Keep only the newest `keep` snapshots.
    async fn prune_snapshots(&self, keep: usize) -> anyhow::Result<()>;
    async fn clear_snapshots(&self) -> anyhow::Result<()>;

    /// Fills from the persisted log (see [`FillQuery`]); `taker_order_id` is derived exactly as the reducer does.
    async fn fills_page(&self, q: &FillQuery) -> anyhow::Result<Vec<FillRow>>;

    async fn create_api_key(&self, rec: &ApiKeyRec) -> anyhow::Result<()>;
    /// Returns true if a live key with this id existed.
    async fn revoke_api_key(&self, id: &str, now: i64) -> anyhow::Result<bool>;
    async fn list_api_keys(&self) -> anyhow::Result<Vec<ApiKeyRec>>;

    /// Register a tx hash for receipt tracking. Returns Ok(false) if it was already tracked, Err if over `max_pending`.
    async fn track_tx(&self, hash: B256, now: i64, max_pending: usize) -> anyhow::Result<bool>;
    async fn get_tracked_tx(&self, hash: B256) -> anyhow::Result<Option<TrackedTx>>;
    /// Txs that need (re-)checking: pending ones and confirmed ones whose block is `>= recheck_from`.
    async fn txs_to_check(&self, recheck_from: u64, limit: usize) -> anyhow::Result<Vec<TrackedTx>>;
    async fn update_tracked_tx(&self, tx: &TrackedTx) -> anyhow::Result<()>;
}

/// `taker_order_id` for each Fill in `events` (sorted by key): the latest `OrderAccepted` of the same tx before the
/// fill, kept only if it belongs to the taker in the fill's market (the reducer's `last_taker` rule).
pub fn taker_order_for(accepted: Option<&Ev>, taker: &B256, market: u8) -> Option<u64> {
    match accepted {
        Some(Ev::OrderAccepted { id, acct, market: m, .. }) if acct == taker && *m == market => Some(*id),
        _ => None,
    }
}

// ------------------------------------------------------------------------------------------------ memory

#[derive(Default)]
pub struct MemStore {
    inner: Mutex<MemInner>,
    /// Total events handed out by `load_events*` (tests assert replay is bounded).
    pub loaded_events: AtomicU64,
}
#[derive(Default)]
struct MemInner {
    blocks: BTreeMap<u64, BlockRef>,
    events: BTreeMap<u128, EventRecord>,
    snapshots: BTreeMap<u64, Snapshot>,
    keys: Vec<ApiKeyRec>,
    txs: BTreeMap<B256, TrackedTx>,
}

impl MemStore {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn event_count(&self) -> usize {
        self.inner.lock().unwrap().events.len()
    }
    pub fn snapshot_blocks(&self) -> Vec<u64> {
        self.inner.lock().unwrap().snapshots.keys().copied().collect()
    }
}

#[async_trait]
impl EventStore for MemStore {
    async fn init(&self, _chain_id: u64, _exchange: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn tip(&self) -> anyhow::Result<Option<BlockRef>> {
        Ok(self.inner.lock().unwrap().blocks.values().next_back().cloned())
    }
    async fn recent_blocks(&self, limit: usize) -> anyhow::Result<Vec<BlockRef>> {
        Ok(self.inner.lock().unwrap().blocks.values().rev().take(limit).cloned().collect())
    }
    async fn blocks_before(&self, number: u64, limit: usize) -> anyhow::Result<Vec<BlockRef>> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .blocks
            .range(..number)
            .rev()
            .take(limit)
            .map(|(_, b)| b.clone())
            .collect())
    }
    async fn oldest_block(&self) -> anyhow::Result<Option<BlockRef>> {
        Ok(self.inner.lock().unwrap().blocks.values().next().cloned())
    }
    async fn commit_block(&self, blk: &BlockRef, events: &[EventRecord]) -> anyhow::Result<usize> {
        let mut g = self.inner.lock().unwrap();
        g.blocks.insert(blk.number, blk.clone());
        let mut n = 0;
        for e in events {
            if g.events.insert(e.meta.key(), e.clone()).is_none() {
                n += 1;
            }
        }
        Ok(n)
    }
    async fn rollback_after(&self, number: Option<u64>) -> anyhow::Result<u64> {
        let mut g = self.inner.lock().unwrap();
        let cut = number.map(|n| pos_key(n + 1, 0)).unwrap_or(0);
        g.blocks.retain(|n, _| number.is_some_and(|k| *n <= k));
        g.snapshots.retain(|n, _| number.is_some_and(|k| *n <= k));
        let before = g.events.len();
        g.events.retain(|k, _| *k < cut);
        Ok((before - g.events.len()) as u64)
    }
    async fn load_events(&self, after: Option<u128>, limit: usize) -> anyhow::Result<Vec<EventRecord>> {
        let mut v = self.load_events_raw(after, limit).await?;
        for r in &mut v {
            r.raw = None;
        }
        Ok(v)
    }
    async fn load_events_raw(&self, after: Option<u128>, limit: usize) -> anyhow::Result<Vec<EventRecord>> {
        let g = self.inner.lock().unwrap();
        let it: Box<dyn Iterator<Item = &EventRecord>> = match after {
            Some(a) => Box::new(g.events.range((a + 1)..).map(|(_, v)| v)),
            None => Box::new(g.events.values()),
        };
        let v: Vec<EventRecord> = it.take(limit).cloned().collect();
        self.loaded_events.fetch_add(v.len() as u64, Ordering::Relaxed);
        Ok(v)
    }
    async fn update_decoded(&self, recs: &[EventRecord]) -> anyhow::Result<u64> {
        let mut g = self.inner.lock().unwrap();
        let mut n = 0;
        for r in recs {
            if let Some(e) = g.events.get_mut(&r.meta.key()) {
                e.ev = r.ev.clone();
                n += 1;
            }
        }
        Ok(n)
    }
    async fn prune_blocks(&self, keep_from: u64) -> anyhow::Result<()> {
        self.inner.lock().unwrap().blocks.retain(|n, _| *n >= keep_from);
        Ok(())
    }
    async fn save_snapshot(&self, snap: &Snapshot) -> anyhow::Result<()> {
        self.inner.lock().unwrap().snapshots.insert(snap.block, snap.clone());
        Ok(())
    }
    async fn latest_snapshot(&self, block: u64) -> anyhow::Result<Option<Snapshot>> {
        Ok(self.inner.lock().unwrap().snapshots.range(..=block).next_back().map(|(_, s)| s.clone()))
    }
    async fn prune_snapshots(&self, keep: usize) -> anyhow::Result<()> {
        let mut g = self.inner.lock().unwrap();
        while g.snapshots.len() > keep {
            let first = *g.snapshots.keys().next().unwrap();
            g.snapshots.remove(&first);
        }
        Ok(())
    }
    async fn clear_snapshots(&self) -> anyhow::Result<()> {
        self.inner.lock().unwrap().snapshots.clear();
        Ok(())
    }
    async fn fills_page(&self, q: &FillQuery) -> anyhow::Result<Vec<FillRow>> {
        let g = self.inner.lock().unwrap();
        let mut out = Vec::new();
        let mut accepted: Option<(B256, Ev)> = None; // latest OrderAccepted of the current tx
        let mut rows = Vec::new();
        for (k, r) in g.events.iter() {
            if let Ev::OrderAccepted { .. } = &r.ev {
                accepted = Some((r.meta.tx_hash, r.ev.clone()));
            }
            if let Ev::Fill { market, maker, taker, .. } = &r.ev {
                let in_range = q.lo_excl.is_none_or(|l| *k > l) && q.hi_incl.is_none_or(|h| *k <= h);
                let sel = q.market.is_none_or(|m| m == *market) && q.acct.is_none_or(|a| a == *maker || a == *taker);
                if in_range && sel {
                    let acc = accepted.as_ref().filter(|(t, _)| *t == r.meta.tx_hash).map(|(_, e)| e);
                    let tid = taker_order_for(acc, taker, *market);
                    rows.push(FillRow::from_event(&r.meta, &r.ev, tid).expect("fill"));
                }
            }
        }
        if q.desc {
            rows.reverse();
        }
        out.extend(rows.into_iter().take(q.limit));
        Ok(out)
    }
    async fn create_api_key(&self, rec: &ApiKeyRec) -> anyhow::Result<()> {
        self.inner.lock().unwrap().keys.push(rec.clone());
        Ok(())
    }
    async fn revoke_api_key(&self, id: &str, now: i64) -> anyhow::Result<bool> {
        let mut g = self.inner.lock().unwrap();
        match g.keys.iter_mut().find(|k| k.id == id && k.revoked_at.is_none()) {
            Some(k) => {
                k.revoked_at = Some(now);
                Ok(true)
            }
            None => Ok(false),
        }
    }
    async fn list_api_keys(&self) -> anyhow::Result<Vec<ApiKeyRec>> {
        Ok(self.inner.lock().unwrap().keys.clone())
    }
    async fn track_tx(&self, hash: B256, now: i64, max_pending: usize) -> anyhow::Result<bool> {
        let mut g = self.inner.lock().unwrap();
        if g.txs.contains_key(&hash) {
            return Ok(false);
        }
        if g.txs.values().filter(|t| t.status == "pending").count() >= max_pending {
            anyhow::bail!("too many pending tracked transactions");
        }
        g.txs.insert(
            hash,
            TrackedTx {
                tx_hash: hash,
                status: "pending".into(),
                submitted_at: now,
                checked_at: None,
                block_number: None,
                block_hash: None,
                gas_used: None,
            },
        );
        Ok(true)
    }
    async fn get_tracked_tx(&self, hash: B256) -> anyhow::Result<Option<TrackedTx>> {
        Ok(self.inner.lock().unwrap().txs.get(&hash).cloned())
    }
    async fn txs_to_check(&self, recheck_from: u64, limit: usize) -> anyhow::Result<Vec<TrackedTx>> {
        let g = self.inner.lock().unwrap();
        Ok(g.txs
            .values()
            .filter(|t| t.status == "pending" || t.block_number.is_some_and(|b| b >= recheck_from))
            .take(limit)
            .cloned()
            .collect())
    }
    async fn update_tracked_tx(&self, tx: &TrackedTx) -> anyhow::Result<()> {
        self.inner.lock().unwrap().txs.insert(tx.tx_hash, tx.clone());
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------------ postgres

pub struct PgStore {
    client: tokio::sync::Mutex<tokio_postgres::Client>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS indexer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (
    number      BIGINT PRIMARY KEY,
    hash        TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    ts          BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    block_number BIGINT NOT NULL,
    log_index    INT    NOT NULL,
    tx_hash      TEXT   NOT NULL,
    block_hash   TEXT   NOT NULL,
    ts           BIGINT NOT NULL,
    name         TEXT   NOT NULL,
    ev           JSONB  NOT NULL,
    raw_topics   TEXT[],
    raw_data     BYTEA,
    PRIMARY KEY (block_number, log_index)
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS raw_topics TEXT[];
ALTER TABLE events ADD COLUMN IF NOT EXISTS raw_data BYTEA;
CREATE INDEX IF NOT EXISTS events_name_idx ON events (name);
CREATE INDEX IF NOT EXISTS events_fill_market_idx ON events ((ev->'Fill'->>'market'), block_number, log_index) WHERE name = 'Fill';
CREATE INDEX IF NOT EXISTS events_fill_maker_idx ON events ((ev->'Fill'->>'maker'), block_number, log_index) WHERE name = 'Fill';
CREATE INDEX IF NOT EXISTS events_fill_taker_idx ON events ((ev->'Fill'->>'taker'), block_number, log_index) WHERE name = 'Fill';
CREATE TABLE IF NOT EXISTS snapshots (
    block_number BIGINT PRIMARY KEY,
    block_hash   TEXT NOT NULL,
    state        TEXT NOT NULL,
    created_at   BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
    id         TEXT PRIMARY KEY,
    key_hash   TEXT NOT NULL,
    label      TEXT NOT NULL,
    rps        DOUBLE PRECISION,
    burst      DOUBLE PRECISION,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT
);
CREATE TABLE IF NOT EXISTS tracked_txs (
    tx_hash      TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    submitted_at BIGINT NOT NULL,
    checked_at   BIGINT,
    block_number BIGINT,
    block_hash   TEXT,
    gas_used     BIGINT
);
"#;

impl PgStore {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        Self::connect_schema(url, None).await
    }

    /// Connect, optionally confining every table to `schema` (created if missing). Used by tests so several
    /// independent stores can share one database.
    pub async fn connect_schema(url: &str, schema: Option<&str>) -> anyhow::Result<Self> {
        let (client, conn) = tokio_postgres::connect(url, tokio_postgres::NoTls).await?;
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::error!(error = %e, "postgres connection closed");
            }
        });
        if let Some(sc) = schema {
            anyhow::ensure!(sc.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "bad schema name");
            client
                .batch_execute(&format!("CREATE SCHEMA IF NOT EXISTS {sc}; SET search_path TO {sc}"))
                .await?;
        }
        Ok(Self {
            client: tokio::sync::Mutex::new(client),
        })
    }

    /// Drop all derived indexer tables (events, blocks, snapshots, pin). API keys and tracked txs are kept.
    pub async fn wipe(&self) -> anyhow::Result<()> {
        let c = self.client.lock().await;
        c.batch_execute("DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS snapshots; DROP TABLE IF EXISTS indexer_meta;")
            .await?;
        Ok(())
    }

    /// Create the schema without pinning a chain (CLI subcommands that only touch keys / raw logs).
    pub async fn ensure_schema(&self) -> anyhow::Result<()> {
        self.client.lock().await.batch_execute(SCHEMA).await?;
        Ok(())
    }

    /// The `(chain id, exchange)` this database is pinned to, if any.
    pub async fn pinned(&self) -> anyhow::Result<Option<String>> {
        let c = self.client.lock().await;
        Ok(c.query_opt("SELECT value FROM indexer_meta WHERE key='chain'", &[]).await?.map(|r| r.get(0)))
    }
}

fn row_to_block(r: &tokio_postgres::Row) -> anyhow::Result<BlockRef> {
    let n: i64 = r.get(0);
    let h: String = r.get(1);
    let p: String = r.get(2);
    let ts: i64 = r.get(3);
    Ok(BlockRef {
        number: n as u64,
        hash: h.parse()?,
        parent_hash: p.parse()?,
        ts: ts as u64,
    })
}

fn row_to_tx(r: &tokio_postgres::Row) -> anyhow::Result<TrackedTx> {
    let h: String = r.get(0);
    let bn: Option<i64> = r.get(4);
    let bh: Option<String> = r.get(5);
    let gu: Option<i64> = r.get(6);
    Ok(TrackedTx {
        tx_hash: h.parse()?,
        status: r.get(1),
        submitted_at: r.get(2),
        checked_at: r.get(3),
        block_number: bn.map(|x| x as u64),
        block_hash: bh.map(|x| x.parse()).transpose()?,
        gas_used: gu.map(|x| x as u64),
    })
}

fn row_to_event(r: &tokio_postgres::Row, with_raw: bool) -> anyhow::Result<EventRecord> {
    let bn: i64 = r.get(0);
    let li: i32 = r.get(1);
    let th: String = r.get(2);
    let bh: String = r.get(3);
    let ts: i64 = r.get(4);
    let ev: serde_json::Value = r.get(5);
    let ev: Ev = serde_json::from_value(ev)?;
    let raw = if with_raw {
        let topics: Option<Vec<String>> = r.get(6);
        let data: Option<Vec<u8>> = r.get(7);
        match (topics, data) {
            (Some(t), Some(d)) => Some(RawData {
                topics: t.iter().map(|x| x.parse()).collect::<Result<Vec<B256>, _>>()?,
                data: d,
            }),
            _ => None,
        }
    } else {
        None
    };
    Ok(EventRecord {
        meta: Meta {
            block: bn as u64,
            log_index: li as u32,
            tx_hash: th.parse()?,
            block_hash: bh.parse()?,
            ts: ts as u64,
        },
        ev,
        raw,
    })
}

fn split_key(after: Option<u128>) -> (i64, i32) {
    match after {
        // log_index is an INT column: clamp the "end of block" sentinel (u32::MAX) into i32 range
        Some(a) => ((a >> 32) as i64, (a & 0xffff_ffff).min(i32::MAX as u128) as i32),
        None => (-1i64, -1i32),
    }
}

#[async_trait]
impl EventStore for PgStore {
    async fn init(&self, chain_id: u64, exchange: &str) -> anyhow::Result<()> {
        let c = self.client.lock().await;
        c.batch_execute(SCHEMA).await?;
        let want = format!("{chain_id}:{}", exchange.to_lowercase());
        let row = c.query_opt("SELECT value FROM indexer_meta WHERE key='chain'", &[]).await?;
        match row {
            Some(r) => {
                let have: String = r.get(0);
                if have != want {
                    anyhow::bail!("database belongs to chain/exchange {have}, refusing to index {want} (use a fresh database or --wipe)");
                }
            }
            None => {
                c.execute("INSERT INTO indexer_meta(key,value) VALUES('chain',$1)", &[&want]).await?;
            }
        }
        Ok(())
    }

    async fn tip(&self) -> anyhow::Result<Option<BlockRef>> {
        let c = self.client.lock().await;
        let r = c
            .query_opt("SELECT number,hash,parent_hash,ts FROM blocks ORDER BY number DESC LIMIT 1", &[])
            .await?;
        r.as_ref().map(row_to_block).transpose()
    }

    async fn recent_blocks(&self, limit: usize) -> anyhow::Result<Vec<BlockRef>> {
        let c = self.client.lock().await;
        let rows = c
            .query(
                "SELECT number,hash,parent_hash,ts FROM blocks ORDER BY number DESC LIMIT $1",
                &[&(limit as i64)],
            )
            .await?;
        rows.iter().map(row_to_block).collect()
    }

    async fn blocks_before(&self, number: u64, limit: usize) -> anyhow::Result<Vec<BlockRef>> {
        let c = self.client.lock().await;
        let rows = c
            .query(
                "SELECT number,hash,parent_hash,ts FROM blocks WHERE number < $1 ORDER BY number DESC LIMIT $2",
                &[&(number as i64), &(limit as i64)],
            )
            .await?;
        rows.iter().map(row_to_block).collect()
    }

    async fn oldest_block(&self) -> anyhow::Result<Option<BlockRef>> {
        let c = self.client.lock().await;
        let r = c
            .query_opt("SELECT number,hash,parent_hash,ts FROM blocks ORDER BY number ASC LIMIT 1", &[])
            .await?;
        r.as_ref().map(row_to_block).transpose()
    }

    async fn commit_block(&self, blk: &BlockRef, events: &[EventRecord]) -> anyhow::Result<usize> {
        let mut c = self.client.lock().await;
        let tx = c.transaction().await?;
        tx.execute(
            "INSERT INTO blocks(number,hash,parent_hash,ts) VALUES($1,$2,$3,$4)
             ON CONFLICT (number) DO UPDATE SET hash=EXCLUDED.hash, parent_hash=EXCLUDED.parent_hash, ts=EXCLUDED.ts",
            &[&(blk.number as i64), &blk.hash.to_string(), &blk.parent_hash.to_string(), &(blk.ts as i64)],
        )
        .await?;
        let mut n = 0usize;
        for e in events {
            let j = serde_json::to_value(&e.ev)?;
            let topics: Option<Vec<String>> = e.raw.as_ref().map(|r| r.topics.iter().map(|t| t.to_string()).collect());
            let data: Option<&Vec<u8>> = e.raw.as_ref().map(|r| &r.data);
            let k = tx
                .execute(
                    "INSERT INTO events(block_number,log_index,tx_hash,block_hash,ts,name,ev,raw_topics,raw_data)
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                     ON CONFLICT (block_number, log_index) DO NOTHING",
                    &[
                        &(e.meta.block as i64),
                        &(e.meta.log_index as i32),
                        &e.meta.tx_hash.to_string(),
                        &e.meta.block_hash.to_string(),
                        &(e.meta.ts as i64),
                        &e.ev.name(),
                        &j,
                        &topics,
                        &data,
                    ],
                )
                .await?;
            n += k as usize;
        }
        tx.commit().await?;
        Ok(n)
    }

    async fn rollback_after(&self, number: Option<u64>) -> anyhow::Result<u64> {
        let keep = number.map(|n| n as i64).unwrap_or(-1);
        let mut c = self.client.lock().await;
        let tx = c.transaction().await?;
        let n = tx.execute("DELETE FROM events WHERE block_number > $1", &[&keep]).await?;
        tx.execute("DELETE FROM blocks WHERE number > $1", &[&keep]).await?;
        tx.execute("DELETE FROM snapshots WHERE block_number > $1", &[&keep]).await?;
        tx.commit().await?;
        Ok(n)
    }

    async fn load_events(&self, after: Option<u128>, limit: usize) -> anyhow::Result<Vec<EventRecord>> {
        let c = self.client.lock().await;
        let (b, l) = split_key(after);
        let rows = c
            .query(
                "SELECT block_number,log_index,tx_hash,block_hash,ts,ev FROM events
                 WHERE (block_number, log_index) > ($1,$2) ORDER BY block_number, log_index LIMIT $3",
                &[&b, &l, &(limit as i64)],
            )
            .await?;
        rows.iter().map(|r| row_to_event(r, false)).collect()
    }

    async fn load_events_raw(&self, after: Option<u128>, limit: usize) -> anyhow::Result<Vec<EventRecord>> {
        let c = self.client.lock().await;
        let (b, l) = split_key(after);
        let rows = c
            .query(
                "SELECT block_number,log_index,tx_hash,block_hash,ts,ev,raw_topics,raw_data FROM events
                 WHERE (block_number, log_index) > ($1,$2) ORDER BY block_number, log_index LIMIT $3",
                &[&b, &l, &(limit as i64)],
            )
            .await?;
        rows.iter().map(|r| row_to_event(r, true)).collect()
    }

    async fn update_decoded(&self, recs: &[EventRecord]) -> anyhow::Result<u64> {
        let mut c = self.client.lock().await;
        let tx = c.transaction().await?;
        let mut n = 0;
        for r in recs {
            let j = serde_json::to_value(&r.ev)?;
            n += tx
                .execute(
                    "UPDATE events SET ev=$3, name=$4 WHERE block_number=$1 AND log_index=$2",
                    &[&(r.meta.block as i64), &(r.meta.log_index as i32), &j, &r.ev.name()],
                )
                .await?;
        }
        tx.commit().await?;
        Ok(n)
    }

    async fn prune_blocks(&self, keep_from: u64) -> anyhow::Result<()> {
        let c = self.client.lock().await;
        c.execute("DELETE FROM blocks WHERE number < $1", &[&(keep_from as i64)]).await?;
        Ok(())
    }

    async fn save_snapshot(&self, snap: &Snapshot) -> anyhow::Result<()> {
        let c = self.client.lock().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        c.execute(
            "INSERT INTO snapshots(block_number,block_hash,state,created_at) VALUES($1,$2,$3,$4)
             ON CONFLICT (block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash, state=EXCLUDED.state, created_at=EXCLUDED.created_at",
            &[&(snap.block as i64), &snap.block_hash.to_string(), &snap.state, &now],
        )
        .await?;
        Ok(())
    }

    async fn latest_snapshot(&self, block: u64) -> anyhow::Result<Option<Snapshot>> {
        let c = self.client.lock().await;
        let r = c
            .query_opt(
                "SELECT block_number,block_hash,state FROM snapshots WHERE block_number <= $1 ORDER BY block_number DESC LIMIT 1",
                &[&(block as i64)],
            )
            .await?;
        r.map(|r| {
            let n: i64 = r.get(0);
            let h: String = r.get(1);
            Ok(Snapshot {
                block: n as u64,
                block_hash: h.parse()?,
                state: r.get(2),
            })
        })
        .transpose()
    }

    async fn prune_snapshots(&self, keep: usize) -> anyhow::Result<()> {
        let c = self.client.lock().await;
        c.execute(
            "DELETE FROM snapshots WHERE block_number NOT IN (SELECT block_number FROM snapshots ORDER BY block_number DESC LIMIT $1)",
            &[&(keep as i64)],
        )
        .await?;
        Ok(())
    }

    async fn clear_snapshots(&self) -> anyhow::Result<()> {
        self.client.lock().await.execute("DELETE FROM snapshots", &[]).await?;
        Ok(())
    }

    async fn fills_page(&self, q: &FillQuery) -> anyhow::Result<Vec<FillRow>> {
        let c = self.client.lock().await;
        let (lb, ll) = split_key(q.lo_excl);
        let (hb, hl) = match q.hi_incl {
            Some(h) => ((h >> 32) as i64, (h & 0xffff_ffff).min(i32::MAX as u128) as i32),
            None => (i64::MAX, i32::MAX),
        };
        let mut sql = String::from(
            "SELECT f.block_number,f.log_index,f.tx_hash,f.block_hash,f.ts,f.ev,
               (SELECT a.ev FROM events a WHERE a.block_number=f.block_number AND a.tx_hash=f.tx_hash
                  AND a.name='OrderAccepted' AND a.log_index<f.log_index ORDER BY a.log_index DESC LIMIT 1)
             FROM events f WHERE f.name='Fill' AND (f.block_number,f.log_index) > ($1,$2) AND (f.block_number,f.log_index) <= ($3,$4)",
        );
        let mut params: Vec<Box<dyn tokio_postgres::types::ToSql + Sync + Send>> = vec![Box::new(lb), Box::new(ll), Box::new(hb), Box::new(hl)];
        if let Some(m) = q.market {
            params.push(Box::new(m.to_string()));
            sql.push_str(&format!(" AND f.ev->'Fill'->>'market' = ${}", params.len()));
        }
        if let Some(a) = q.acct {
            params.push(Box::new(a.to_string()));
            let n = params.len();
            sql.push_str(&format!(" AND (f.ev->'Fill'->>'maker' = ${n} OR f.ev->'Fill'->>'taker' = ${n})"));
        }
        let dir = if q.desc { "DESC" } else { "ASC" };
        params.push(Box::new(q.limit as i64));
        sql.push_str(&format!(" ORDER BY f.block_number {dir}, f.log_index {dir} LIMIT ${}", params.len()));
        let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|p| &**p as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
        let rows = c.query(&sql, &refs).await?;
        rows.iter()
            .map(|r| {
                let rec = row_to_event(r, false)?;
                let acc: Option<serde_json::Value> = r.get(6);
                let acc: Option<Ev> = acc.map(serde_json::from_value).transpose()?;
                let Ev::Fill { market, taker, .. } = &rec.ev else {
                    anyhow::bail!("non-fill row");
                };
                let tid = taker_order_for(acc.as_ref(), taker, *market);
                FillRow::from_event(&rec.meta, &rec.ev, tid).ok_or_else(|| anyhow::anyhow!("not a fill"))
            })
            .collect()
    }

    async fn create_api_key(&self, rec: &ApiKeyRec) -> anyhow::Result<()> {
        let c = self.client.lock().await;
        c.execute(
            "INSERT INTO api_keys(id,key_hash,label,rps,burst,created_at) VALUES($1,$2,$3,$4,$5,$6)",
            &[&rec.id, &rec.hash, &rec.label, &rec.rps, &rec.burst, &rec.created_at],
        )
        .await?;
        Ok(())
    }

    async fn revoke_api_key(&self, id: &str, now: i64) -> anyhow::Result<bool> {
        let c = self.client.lock().await;
        Ok(c.execute("UPDATE api_keys SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL", &[&id, &now])
            .await?
            > 0)
    }

    async fn list_api_keys(&self) -> anyhow::Result<Vec<ApiKeyRec>> {
        let c = self.client.lock().await;
        let rows = c
            .query(
                "SELECT id,key_hash,label,rps,burst,created_at,revoked_at FROM api_keys ORDER BY created_at, id",
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| ApiKeyRec {
                id: r.get(0),
                hash: r.get(1),
                label: r.get(2),
                rps: r.get(3),
                burst: r.get(4),
                created_at: r.get(5),
                revoked_at: r.get(6),
            })
            .collect())
    }

    async fn track_tx(&self, hash: B256, now: i64, max_pending: usize) -> anyhow::Result<bool> {
        let c = self.client.lock().await;
        let pending: i64 = c.query_one("SELECT count(*) FROM tracked_txs WHERE status='pending'", &[]).await?.get(0);
        if pending as usize >= max_pending {
            anyhow::bail!("too many pending tracked transactions");
        }
        let n = c
            .execute(
                "INSERT INTO tracked_txs(tx_hash,status,submitted_at) VALUES($1,'pending',$2) ON CONFLICT (tx_hash) DO NOTHING",
                &[&hash.to_string(), &now],
            )
            .await?;
        Ok(n > 0)
    }

    async fn get_tracked_tx(&self, hash: B256) -> anyhow::Result<Option<TrackedTx>> {
        let c = self.client.lock().await;
        let r = c
            .query_opt(
                "SELECT tx_hash,status,submitted_at,checked_at,block_number,block_hash,gas_used FROM tracked_txs WHERE tx_hash=$1",
                &[&hash.to_string()],
            )
            .await?;
        r.as_ref().map(row_to_tx).transpose()
    }

    async fn txs_to_check(&self, recheck_from: u64, limit: usize) -> anyhow::Result<Vec<TrackedTx>> {
        let c = self.client.lock().await;
        let rows = c
            .query(
                "SELECT tx_hash,status,submitted_at,checked_at,block_number,block_hash,gas_used FROM tracked_txs
                 WHERE status='pending' OR block_number >= $1 ORDER BY submitted_at LIMIT $2",
                &[&(recheck_from as i64), &(limit as i64)],
            )
            .await?;
        rows.iter().map(row_to_tx).collect()
    }

    async fn update_tracked_tx(&self, tx: &TrackedTx) -> anyhow::Result<()> {
        let c = self.client.lock().await;
        c.execute(
            "UPDATE tracked_txs SET status=$2, checked_at=$3, block_number=$4, block_hash=$5, gas_used=$6 WHERE tx_hash=$1",
            &[
                &tx.tx_hash.to_string(),
                &tx.status,
                &tx.checked_at,
                &tx.block_number.map(|x| x as i64),
                &tx.block_hash.map(|x| x.to_string()),
                &tx.gas_used.map(|x| x as i64),
            ],
        )
        .await?;
        Ok(())
    }
}
