//! `reindex-from-raw`: re-run the decoder over the stored raw topics + data and rewrite the decoded events.
//!
//! Use after refreshing `abi/PerpExchange.merged.json` (or `--abi-file`) when the contracts gained events or fields:
//! logs that were stored as `Other { Unknown:0x.. }` become typed events, no RPC access needed. Snapshots are dropped
//! when anything changed (they were built from the old decoding), so the next start replays the full log once.
use crate::events::Decoder;
use crate::store::EventStore;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReindexReport {
    pub scanned: u64,
    /// rows whose decoded form changed
    pub changed: u64,
    /// rows that predate raw storage (cannot be re-derived)
    pub without_raw: u64,
    /// rows that still decode to an unknown/undecodable event after the run
    pub still_unknown: u64,
}

pub async fn reindex_from_raw(store: &dyn EventStore, decoder: &Decoder, chunk: usize) -> anyhow::Result<ReindexReport> {
    let mut rep = ReindexReport::default();
    let mut after = None;
    loop {
        let recs = store.load_events_raw(after, chunk.max(1)).await?;
        if recs.is_empty() {
            break;
        }
        after = recs.last().map(|r| r.meta.key());
        let mut changes = Vec::new();
        for r in &recs {
            rep.scanned += 1;
            let Some(raw) = &r.raw else {
                rep.without_raw += 1;
                continue;
            };
            let ev = decoder.decode_ev(&raw.topics, &raw.data);
            if let crate::events::Ev::Other { name } = &ev {
                if name.starts_with(crate::events::UNKNOWN_PREFIX) || name.starts_with(crate::events::UNDECODABLE_PREFIX) {
                    rep.still_unknown += 1;
                }
            }
            if ev != r.ev {
                let mut n = r.clone();
                n.ev = ev;
                changes.push(n);
            }
        }
        rep.changed += changes.len() as u64;
        if !changes.is_empty() {
            store.update_decoded(&changes).await?;
        }
    }
    if rep.changed > 0 {
        store.clear_snapshots().await?;
    }
    Ok(rep)
}
