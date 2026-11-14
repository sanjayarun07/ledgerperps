//! Process-wide shared objects: read model, websocket hub, chain info and metrics.
use crate::hub::Hub;
use crate::state::State;
use crate::store::BlockRef;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

#[derive(Default, Clone, Debug)]
pub struct ChainInfo {
    pub chain_id: u64,
    pub exchange: String,
    pub chain_head: Option<u64>,
    pub chain_head_ts: Option<u64>,
    pub indexed: Option<BlockRef>,
    /// The RPC node's own "finalized" tag, if it supports one. This is NOT parent-chain finality.
    pub rpc_finalized: Option<u64>,
    /// Set once startup replay finished.
    pub bootstrapped: bool,
    pub last_error: Option<String>,
    /// Indexing is halted (e.g. reorg deeper than the stored window). Needs operator action.
    pub halted: Option<String>,
    /// Sticky operator alert (e.g. a reorg deeper than the window was re-anchored). Cleared on restart.
    pub alert: Option<String>,
}

#[derive(Default)]
pub struct Metrics {
    pub http_requests: AtomicU64,
    pub http_2xx: AtomicU64,
    pub http_4xx: AtomicU64,
    pub http_5xx: AtomicU64,
    pub rate_limited: AtomicU64,
    pub reorgs: AtomicU64,
    pub last_reorg_depth: AtomicU64,
    pub rpc_errors: AtomicU64,
    pub blocks_indexed: AtomicU64,
    pub ws_accepted: AtomicU64,
    pub ws_dropped_slow: AtomicU64,
    pub deep_reorgs: AtomicU64,
    pub snapshots_saved: AtomicU64,
    /// events replayed by the last read-model rebuild (startup or reorg)
    pub last_replay_events: AtomicU64,
    /// 1 + block of the snapshot the last rebuild started from (0 = full replay)
    pub last_replay_snapshot_block: AtomicU64,
    pub unauthorized: AtomicU64,
    pub rate_limited_ip: AtomicU64,
    pub rate_limited_key: AtomicU64,
    pub rate_backend_errors: AtomicU64,
    pub tracked_txs: AtomicU64,
}

impl Metrics {
    pub fn inc(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }
    pub fn get(c: &AtomicU64) -> u64 {
        c.load(Ordering::Relaxed)
    }
}

pub struct Shared {
    pub state: RwLock<State>,
    pub hub: Hub,
    pub chain: RwLock<ChainInfo>,
    pub metrics: Metrics,
    pub ready_max_lag: u64,
}

impl Shared {
    pub fn new(ws_queue: usize, ready_max_lag: u64) -> Self {
        Self {
            state: RwLock::new(State::new()),
            hub: Hub::new(ws_queue),
            chain: RwLock::new(ChainInfo::default()),
            metrics: Metrics::default(),
            ready_max_lag,
        }
    }

    pub fn lag(&self) -> Option<u64> {
        let c = self.chain.read().unwrap();
        match (c.chain_head, &c.indexed) {
            (Some(h), Some(i)) => Some(h.saturating_sub(i.number)),
            (Some(h), None) => Some(h + 1),
            _ => None,
        }
    }

    pub fn is_ready(&self) -> bool {
        let c = self.chain.read().unwrap();
        if !c.bootstrapped || c.halted.is_some() {
            return false;
        }
        drop(c);
        matches!(self.lag(), Some(l) if l <= self.ready_max_lag)
    }
}
