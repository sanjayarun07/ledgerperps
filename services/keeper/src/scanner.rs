//! Log scanning: decodes exchange events into `state::Event` and advances the checkpoint.
use crate::{
    abi::IPerp,
    actions::Ctx,
    state::{Event, State},
};
use alloy::{primitives::B256, rpc::types::Log, sol_types::SolEvent};
use anyhow::Result;
use std::{collections::BTreeMap, future::Future};
use tracing::{debug, error, warn};

/// Decode a raw log into a keeper event (None for events we do not care about or cannot decode).
pub fn decode_log(log: &Log) -> Option<Event> {
    let t0 = log.topic0()?;
    let d = log.data();
    if *t0 == IPerp::Deposit::SIGNATURE_HASH {
        let e = IPerp::Deposit::decode_log_data(d).ok()?;
        Some(Event::Deposit { acct: e.acct })
    } else if *t0 == IPerp::Fill::SIGNATURE_HASH {
        let e = IPerp::Fill::decode_log_data(d).ok()?;
        Some(Event::Fill { maker: e.maker, taker: e.taker })
    } else if *t0 == IPerp::CondPlaced::SIGNATURE_HASH {
        let e = IPerp::CondPlaced::decode_log_data(d).ok()?;
        Some(Event::CondPlaced { id: e.id, market: e.market, above: e.above, trigger: e.trigger })
    } else if *t0 == IPerp::CondTriggered::SIGNATURE_HASH {
        Some(Event::CondGone { id: IPerp::CondTriggered::decode_log_data(d).ok()?.id })
    } else if *t0 == IPerp::CondCanceled::SIGNATURE_HASH {
        Some(Event::CondGone { id: IPerp::CondCanceled::decode_log_data(d).ok()?.id })
    } else if *t0 == IPerp::TwapPlaced::SIGNATURE_HASH {
        Some(Event::TwapPlaced { id: IPerp::TwapPlaced::decode_log_data(d).ok()?.id })
    } else if *t0 == IPerp::TwapDone::SIGNATURE_HASH {
        Some(Event::TwapGone { id: IPerp::TwapDone::decode_log_data(d).ok()?.id })
    } else if *t0 == IPerp::TwapCanceled::SIGNATURE_HASH {
        Some(Event::TwapGone { id: IPerp::TwapCanceled::decode_log_data(d).ok()?.id })
    } else if *t0 == IPerp::Liquidated::SIGNATURE_HASH {
        // positions of the liquidated account changed: refresh it
        Some(Event::Deposit { acct: IPerp::Liquidated::decode_log_data(d).ok()?.acct })
    } else {
        None
    }
}

/// Next inclusive chunk `[from, to]` of at most `chunk` blocks, bounded by `safe`. None when caught up.
pub fn next_range(next: u64, safe: u64, chunk: u64) -> Option<(u64, u64)> {
    if next > safe {
        return None;
    }
    Some((next, safe.min(next.saturating_add(chunk.saturating_sub(1)))))
}

/// Canonical-chain access needed by the scanner (real chain or a test double).
pub trait ScanSource {
    /// `(hash, parent_hash)` of block `n` on the current canonical chain; `None` if the chain has no such block.
    fn header(&self, n: u64) -> impl Future<Output = Result<Option<(B256, B256)>>> + Send;
    fn logs(&self, from: u64, to: u64) -> impl Future<Output = Result<Vec<Log>>> + Send;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub applied: usize,
    /// Set when a reorg was detected: the last block still shared with the canonical chain (scan restarted after it).
    pub rolled_back_to: Option<u64>,
    /// Number of blocks that were undone.
    pub reorg_depth: u64,
}

/// Newest stored block whose hash still matches the canonical chain. `canon(n)` = canonical hash at height `n`
/// (None when the chain no longer has that height). Pure given `canon`, so the reorg logic is unit-testable.
pub fn find_common_ancestor(stored: &BTreeMap<u64, B256>, mut canon: impl FnMut(u64) -> Option<B256>) -> Option<u64> {
    stored.iter().rev().find(|(n, h)| canon(**n) == Some(**h)).map(|(n, _)| *n)
}

/// Compare the newest stored hash with the canonical chain; on mismatch roll the state back to the common ancestor.
/// If no stored block matches (reorg deeper than the window) everything inside the window is rolled back.
async fn reconcile<S: ScanSource>(src: &S, state: &mut State) -> Result<Option<(u64, u64)>> {
    let Some((&last, &h)) = state.hashes.iter().next_back() else { return Ok(None) };
    let canon_last = src.header(last).await?.map(|x| x.0);
    if canon_last == Some(h) {
        return Ok(None);
    }
    let mut canon: BTreeMap<u64, B256> = BTreeMap::new();
    for n in state.hashes.keys().rev().copied().collect::<Vec<_>>() {
        if let Some((ch, _)) = src.header(n).await? {
            canon.insert(n, ch);
        }
    }
    let earliest = *state.hashes.keys().next().expect("non-empty");
    let ancestor = find_common_ancestor(&state.hashes, |n| canon.get(&n).copied());
    let (anc, deep) = match ancestor {
        Some(a) => (a, false),
        None => (earliest.saturating_sub(1), true),
    };
    let depth = state.next_block.saturating_sub(1).saturating_sub(anc);
    if deep {
        error!(window_start = earliest, "reorg deeper than the tracked window: rolling back the whole window; raise --reorg-window");
    }
    warn!(ancestor = anc, depth, "chain reorganisation detected: rolling back scan cursor and tracked state");
    state.rollback_to(anc);
    Ok(Some((anc, depth)))
}

/// Scan from `state.next_block` up to `safe`, applying events in order and advancing the checkpoint after each chunk.
/// Block hashes of the last `window` blocks are verified parent-to-parent and stored, so a reorg is detected on a later
/// call and undone via the journal. Returns early (without error) when the chain moves under the scan; the next call
/// reconciles. On error the checkpoint stays at the last fully applied chunk.
pub async fn scan_with<S: ScanSource>(src: &S, state: &mut State, safe: u64, backstop: &B256, chunk: u64, window: u64) -> Result<ScanReport> {
    let mut report = ScanReport::default();
    if let Some((anc, depth)) = reconcile(src, state).await? {
        report.rolled_back_to = Some(anc);
        report.reorg_depth = depth;
    }
    let window = window.max(1);
    while let Some((from, to)) = next_range(state.next_block, safe, chunk) {
        // 1) headers for the blocks we keep hashes for, checking the parent chain as we go
        let rec_from = from.max((safe + 1).saturating_sub(window));
        let mut fresh: Vec<(u64, B256)> = vec![];
        if to >= rec_from {
            let mut prev: Option<B256> = rec_from.checked_sub(1).and_then(|p| state.hashes.get(&p).copied());
            for n in rec_from..=to {
                let Some((h, parent)) = src.header(n).await? else {
                    debug!(block = n, "block vanished during scan (reorg in progress); retrying next cycle");
                    return Ok(report);
                };
                if matches!(prev, Some(p) if p != parent) {
                    debug!(block = n, "parent hash mismatch during scan (reorg in progress); retrying next cycle");
                    return Ok(report);
                }
                fresh.push((n, h));
                prev = Some(h);
            }
        }
        // 2) logs, then make sure the tip did not change while we fetched them
        let mut logs = src.logs(from, to).await?;
        if let Some((n, h)) = fresh.last() {
            if src.header(*n).await?.map(|x| x.0) != Some(*h) {
                debug!(block = n, "tip changed while fetching logs; retrying next cycle");
                return Ok(report);
            }
        }
        let by_height: BTreeMap<u64, B256> = fresh.iter().copied().collect();
        for l in &logs {
            if let (Some(bn), Some(bh)) = (l.block_number, l.block_hash) {
                if matches!(by_height.get(&bn), Some(h) if *h != bh) {
                    debug!(block = bn, "log from a different fork than the verified header; retrying next cycle");
                    return Ok(report);
                }
            }
        }
        logs.sort_by_key(|l| (l.block_number.unwrap_or(0), l.log_index.unwrap_or(0)));
        for l in &logs {
            if l.removed {
                warn!("ignoring removed log (reorg); the hash-chain check handles this");
                continue;
            }
            if let Some(ev) = decode_log(l) {
                debug!(?ev, block = l.block_number, "event");
                state.apply_at(l.block_number.unwrap_or(from), &ev, backstop);
                report.applied += 1;
            }
        }
        state.hashes.extend(fresh);
        state.next_block = to + 1;
        state.prune(state.next_block.saturating_sub(window));
    }
    Ok(report)
}

/// Scan using the real chain.
pub async fn scan(ctx: &Ctx, state: &mut State, safe: u64, backstop: &B256) -> Result<ScanReport> {
    scan_with(&*ctx.chain, state, safe, backstop, ctx.cfg.log_chunk, ctx.cfg.reorg_window).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{Address, B256};
    use alloy::sol_types::SolEvent;

    fn mk(data: alloy::primitives::LogData) -> Log {
        Log { inner: alloy::primitives::Log { address: Address::ZERO, data }, ..Default::default() }
    }

    #[test]
    fn decodes_deposit_and_fill() {
        let acct = B256::repeat_byte(7);
        let d = IPerp::Deposit { acct, from: Address::ZERO, amount: alloy::primitives::U256::from(5) };
        assert_eq!(decode_log(&mk(d.encode_log_data())), Some(Event::Deposit { acct }));
        let f = IPerp::Fill {
            tradeId: 1, market: 0, makerOrderId: 2, maker: B256::repeat_byte(1), taker: B256::repeat_byte(2),
            takerIsBuy: true, price: 10, size: 5, takerFee: alloy::primitives::U256::ZERO, makerFee: alloy::primitives::I256::ZERO,
        };
        assert_eq!(decode_log(&mk(f.encode_log_data())), Some(Event::Fill { maker: B256::repeat_byte(1), taker: B256::repeat_byte(2) }));
    }

    #[test]
    fn decodes_cond_and_twap_lifecycle() {
        let c = IPerp::CondPlaced { id: 9, acct: B256::ZERO, market: 2, isBuy: true, above: false, trigger: 77, limit: 1, size: 1, reduceOnly: false, sibling: 0 };
        assert_eq!(decode_log(&mk(c.encode_log_data())), Some(Event::CondPlaced { id: 9, market: 2, above: false, trigger: 77 }));
        assert_eq!(decode_log(&mk(IPerp::CondTriggered { id: 9, markPrice: 1 }.encode_log_data())), Some(Event::CondGone { id: 9 }));
        assert_eq!(decode_log(&mk(IPerp::CondCanceled { id: 9 }.encode_log_data())), Some(Event::CondGone { id: 9 }));
        let t = IPerp::TwapPlaced { id: 4, acct: B256::ZERO, market: 0, isBuy: true, total: 10, slices: 2, interval: 5, slippageBps: 1, reduceOnly: false };
        assert_eq!(decode_log(&mk(t.encode_log_data())), Some(Event::TwapPlaced { id: 4 }));
        assert_eq!(decode_log(&mk(IPerp::TwapDone { id: 4, filled: 1, failed: 0 }.encode_log_data())), Some(Event::TwapGone { id: 4 }));
        assert_eq!(decode_log(&mk(IPerp::TwapCanceled { id: 4, filled: 1 }.encode_log_data())), Some(Event::TwapGone { id: 4 }));
    }

    #[test]
    fn unknown_log_ignored() {
        let l = mk(alloy::primitives::LogData::new_unchecked(vec![B256::repeat_byte(1)], Default::default()));
        assert_eq!(decode_log(&l), None);
    }

    #[test]
    fn ranges_chunk_and_stop() {
        assert_eq!(next_range(0, 10, 4), Some((0, 3)));
        assert_eq!(next_range(8, 10, 4), Some((8, 10)));
        assert_eq!(next_range(11, 10, 4), None);
        assert_eq!(next_range(5, 5, 2000), Some((5, 5)));
    }

    // ------------------------------------------------------------------ reorg simulation
    use std::sync::Mutex;

    /// A canonical chain as a list of blocks; each block = (hash, logs). Genesis (block 0) has no logs.
    #[derive(Clone)]
    struct FakeChain {
        blocks: Vec<(B256, Vec<alloy::primitives::LogData>)>,
        parents: Vec<B256>,
    }

    fn hash_of(tag: u8, n: u64) -> B256 {
        let mut b = [0u8; 32];
        b[0] = tag;
        b[24..].copy_from_slice(&n.to_be_bytes());
        B256::from(b)
    }

    impl FakeChain {
        /// `tag` salts hashes so two forks never collide; blocks below `fork_at` use tag 0 (shared history).
        fn build(fork_at: u64, tag: u8, len: u64, events: &dyn Fn(u64) -> Vec<alloy::primitives::LogData>) -> FakeChain {
            let mut blocks = vec![];
            let mut parents = vec![];
            for n in 0..len {
                let t = if n < fork_at { 0 } else { tag };
                parents.push(if n == 0 { B256::ZERO } else { blocks.last().map(|b: &(B256, _)| b.0).unwrap() });
                blocks.push((hash_of(t, n), if n == 0 { vec![] } else { events(n) }));
            }
            FakeChain { blocks, parents }
        }
    }

    struct FakeSource(Mutex<FakeChain>);
    impl FakeSource {
        fn set(&self, c: FakeChain) { *self.0.lock().unwrap() = c; }
    }
    impl ScanSource for FakeSource {
        async fn header(&self, n: u64) -> Result<Option<(B256, B256)>> {
            let c = self.0.lock().unwrap();
            Ok(c.blocks.get(n as usize).map(|b| (b.0, c.parents[n as usize])))
        }
        async fn logs(&self, from: u64, to: u64) -> Result<Vec<Log>> {
            let c = self.0.lock().unwrap();
            let mut out = vec![];
            for n in from..=to.min(c.blocks.len() as u64 - 1) {
                for (i, d) in c.blocks[n as usize].1.iter().enumerate() {
                    out.push(Log {
                        inner: alloy::primitives::Log { address: Address::ZERO, data: d.clone() },
                        block_number: Some(n),
                        block_hash: Some(c.blocks[n as usize].0),
                        log_index: Some(i as u64),
                        ..Default::default()
                    });
                }
            }
            Ok(out)
        }
    }

    fn deposit(a: u8) -> alloy::primitives::LogData {
        IPerp::Deposit { acct: B256::repeat_byte(a), from: Address::ZERO, amount: alloy::primitives::U256::from(1) }.encode_log_data()
    }
    fn cond_placed(id: u64) -> alloy::primitives::LogData {
        IPerp::CondPlaced { id, acct: B256::ZERO, market: 0, isBuy: true, above: true, trigger: 5, limit: 1, size: 1, reduceOnly: false, sibling: 0 }.encode_log_data()
    }
    fn cond_done(id: u64) -> alloy::primitives::LogData { IPerp::CondTriggered { id, markPrice: 1 }.encode_log_data() }

    #[test]
    fn common_ancestor_search() {
        let stored: BTreeMap<u64, B256> = (5..=9).map(|n| (n, hash_of(0, n))).collect();
        // canonical chain forked at 8
        let canon = |n: u64| Some(if n >= 8 { hash_of(1, n) } else { hash_of(0, n) });
        assert_eq!(find_common_ancestor(&stored, canon), Some(7));
        assert_eq!(find_common_ancestor(&stored, |_| None), None);
        assert_eq!(find_common_ancestor(&stored, |n| Some(hash_of(0, n))), Some(9));
    }

    /// Chain A: block 3 deposits acct 1, block 4 places cond 10, block 6 deposits acct 2 and places cond 11,
    /// block 8 triggers cond 10 and deposits acct 3.   Chain B forks at 6: acct 2/cond 11 never happen, cond 10 is
    /// NOT triggered, block 7 deposits acct 4, block 9 places cond 12.
    #[test]
    fn simulated_reorg_rolls_back_to_the_common_ancestor_and_matches_a_fresh_scan() {
        let ev_a = |n: u64| match n {
            3 => vec![deposit(1)],
            4 => vec![cond_placed(10)],
            6 => vec![deposit(2), cond_placed(11)],
            8 => vec![cond_done(10), deposit(3)],
            _ => vec![],
        };
        let ev_b = |n: u64| match n {
            3 => vec![deposit(1)],
            4 => vec![cond_placed(10)],
            7 => vec![deposit(4)],
            9 => vec![cond_placed(12)],
            _ => vec![],
        };
        let a = FakeChain::build(u64::MAX, 0, 11, &ev_a); // blocks 0..=10
        let b = FakeChain::build(6, 1, 13, &ev_b); // shares 0..=5, differs from 6, longer (0..=12)
        let backstop = B256::repeat_byte(0xff);
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async {
            let src = FakeSource(Mutex::new(a));
            let mut st = State::new("0xabc".into(), 1);
            let r = scan_with(&src, &mut st, 10, &backstop, 4, 16).await.unwrap();
            assert_eq!(r.rolled_back_to, None);
            assert_eq!(st.next_block, 11);
            assert!(st.accounts.contains_key(&B256::repeat_byte(2)) && st.accounts.contains_key(&B256::repeat_byte(3)));
            assert!(st.conds.contains_key(&11) && !st.conds.contains_key(&10), "cond 10 was triggered on chain A");

            // no reorg: a second scan with the same chain is a no-op
            let r = scan_with(&src, &mut st, 10, &backstop, 4, 16).await.unwrap();
            assert_eq!(r, ScanReport::default());

            // the chain reorgs: B shares 0..=5
            src.set(b.clone());
            let r = scan_with(&src, &mut st, 12, &backstop, 4, 16).await.unwrap();
            assert_eq!(r.rolled_back_to, Some(5));
            assert_eq!(r.reorg_depth, 5);
            assert_eq!(st.next_block, 13);

            // identical to a clean scan of chain B
            let mut fresh = State::new("0xabc".into(), 1);
            scan_with(&src, &mut fresh, 12, &backstop, 4, 16).await.unwrap();
            assert_eq!(st.accounts.keys().collect::<Vec<_>>(), fresh.accounts.keys().collect::<Vec<_>>());
            assert_eq!(st.conds, fresh.conds);
            assert_eq!(st.twaps, fresh.twaps);
            assert!(st.conds.contains_key(&10), "cond 10 is active again (its trigger was reorged out)");
            assert!(!st.conds.contains_key(&11) && st.conds.contains_key(&12));
            assert!(!st.accounts.contains_key(&B256::repeat_byte(2)) && st.accounts.contains_key(&B256::repeat_byte(4)));
            assert_eq!(st.hashes.get(&12), Some(&b.blocks[12].0));
        });
    }

    #[test]
    fn reorg_deeper_than_the_window_rolls_back_the_whole_window() {
        let ev = |n: u64| if n == 2 { vec![deposit(1)] } else if n == 9 { vec![deposit(2)] } else { vec![] };
        let a = FakeChain::build(u64::MAX, 0, 11, &ev);
        let b = FakeChain::build(1, 1, 11, &|n| if n == 9 { vec![deposit(5)] } else { vec![] }); // fork at 1: everything differs
        let backstop = B256::repeat_byte(0xff);
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            let src = FakeSource(Mutex::new(a));
            let mut st = State::new("0xabc".into(), 1);
            scan_with(&src, &mut st, 10, &backstop, 100, 4).await.unwrap(); // window 4 => hashes 7..=10 only
            assert_eq!(st.hashes.keys().copied().collect::<Vec<_>>(), vec![7, 8, 9, 10]);
            src.set(b);
            let r = scan_with(&src, &mut st, 10, &backstop, 100, 4).await.unwrap();
            assert_eq!(r.rolled_back_to, Some(6)); // window start - 1
            // account 2 (block 9, inside the window) is gone, account 5 (new chain) found; block-2 account is outside the window and stays
            assert!(!st.accounts.contains_key(&B256::repeat_byte(2)));
            assert!(st.accounts.contains_key(&B256::repeat_byte(5)));
            assert!(st.accounts.contains_key(&B256::repeat_byte(1)));
        });
    }

    #[test]
    fn reorg_during_scan_is_retried_not_committed() {
        // chain whose block 5's recorded parent does not match block 4's hash => scan must stop without advancing past it
        let mut c = FakeChain::build(u64::MAX, 0, 8, &|_| vec![]);
        let backstop = B256::repeat_byte(0xff);
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            let src = FakeSource(Mutex::new(c.clone()));
            let mut st = State::new("0xabc".into(), 1);
            scan_with(&src, &mut st, 3, &backstop, 100, 16).await.unwrap();
            assert_eq!(st.next_block, 4);
            c.parents[5] = B256::repeat_byte(0xee); // inconsistent: blocks 4..=7 cannot be verified as one chain
            c.parents[4] = st.hashes[&3]; // 4 itself links fine
            src.set(c);
            scan_with(&src, &mut st, 7, &backstop, 100, 16).await.unwrap();
            assert_eq!(st.next_block, 4, "nothing committed from an inconsistent chunk");
        });
    }
}
