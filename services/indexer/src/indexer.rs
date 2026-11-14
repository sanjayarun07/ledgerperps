//! Chain ingestion: ordered, checkpointed, idempotent, reorg-aware.
//!
//! Loop (`step`):
//!  1. verify the stored tip is still canonical (hash compare); if not, walk the stored hash chain back (page by
//!     page, *beyond* `reorg_window` if necessary) to the common ancestor, delete derived rows after it and rebuild
//!     the read models from the newest snapshot at or below the ancestor plus the surviving log tail;
//!  2. fetch headers (JSON-RPC batched, concurrently, prefetched for backfill) for the next batch, checking
//!     `parentHash` linkage against the stored chain;
//!  3. fetch + decode logs for the batch, commit each block atomically (hash + events + raw logs), apply to the read
//!     model, publish websocket deltas and persist a snapshot every `snapshot_every` blocks.

use crate::events::{pos_key, Decoder, EventRecord, RawLog};
use crate::rpc::{parse_qty, Rpc};
use crate::shared::{Metrics, Shared};
use crate::state::{MarketMeta, State};
use crate::store::{BlockRef, EventStore, Snapshot};
use alloy_dyn_abi::{DynSolValue, FunctionExt, JsonAbiExt};
use alloy_json_abi::JsonAbi;
use alloy_primitives::{B256, U256};
use anyhow::{anyhow, bail, Context};
use async_trait::async_trait;
use futures_util::stream::{self, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// Minimal receipt facts used by the opt-in transaction tracker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptInfo {
    pub success: bool,
    pub block_number: u64,
    pub block_hash: B256,
    pub gas_used: u64,
}

#[async_trait]
pub trait ChainSource: Send + Sync {
    async fn head(&self) -> anyhow::Result<u64>;
    async fn header(&self, n: u64) -> anyhow::Result<Option<BlockRef>>;
    /// Headers for an arbitrary list of block numbers (same order; `None` = unknown to the node).
    /// Implementations should batch; the default issues one call per block.
    async fn header_list(&self, nums: &[u64]) -> anyhow::Result<Vec<Option<BlockRef>>> {
        let mut out = Vec::with_capacity(nums.len());
        for n in nums {
            out.push(self.header(*n).await?);
        }
        Ok(out)
    }
    /// Contiguous headers `from..=to`, stopping at the first block the node does not know yet.
    async fn headers(&self, from: u64, to: u64) -> anyhow::Result<Vec<BlockRef>> {
        let nums: Vec<u64> = (from..=to).collect();
        let mut out = Vec::new();
        for h in self.header_list(&nums).await? {
            match h {
                Some(h) => out.push(h),
                None => break,
            }
        }
        Ok(out)
    }
    /// Decoded events for blocks `from..=to`, ordered by (block, log_index). `ts` maps block number -> timestamp.
    async fn events(&self, from: u64, to: u64, ts: &HashMap<u64, u64>) -> anyhow::Result<Vec<EventRecord>>;
    /// The RPC node's own finalized tag, when it has one (best effort).
    async fn rpc_finalized(&self) -> Option<u64>;
    /// Transaction receipt (for the opt-in `/v1/tx/track` tracker). Default: unsupported.
    async fn receipt(&self, _tx: B256) -> anyhow::Result<Option<ReceiptInfo>> {
        Ok(None)
    }
}

pub struct RpcChain {
    pub rpc: Rpc,
    pub exchange: String,
    pub decoder: Decoder,
    /// blocks per JSON-RPC batch request (<= 1: plain one-call-per-block requests)
    pub batch_size: usize,
    /// concurrent batch requests in flight
    pub concurrency: usize,
}

impl RpcChain {
    pub fn new(rpc: Rpc, exchange: String, decoder: Decoder) -> Self {
        Self {
            rpc,
            exchange,
            decoder,
            batch_size: 50,
            concurrency: 4,
        }
    }
}

fn parse_header(v: &serde_json::Value) -> anyhow::Result<BlockRef> {
    let q = |k: &str| -> anyhow::Result<u64> {
        let s = v.get(k).and_then(|x| x.as_str()).ok_or_else(|| anyhow!("header missing {k}"))?;
        Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
    };
    let h =
        |k: &str| -> anyhow::Result<alloy_primitives::B256> { Ok(v.get(k).and_then(|x| x.as_str()).ok_or_else(|| anyhow!("header missing {k}"))?.parse()?) };
    Ok(BlockRef {
        number: q("number")?,
        hash: h("hash")?,
        parent_hash: h("parentHash")?,
        ts: q("timestamp")?,
    })
}

#[async_trait]
impl ChainSource for RpcChain {
    async fn head(&self) -> anyhow::Result<u64> {
        self.rpc.block_number().await
    }
    async fn header(&self, n: u64) -> anyhow::Result<Option<BlockRef>> {
        match self.rpc.block_by_number(n).await? {
            None => Ok(None),
            Some(v) => Ok(Some(parse_header(&v)?)),
        }
    }
    async fn header_list(&self, nums: &[u64]) -> anyhow::Result<Vec<Option<BlockRef>>> {
        if self.batch_size <= 1 {
            let mut out = Vec::with_capacity(nums.len());
            for n in nums {
                out.push(self.header(*n).await?);
            }
            return Ok(out);
        }
        let chunks: Vec<Vec<u64>> = nums.chunks(self.batch_size).map(|c| c.to_vec()).collect();
        let rpc = self.rpc.clone();
        let results: Vec<anyhow::Result<Vec<Option<serde_json::Value>>>> = stream::iter(chunks)
            .map(|c| {
                let rpc = rpc.clone();
                async move { rpc.blocks_by_number_batch(&c).await }
            })
            .buffered(self.concurrency.max(1))
            .collect()
            .await;
        let mut out = Vec::with_capacity(nums.len());
        for r in results {
            for v in r? {
                out.push(v.map(|v| parse_header(&v)).transpose()?);
            }
        }
        Ok(out)
    }
    async fn events(&self, from: u64, to: u64, ts: &HashMap<u64, u64>) -> anyhow::Result<Vec<EventRecord>> {
        let logs = self.rpc.get_logs(from, to, &self.exchange).await?;
        let mut raws = logs.iter().map(RawLog::from_json).collect::<anyhow::Result<Vec<_>>>()?;
        raws.sort_by_key(|l| (l.block, l.log_index));
        raws.iter()
            .map(|l| {
                let t = *ts.get(&l.block).ok_or_else(|| anyhow!("log for block {} outside requested range", l.block))?;
                self.decoder.decode(l, t).with_context(|| format!("decoding log {}:{}", l.block, l.log_index))
            })
            .collect()
    }
    async fn rpc_finalized(&self) -> Option<u64> {
        let v = self.rpc.block_by_tag("finalized").await.ok()??;
        parse_header(&v).ok().map(|b| b.number)
    }
    async fn receipt(&self, tx: B256) -> anyhow::Result<Option<ReceiptInfo>> {
        let Some(v) = self.rpc.transaction_receipt(&tx.to_string()).await? else {
            return Ok(None);
        };
        let Some(bn) = v.get("blockNumber").filter(|x| !x.is_null()) else {
            return Ok(None);
        };
        Ok(Some(ReceiptInfo {
            success: v.get("status").map(parse_qty).transpose()?.unwrap_or(1) == 1,
            block_number: parse_qty(bn)?,
            block_hash: v
                .get("blockHash")
                .and_then(|x| x.as_str())
                .ok_or_else(|| anyhow!("receipt missing blockHash"))?
                .parse()?,
            gas_used: v.get("gasUsed").map(parse_qty).transpose()?.unwrap_or(0),
        }))
    }
}

#[derive(Clone, Debug)]
pub struct IndexerCfg {
    pub start_block: u64,
    pub batch: u64,
    /// Page size used when walking the stored hash chain back to a fork point. NOT a hard limit: reorgs deeper than
    /// this are re-anchored page by page (and raise an operator alert).
    pub reorg_window: usize,
    pub confirmations: u64,
    pub poll_ms: u64,
    /// Persist a read-model snapshot every N blocks (0 = never). Startup/reorg replay is bounded by this.
    pub snapshot_every: u64,
    /// Number of snapshots retained.
    pub snapshot_keep: usize,
    /// Keep block hashes for this many blocks behind the tip, prune older (0 = keep every block hash forever).
    /// A reorg deeper than this cannot be anchored and halts indexing (operator action required).
    pub block_retention: u64,
    /// Prefetch the next batch's headers + logs while the current one is committed.
    pub prefetch: bool,
}

impl Default for IndexerCfg {
    fn default() -> Self {
        Self {
            start_block: 0,
            batch: 200,
            reorg_window: 128,
            confirmations: 0,
            poll_ms: 500,
            snapshot_every: 5000,
            snapshot_keep: 4,
            block_retention: 0,
            prefetch: true,
        }
    }
}

/// How a read model was (re)built.
#[derive(Clone, Debug, Default)]
pub struct ReplayStats {
    pub snapshot_block: Option<u64>,
    pub replayed_events: u64,
}

struct Prefetched {
    from: u64,
    to: u64,
    headers: Vec<BlockRef>,
    events: Vec<EventRecord>,
}

pub struct Indexer {
    pub chain: Arc<dyn ChainSource>,
    pub store: Arc<dyn EventStore>,
    pub shared: Arc<Shared>,
    pub cfg: IndexerCfg,
    prefetch: tokio::sync::Mutex<Option<PrefetchSlot>>,
}

type PrefetchSlot = (u64, u64, tokio::task::JoinHandle<anyhow::Result<Prefetched>>);

const LOAD_CHUNK: usize = 5000;

impl Indexer {
    pub fn new(chain: Arc<dyn ChainSource>, store: Arc<dyn EventStore>, shared: Arc<Shared>, cfg: IndexerCfg) -> Self {
        Self {
            chain,
            store,
            shared,
            cfg,
            prefetch: tokio::sync::Mutex::new(None),
        }
    }

    /// Rebuild the read models for the log up to `upto` (the checkpoint or a fork point; `None` = no blocks).
    /// Loads the newest valid snapshot at or below `upto` and replays only the tail of the log after it.
    pub async fn rebuild_state(&self, upto: Option<u64>) -> anyhow::Result<(State, ReplayStats)> {
        let like = self.shared.state.read().unwrap().fresh_like();
        let mut st = like.fresh_like();
        let mut stats = ReplayStats::default();
        let mut after = None;
        if let (Some(upto), true) = (upto, self.cfg.snapshot_every > 0) {
            let mut bound = upto;
            loop {
                let Some(sn) = self.store.latest_snapshot(bound).await? else { break };
                // a snapshot must belong to the stored chain: if its block is still stored, the hashes must agree
                let stored = self
                    .store
                    .blocks_before(sn.block + 1, 1)
                    .await?
                    .into_iter()
                    .next()
                    .filter(|b| b.number == sn.block);
                let hash_ok = stored.as_ref().is_none_or(|b| b.hash == sn.block_hash);
                match (hash_ok, State::from_snapshot(&sn.state, &like)) {
                    (true, Ok(s)) => {
                        st = s;
                        stats.snapshot_block = Some(sn.block);
                        after = Some(pos_key(sn.block, u32::MAX));
                        break;
                    }
                    (ok, r) => {
                        tracing::warn!(block = sn.block, hash_ok = ok, error = ?r.err().map(|e| format!("{e:#}")), "ignoring unusable snapshot");
                        if sn.block == 0 {
                            break;
                        }
                        bound = sn.block - 1;
                    }
                }
            }
        }
        loop {
            let recs = self.store.load_events(after, LOAD_CHUNK).await?;
            if recs.is_empty() {
                break;
            }
            after = recs.last().map(|r| r.meta.key());
            stats.replayed_events += recs.len() as u64;
            st.apply_all(&recs);
        }
        let m = &self.shared.metrics;
        m.last_replay_events.store(stats.replayed_events, Ordering::Relaxed);
        m.last_replay_snapshot_block
            .store(stats.snapshot_block.map(|b| b + 1).unwrap_or(0), Ordering::Relaxed);
        Ok((st, stats))
    }

    /// Load checkpoint + snapshot + tail replay. Must run before `run`/`step`.
    pub async fn bootstrap(&self) -> anyhow::Result<()> {
        let tip = self.store.tip().await?;
        let (st, stats) = self.rebuild_state(tip.as_ref().map(|t| t.number)).await?;
        tracing::info!(
            applied = st.counters.applied,
            replayed_tail = stats.replayed_events,
            snapshot_block = ?stats.snapshot_block,
            tip = ?tip.as_ref().map(|t| t.number),
            "read models restored"
        );
        // a full replay happened (first start, or snapshots were cleared by reindex-from-raw): checkpoint now so the next
        // restart is a tail replay again
        if self.cfg.snapshot_every > 0 && stats.snapshot_block.is_none() && stats.replayed_events > 0 {
            if let Some(t) = &tip {
                self.store
                    .save_snapshot(&Snapshot {
                        block: t.number,
                        block_hash: t.hash,
                        state: st.to_snapshot(),
                    })
                    .await?;
                self.store.prune_snapshots(self.cfg.snapshot_keep.max(1)).await?;
                Metrics::inc(&self.shared.metrics.snapshots_saved);
            }
        }
        *self.shared.state.write().unwrap() = st;
        let mut c = self.shared.chain.write().unwrap();
        c.indexed = tip;
        c.bootstrapped = true;
        Ok(())
    }

    pub async fn run(&self) {
        loop {
            if self.shared.chain.read().unwrap().halted.is_some() {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            match self.step().await {
                Ok(true) => {}
                Ok(false) => tokio::time::sleep(Duration::from_millis(self.cfg.poll_ms)).await,
                Err(e) => {
                    Metrics::inc(&self.shared.metrics.rpc_errors);
                    tracing::warn!(error = %format!("{e:#}"), "indexer step failed; retrying");
                    self.shared.chain.write().unwrap().last_error = Some(format!("{e:#}"));
                    tokio::time::sleep(Duration::from_millis(self.cfg.poll_ms.max(1000))).await;
                }
            }
        }
    }

    /// Walk the stored hash chain from the (non-canonical) tip downwards, `reorg_window` blocks per page and with
    /// batched header requests, until a stored block is still canonical. Returns `(fork, walked)`; `fork = None`
    /// means the entire stored history diverged and it starts at `start_block`, so indexing restarts from nothing.
    async fn find_fork(&self, old_tip: u64) -> anyhow::Result<(Option<u64>, u64)> {
        let page = self.cfg.reorg_window.max(1);
        let mut before = old_tip + 1;
        let mut walked = 0u64;
        loop {
            let blocks = self.store.blocks_before(before, page).await?;
            if blocks.is_empty() {
                break;
            }
            let nums: Vec<u64> = blocks.iter().map(|b| b.number).collect();
            let heads = self.chain.header_list(&nums).await?;
            for (b, h) in blocks.iter().zip(heads) {
                if matches!(h, Some(h) if h.hash == b.hash) {
                    return Ok((Some(b.number), walked));
                }
                walked += 1;
            }
            before = blocks.last().map(|b| b.number).unwrap_or(0);
            if blocks.len() < page {
                break;
            }
        }
        match self.store.oldest_block().await? {
            None => Ok((None, walked)),
            Some(o) if o.number <= self.cfg.start_block => Ok((None, walked)),
            Some(o) => bail!(
                "reorg deeper than the retained block-hash history (oldest retained block {}, --block-retention {}); wipe the database and re-index",
                o.number,
                self.cfg.block_retention
            ),
        }
    }

    /// Roll the store back to `fork` (None = everything) and rebuild read models from the newest snapshot at or below
    /// it plus the surviving log tail. Replay cost is bounded by the snapshot interval, not by history.
    pub async fn rollback(&self, fork: Option<u64>, old_tip: u64) -> anyhow::Result<()> {
        let removed = self.store.rollback_after(fork).await?;
        *self.prefetch.lock().await = None;
        let tip = self.store.tip().await?;
        let (st, stats) = self.rebuild_state(fork).await?;
        let fork_block = fork.unwrap_or(0);
        {
            let mut g = self.shared.state.write().unwrap();
            *g = st;
            self.shared.hub.resync_all(&g, fork_block);
        }
        self.shared.chain.write().unwrap().indexed = tip;
        Metrics::inc(&self.shared.metrics.reorgs);
        self.shared
            .metrics
            .last_reorg_depth
            .store(old_tip.saturating_sub(fork_block), Ordering::Relaxed);
        tracing::warn!(
            fork = fork_block,
            old_tip,
            removed_events = removed,
            snapshot_block = ?stats.snapshot_block,
            replayed_events = stats.replayed_events,
            "reorg handled: rolled back and rebuilt read models"
        );
        Ok(())
    }

    async fn take_prefetch(&self, from: u64, to: u64) -> Option<Prefetched> {
        let slot = self.prefetch.lock().await.take()?;
        if slot.0 != from || slot.1 != to {
            slot.2.abort();
            return None;
        }
        match slot.2.await {
            Ok(Ok(p)) if p.from == from && p.to == to => Some(p),
            _ => None,
        }
    }

    fn spawn_prefetch(&self, from: u64, to: u64) -> tokio::task::JoinHandle<anyhow::Result<Prefetched>> {
        let chain = self.chain.clone();
        tokio::spawn(async move {
            let headers = chain.headers(from, to).await?;
            let Some(last) = headers.last().map(|h| h.number) else {
                return Ok(Prefetched {
                    from,
                    to,
                    headers,
                    events: vec![],
                });
            };
            let ts: HashMap<u64, u64> = headers.iter().map(|h| (h.number, h.ts)).collect();
            let events = chain.events(from, last, &ts).await?;
            Ok(Prefetched { from, to, headers, events })
        })
    }

    /// One unit of work. Returns Ok(true) if progress was made (call again immediately).
    pub async fn step(&self) -> anyhow::Result<bool> {
        let head = self.chain.head().await?;
        let tip = self.store.tip().await?;
        {
            let mut c = self.shared.chain.write().unwrap();
            c.chain_head = Some(head);
            c.last_error = None;
        }
        if let Some(f) = self.chain.rpc_finalized().await {
            self.shared.chain.write().unwrap().rpc_finalized = Some(f);
        }

        // 1. is our tip still canonical?
        if let Some(t) = &tip {
            let ok = matches!(self.chain.header(t.number).await?, Some(h) if h.hash == t.hash);
            if !ok {
                return self.handle_reorg(t.number).await;
            }
            if let Some(h) = self.chain.header(head).await? {
                self.shared.chain.write().unwrap().chain_head_ts = Some(h.ts);
            }
        }

        let next = tip.as_ref().map(|t| t.number + 1).unwrap_or(self.cfg.start_block);
        let target = head.saturating_sub(self.cfg.confirmations);
        if next > target {
            return Ok(false);
        }
        let to = target.min(next + self.cfg.batch - 1);

        // 2. headers (batched; possibly prefetched) with parent-hash linkage
        let pre = if self.cfg.prefetch { self.take_prefetch(next, to).await } else { None };
        let (all_headers, mut pre_events) = match pre {
            Some(p) => (p.headers, Some(p.events)),
            None => (self.chain.headers(next, to).await?, None),
        };
        if self.cfg.prefetch && to < target {
            let (nf, nt) = (to + 1, target.min(to + self.cfg.batch));
            let h = self.spawn_prefetch(nf, nt);
            *self.prefetch.lock().await = Some((nf, nt, h));
        }
        let mut headers: Vec<BlockRef> = Vec::new();
        let mut prev = tip.clone();
        for h in all_headers {
            if let Some(p) = &prev {
                if p.number + 1 == h.number && p.hash != h.parent_hash {
                    if headers.is_empty() {
                        // our stored tip is not the parent of the canonical next block
                        return self.handle_reorg(p.number).await;
                    }
                    *self.prefetch.lock().await = None;
                    bail!("node returned inconsistent headers inside a batch (reorg in flight); retrying");
                }
            }
            prev = Some(h.clone());
            headers.push(h);
        }
        if headers.is_empty() {
            return Ok(false);
        }
        let last = headers.last().unwrap().number;

        // 3. logs
        let ts: HashMap<u64, u64> = headers.iter().map(|h| (h.number, h.ts)).collect();
        let recs = match pre_events.take() {
            Some(e) => e,
            None => self.chain.events(next, last, &ts).await?,
        };
        let hashes: HashMap<u64, alloy_primitives::B256> = headers.iter().map(|h| (h.number, h.hash)).collect();
        for r in &recs {
            match hashes.get(&r.meta.block) {
                Some(h) if *h == r.meta.block_hash => {}
                _ => {
                    *self.prefetch.lock().await = None;
                    bail!("log block hash does not match header for block {} (reorg in flight); retrying", r.meta.block)
                }
            }
        }
        // the batch must still be canonical after fetching logs
        match self.chain.header(last).await? {
            Some(h) if h.hash == headers.last().unwrap().hash => {}
            _ => {
                *self.prefetch.lock().await = None;
                bail!("batch tip changed while fetching logs; retrying")
            }
        }

        let mut by_block: HashMap<u64, Vec<EventRecord>> = HashMap::new();
        for r in recs {
            by_block.entry(r.meta.block).or_default().push(r);
        }
        for h in &headers {
            let evs = by_block.remove(&h.number).unwrap_or_default();
            self.store.commit_block(h, &evs).await?;
            let snap = {
                let mut g = self.shared.state.write().unwrap();
                let outs = g.apply_all(&evs);
                self.shared.hub.publish(&outs);
                (self.cfg.snapshot_every > 0 && h.number > 0 && h.number % self.cfg.snapshot_every == 0).then(|| g.to_snapshot())
            };
            self.shared.chain.write().unwrap().indexed = Some(h.clone());
            Metrics::inc(&self.shared.metrics.blocks_indexed);
            if let Some(state) = snap {
                self.store
                    .save_snapshot(&Snapshot {
                        block: h.number,
                        block_hash: h.hash,
                        state,
                    })
                    .await?;
                self.store.prune_snapshots(self.cfg.snapshot_keep.max(1)).await?;
                Metrics::inc(&self.shared.metrics.snapshots_saved);
            }
        }
        if self.cfg.block_retention > 0 && last > self.cfg.block_retention {
            self.store.prune_blocks(last - self.cfg.block_retention).await?;
        }
        Ok(true)
    }

    async fn handle_reorg(&self, old_tip: u64) -> anyhow::Result<bool> {
        match self.find_fork(old_tip).await {
            Ok((fork, walked)) => {
                let depth = old_tip.saturating_sub(fork.unwrap_or(0));
                self.rollback(fork, old_tip).await?;
                if walked > self.cfg.reorg_window as u64 {
                    // deeper than one page of the stored chain: recovered, but an operator must look at it
                    Metrics::inc(&self.shared.metrics.deep_reorgs);
                    let msg = format!(
                        "ALERT deep reorg: {depth} blocks (> reorg window {}) re-anchored to block {}; verify RPC node/chain health",
                        self.cfg.reorg_window,
                        fork.map(|f| f.to_string()).unwrap_or_else(|| "none (full re-index)".into())
                    );
                    tracing::error!("{msg}");
                    self.shared.chain.write().unwrap().alert = Some(msg);
                }
                Ok(true)
            }
            Err(e) => {
                let msg = format!("{e:#}");
                tracing::error!(error = %msg, "ALERT cannot recover from reorg; indexing halted");
                self.shared.chain.write().unwrap().halted = Some(msg.clone());
                Err(anyhow!(msg))
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------ market meta

/// Read static market configuration with `eth_call getMarket(m)` (the contract emits no MarketCreated event).
/// Best effort: failures leave the market without metadata.
pub async fn fetch_market_meta(rpc: &Rpc, exchange: &str, names: &HashMap<u8, String>) -> anyhow::Result<std::collections::BTreeMap<u8, MarketMeta>> {
    let abi: JsonAbi = serde_json::from_str(include_str!("../abi/PerpExchange.merged.json"))?;
    let count_fn = abi
        .function("marketCount")
        .and_then(|v| v.first())
        .ok_or_else(|| anyhow!("marketCount not in ABI"))?;
    let get_fn = abi
        .function("getMarket")
        .and_then(|v| v.first())
        .ok_or_else(|| anyhow!("getMarket not in ABI"))?;
    let data = count_fn.abi_encode_input(&[])?;
    let out = rpc.eth_call(exchange, &format!("0x{}", hex(&data))).await?;
    let bytes = crate::events::hex_to_bytes(&out)?;
    let vals = count_fn.abi_decode_output(&bytes)?;
    let count = match vals.first() {
        Some(DynSolValue::Uint(v, _)) => u8::try_from(v)?,
        _ => bail!("unexpected marketCount output"),
    };
    let comps: Vec<String> = get_fn
        .outputs
        .first()
        .map(|o| o.components.iter().map(|c| c.name.clone()).collect())
        .unwrap_or_default();
    let mut res = std::collections::BTreeMap::new();
    for m in 0..count {
        let data = get_fn.abi_encode_input(&[DynSolValue::Uint(U256::from(m), 8)])?;
        let out = rpc.eth_call(exchange, &format!("0x{}", hex(&data))).await?;
        let bytes = crate::events::hex_to_bytes(&out)?;
        let vals = get_fn.abi_decode_output(&bytes)?;
        let Some(DynSolValue::Tuple(fields)) = vals.into_iter().next() else {
            continue;
        };
        let get = |name: &str| comps.iter().position(|c| c == name).and_then(|i| fields.get(i));
        let u = |name: &str| -> Option<U256> {
            match get(name) {
                Some(DynSolValue::Uint(v, _)) => Some(*v),
                _ => None,
            }
        };
        res.insert(
            m,
            MarketMeta {
                name: names.get(&m).cloned(),
                tick: u("tick").and_then(|v| u64::try_from(v).ok()),
                lot: u("lot").and_then(|v| u64::try_from(v).ok()),
                min_notional: u("minNotional").and_then(|v| u64::try_from(v).ok()),
                max_order_size: u("maxOrderSize").map(|v| v.to_string()),
                max_oi: u("maxOI").map(|v| v.to_string()),
                funding_interval: u("fundingInterval").and_then(|v| u32::try_from(v).ok()),
            },
        );
    }
    Ok(res)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
