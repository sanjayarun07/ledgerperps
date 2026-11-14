//! Feature 2: find accounts with equity < maintenance margin and liquidate them.
//! Safety: never acts when the oracle is unreadable (`OracleDegraded` = wait). Every send is preceded by eth_call.
use crate::{
    abi::IPerp,
    actions::{Ctx, Marks, Outcome},
    chain::CallErr,
    errors::RevertKind,
    state::State,
};
use alloy::{
    primitives::{Bytes, B256, I256, U256},
    sol_types::SolCall,
};
use crate::profit::keeper_reward;
use std::time::Duration;
use tracing::{debug, info, warn};

/// Liquidatable iff equity < mm (matches `PerpLiquidation`: `eq >= mm` reverts NotLiquidatable).
pub fn is_underwater(equity: I256, mm: U256) -> bool {
    match I256::try_from(mm) {
        Ok(mm) => equity < mm,
        Err(_) => true, // mm beyond i256 range: any representable equity is below it
    }
}

/// For a cross-margined account `liquidate` only closes part of ONE market. Pick the largest notional (|size| * mark);
/// ties go to the lowest market id. Returns None if there is no position.
pub fn pick_cross_market(positions: &[(u8, I256, U256)]) -> Option<u8> {
    positions
        .iter()
        .filter(|(_, s, _)| !s.is_zero())
        .map(|(m, s, mark)| (*m, s.unsigned_abs().saturating_mul(*mark)))
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
        .map(|(m, _)| m)
}

/// `(market, signed size, isolated)` per open position.
type OpenPositions = Vec<(u8, I256, bool)>;

#[derive(Debug, PartialEq, Eq)]
pub struct Candidate {
    pub acct: B256,
    pub market: u8,
    /// |position size| in `market` (used to estimate the keeper reward).
    pub size_abs: U256,
}

/// Uniform random delay in `0..=max_ms` from a raw random word (`rand` = any uniformly distributed u64).
pub fn jitter_delay(max_ms: u64, rand: u64) -> Duration {
    if max_ms == 0 { Duration::ZERO } else { Duration::from_millis(rand % (max_ms + 1)) }
}

fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new().build_hasher().finish()
}

/// Refresh positions of active accounts, evaluate health and return liquidation candidates.
/// All per-account reads are batched (Multicall3, or bounded-parallel `eth_call`s as a fallback).
pub async fn find_candidates(ctx: &Ctx, state: &mut State, marks: &mut Marks, n_markets: u8) -> Vec<Candidate> {
    let mut out = vec![];
    let accts = state.active_accounts();
    if accts.is_empty() {
        return out;
    }

    // 1) refresh positions: one batch for (account x market)
    let reqs: Vec<(B256, u8)> = accts.iter().flat_map(|a| (0..n_markets).map(move |m| (*a, m))).collect();
    let results = ctx.chain.read_positions(&reqs).await;
    let mut per_acct: Vec<(B256, OpenPositions)> = vec![];
    for (chunk_reqs, chunk_res) in reqs.chunks(n_markets.max(1) as usize).zip(results.chunks(n_markets.max(1) as usize)) {
        let acct = chunk_reqs[0].0;
        let mut open = vec![];
        let mut ok = true;
        for ((_, m), r) in chunk_reqs.iter().zip(chunk_res) {
            match r {
                Ok(p) => {
                    if !p.size.is_zero() {
                        open.push((*m, p.size, p.isolated));
                    }
                }
                Err(e) => {
                    debug!(%acct, market = *m, error = %e, "position read failed");
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        if let Some(meta) = state.accounts.get_mut(&acct) {
            meta.open = open.iter().map(|(m, _, _)| *m).collect();
            meta.dirty = false;
        }
        if !open.is_empty() {
            per_acct.push((acct, open));
        }
    }

    // 2) health: one batch for cross accounts, one for isolated positions
    let cross_accts: Vec<B256> = per_acct.iter().filter(|(_, o)| o.iter().any(|(_, _, iso)| !iso)).map(|(a, _)| *a).collect();
    let cross_states = ctx.chain.read_account_states(&cross_accts).await;
    let iso_reqs: Vec<(B256, u8)> = per_acct.iter().flat_map(|(a, o)| o.iter().filter(|(_, _, iso)| *iso).map(move |(m, _, _)| (*a, *m))).collect();
    let iso_states = ctx.chain.read_iso_states(&iso_reqs).await;

    // 3) evaluate cross accounts (single equity over all non-isolated positions)
    for (acct, res) in cross_accts.iter().zip(cross_states) {
        let open = &per_acct.iter().find(|(a, _)| a == acct).expect("listed above").1;
        match res {
            Ok(s) => {
                if is_underwater(s.equity, s.mm) {
                    let mut view = vec![];
                    let mut stale = false;
                    for (m, size, iso) in open.iter().filter(|(_, _, iso)| !iso) {
                        let _ = iso;
                        match marks.get(ctx, *m).await {
                            Some(mk) => view.push((*m, *size, mk)),
                            None => stale = true,
                        }
                    }
                    if stale {
                        info!(%acct, "cross account looks underwater but a mark is unavailable: waiting");
                    } else if let Some(market) = pick_cross_market(&view) {
                        let size_abs = view.iter().find(|(m, _, _)| *m == market).map(|(_, s, _)| s.unsigned_abs()).unwrap_or_default();
                        info!(%acct, equity = %s.equity, mm = %s.mm, market, "cross account underwater");
                        out.push(Candidate { acct: *acct, market, size_abs });
                    }
                }
            }
            Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                ctx.metrics.oracle_waits.inc();
                info!(%acct, "accountState reverted OracleDegraded: waiting");
            }
            Err(e) => debug!(%acct, error = %e, "accountState failed"),
        }
    }

    // 4) isolated positions are judged per market
    for ((acct, m), res) in iso_reqs.iter().zip(iso_states) {
        match res {
            Ok(s) => {
                if is_underwater(s.equity, s.mm) {
                    info!(%acct, market = *m, equity = %s.equity, mm = %s.mm, "isolated position underwater");
                    let size_abs = per_acct
                        .iter()
                        .find(|(a, _)| a == acct)
                        .and_then(|(_, o)| o.iter().find(|(mm, _, _)| mm == m))
                        .map(|(_, s, _)| s.unsigned_abs())
                        .unwrap_or_default();
                    out.push(Candidate { acct: *acct, market: *m, size_abs });
                }
            }
            Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                ctx.metrics.oracle_waits.inc();
                info!(%acct, market = *m, "isoState reverted OracleDegraded: waiting");
            }
            Err(e) => debug!(%acct, error = %e, "isoState failed"),
        }
    }
    out
}

pub async fn run(ctx: &Ctx, state: &mut State, marks: &mut Marks, n_markets: u8) {
    let cands = find_candidates(ctx, state, marks, n_markets).await;
    if cands.is_empty() {
        return;
    }
    // Reward model inputs (public getters). Unreadable => no gate (see Ctx::submit_gated).
    let params = match ctx.chain.liq_params().await {
        Ok(p) => Some(p),
        Err(e) => {
            warn!(error = %e, "could not read liqFeeBps/keeperShareBps/closeFactorBps/fullCloseNotional: profitability gate disabled this cycle");
            None
        }
    };
    for c in cands.into_iter().take(ctx.cfg.max_actions_per_tick) {
        // Explicit oracle gate (belt and braces: the simulation also reverts OracleDegraded).
        let Some(mark) = marks.get(ctx, c.market).await else {
            warn!(acct = %c.acct, market = c.market, "oracle unavailable for market: not liquidating");
            continue;
        };
        let reward = match (&params, ctx.chain.market_info(c.market).await) {
            (Some(p), Ok(mi)) => Some(keeper_reward(c.size_abs, mark, mi.lot, p)),
            (Some(_), Err(e)) => {
                warn!(market = c.market, error = %e, "could not read market lot: profitability gate disabled for this liquidation");
                None
            }
            _ => None,
        };
        let data = Bytes::from(IPerp::liquidateCall { a: c.acct, market: c.market }.abi_encode());
        let detail = format!("acct={} market={}", c.acct, c.market);
        let jitter = jitter_delay(ctx.cfg.submit_jitter_ms, random_u64());
        if !jitter.is_zero() {
            debug!(?jitter, "jittering liquidation submission");
            tokio::time::sleep(jitter).await;
        }
        let out = ctx.submit_gated("liquidate", &detail, data, reward).await;
        if out.is_sent() {
            ctx.metrics.liquidations_sent.inc();
            info!(acct = %c.acct, market = c.market, "liquidation sent");
            if let Some(meta) = state.accounts.get_mut(&c.acct) {
                meta.dirty = true;
                meta.check_writeoff = true;
            }
        } else if let Outcome::Reverted(RevertKind::NotLiquidatable) = out {
            debug!(acct = %c.acct, "no longer liquidatable");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i(n: i64) -> I256 { I256::try_from(n).unwrap() }
    fn u(n: u64) -> U256 { U256::from(n) }

    #[test]
    fn underwater_is_strictly_below_mm() {
        assert!(is_underwater(i(99), u(100)));
        assert!(!is_underwater(i(100), u(100))); // equal is healthy (contract: eq >= mm reverts)
        assert!(!is_underwater(i(101), u(100)));
        assert!(is_underwater(i(-5), u(0))); // negative equity
        assert!(!is_underwater(i(0), u(0)));
    }

    #[test]
    fn pick_largest_notional_lowest_id_on_tie() {
        // market 0: 1 * 50, market 1: -3 * 30 = 90, market 2: 9 * 10 = 90
        let v = vec![(0, i(1), u(50)), (1, i(-3), u(30)), (2, i(9), u(10))];
        assert_eq!(pick_cross_market(&v), Some(1));
        assert_eq!(pick_cross_market(&[(0, i(0), u(5))]), None);
        assert_eq!(pick_cross_market(&[]), None);
    }

    #[test]
    fn jitter_bounds() {
        assert_eq!(jitter_delay(0, 12345), Duration::ZERO);
        assert_eq!(jitter_delay(100, 0), Duration::ZERO);
        assert_eq!(jitter_delay(100, 100), Duration::from_millis(100));
        assert_eq!(jitter_delay(100, 101), Duration::ZERO);
        for r in [1u64, 77, u64::MAX, u64::MAX - 1] {
            assert!(jitter_delay(250, r) <= Duration::from_millis(250));
        }
    }
}
