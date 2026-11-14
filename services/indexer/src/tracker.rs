//! Opt-in receipt tracker for transactions submitted through `POST /v1/tx/track`.
//!
//! A reverted transaction emits no contract events, so the event-derived read models can never show it. Callers who
//! want visibility register the tx hash they submitted; this loop polls `eth_getTransactionReceipt` and records a
//! receipt-based status: `pending` -> `success` | `reverted` (with block/gas) or `dropped` (no receipt within the
//! timeout). Confirmed entries are re-checked while their block is within the reorg window, so a reorged-out
//! transaction goes back to `pending`. It tracks only hashes it is told about; it is NOT a mempool view.
use crate::indexer::ChainSource;
use crate::store::EventStore;
use std::sync::Arc;
use std::time::Duration;

pub struct TxTracker {
    pub chain: Arc<dyn ChainSource>,
    pub store: Arc<dyn EventStore>,
    /// pending entries without a receipt older than this become `dropped`
    pub timeout_secs: i64,
    /// re-verify confirmed receipts whose block is within this many blocks of the head
    pub recheck_depth: u64,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl TxTracker {
    /// One pass; returns the number of rows updated.
    pub async fn check_once(&self) -> anyhow::Result<usize> {
        let head = self.chain.head().await?;
        let todo = self.store.txs_to_check(head.saturating_sub(self.recheck_depth), 200).await?;
        let mut n = 0;
        for mut t in todo {
            let before = t.clone();
            match self.chain.receipt(t.tx_hash).await? {
                Some(r) => {
                    t.status = if r.success { "success" } else { "reverted" }.into();
                    t.block_number = Some(r.block_number);
                    t.block_hash = Some(r.block_hash);
                    t.gas_used = Some(r.gas_used);
                }
                None if t.status == "pending" => {
                    if now() - t.submitted_at > self.timeout_secs {
                        t.status = "dropped".into();
                    }
                }
                None => {
                    // it had a receipt that vanished: the block was reorged out
                    t.status = "pending".into();
                    t.block_number = None;
                    t.block_hash = None;
                    t.gas_used = None;
                }
            }
            t.checked_at = Some(now());
            if t != before {
                n += 1;
            }
            self.store.update_tracked_tx(&t).await?;
        }
        Ok(n)
    }

    pub async fn run(&self, every: Duration) {
        loop {
            if let Err(e) = self.check_once().await {
                tracing::warn!(error = %format!("{e:#}"), "tx tracker pass failed");
            }
            tokio::time::sleep(every).await;
        }
    }
}
