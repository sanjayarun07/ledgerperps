//! Feature 5: when `adlDebt(market) > 0`, rank profitable accounts on the side opposite the backstop and call `adl`.
//! The contract enforces: non-increasing score, ties by ASCENDING account key, max 8 targets, each must be in profit.
use crate::{
    abi::IPerp,
    actions::{Ctx, Outcome},
    chain::CallErr,
    errors::RevertKind,
    state::State,
};
use alloy::{
    primitives::{Bytes, B256, I256, U256},
    sol_types::SolCall,
};
use tracing::{debug, info, warn};

pub const MAX_TARGETS: usize = 8;

/// True when `size` is on the opposite side of the backstop's inventory (the only side ADL may close).
pub fn opposite_to_backstop(size: I256, backstop: I256) -> bool {
    !size.is_zero() && !backstop.is_zero() && (size.is_positive() != backstop.is_positive())
}

/// An ADL target must have slack above its maintenance requirement (`adlHealth`: equity > mm); the contract skips others with an
/// `AdlSkipped` event instead of reverting, which would only waste gas.
pub fn has_slack(eq: I256, mm: U256) -> bool {
    match I256::try_from(mm) {
        Ok(m) => eq > m,
        Err(_) => false,
    }
}

pub fn rank_candidates(mut c: Vec<(B256, U256)>, max: usize) -> Vec<B256> {
    c.retain(|(_, s)| !s.is_zero());
    c.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    c.into_iter().take(max).map(|(k, _)| k).collect()
}

fn calldata(targets: &[B256], market: u8) -> Bytes {
    Bytes::from(IPerp::adlCall { targets: targets.to_vec(), market }.abi_encode())
}

pub async fn run(ctx: &Ctx, state: &State, n_markets: u8, backstop_key: B256) -> usize {
    let mut markets_with_debt = 0;
    for m in 0..n_markets {
        let debt = match ctx.chain.adl_debt(m).await {
            Ok(d) => d,
            Err(e) => {
                debug!(market = m, error = %e, "adlDebt read failed");
                continue;
            }
        };
        if debt.is_zero() {
            continue;
        }
        markets_with_debt += 1;
        let bs = match ctx.chain.position(backstop_key, m).await {
            Ok(p) => p.size,
            Err(_) => continue,
        };
        if bs.is_zero() {
            debug!(market = m, "adl debt but backstop flat: nothing to deleverage against");
            continue;
        }
        // score every known account that holds this market on the opposite side
        let mut scored: Vec<(B256, U256)> = vec![];
        let mut oracle_wait = false;
        for (acct, meta) in &state.accounts {
            if !meta.open.contains(&m) {
                continue;
            }
            let Ok(p) = ctx.chain.position(*acct, m).await else { continue };
            if !opposite_to_backstop(p.size, bs) {
                continue;
            }
            match ctx.chain.adl_health(*acct, m).await {
                Ok(h) if !has_slack(h.eq, h.mm) => {
                    debug!(%acct, market = m, eq = %h.eq, mm = %h.mm, "adl: no slack above maintenance (contract would emit AdlSkipped); skipping");
                    continue;
                }
                Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                    oracle_wait = true;
                    break;
                }
                Err(e) => {
                    debug!(%acct, error = %e, "adlHealth failed");
                    continue;
                }
                Ok(_) => {}
            }
            match ctx.chain.adl_score(*acct, m).await {
                Ok(s) => scored.push((*acct, s)),
                Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                    oracle_wait = true;
                    break;
                }
                Err(e) => debug!(%acct, error = %e, "adlScore failed"),
            }
        }
        if oracle_wait {
            ctx.metrics.oracle_waits.inc();
            info!(market = m, "adl: oracle degraded, waiting");
            continue;
        }
        let ranked = rank_candidates(scored, MAX_TARGETS);
        if ranked.is_empty() {
            warn!(market = m, %debt, "adl debt outstanding but no profitable opposite-side account is known");
            continue;
        }
        // Pick the longest ranked prefix that simulates (a later target with "no room" would revert the whole call),
        // then fall back to single targets. Order within the list is preserved so ranking stays valid.
        let mut chosen: Option<Vec<B256>> = None;
        for k in (1..=ranked.len()).rev() {
            if ctx.chain.simulate(&calldata(&ranked[..k], m)).await.is_ok() {
                chosen = Some(ranked[..k].to_vec());
                break;
            }
        }
        if chosen.is_none() {
            for t in &ranked {
                if ctx.chain.simulate(&calldata(std::slice::from_ref(t), m)).await.is_ok() {
                    chosen = Some(vec![*t]);
                    break;
                }
            }
        }
        let Some(targets) = chosen else {
            warn!(market = m, candidates = ranked.len(), "adl: no candidate list simulates successfully");
            continue;
        };
        let detail = format!("market={m} debt={debt} targets={}", targets.len());
        if let Outcome::Sent(_) = ctx.submit("adl", &detail, calldata(&targets, m)).await {
            info!(market = m, targets = targets.len(), "adl executed");
        }
    }
    ctx.metrics.markets_with_adl_debt.set(markets_with_debt);
    markets_with_debt as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(n: u8) -> B256 { B256::repeat_byte(n) }
    fn u(n: u64) -> U256 { U256::from(n) }
    fn i(n: i64) -> I256 { I256::try_from(n).unwrap() }

    #[test]
    fn ranks_by_score_desc_ties_by_key_asc() {
        let r = rank_candidates(vec![(k(5), u(10)), (k(2), u(50)), (k(9), u(10)), (k(1), u(10)), (k(3), u(0))], 8);
        assert_eq!(r, vec![k(2), k(1), k(5), k(9)]);
    }

    #[test]
    fn caps_at_max_and_keeps_best() {
        let c: Vec<_> = (1..=12u8).map(|n| (k(n), u(n as u64))).collect();
        let r = rank_candidates(c, 8);
        assert_eq!(r.len(), 8);
        assert_eq!(r[0], k(12));
        assert_eq!(r[7], k(5));
    }

    #[test]
    fn max_score_ranks_first() {
        let r = rank_candidates(vec![(k(1), u(5)), (k(2), U256::MAX)], 8);
        assert_eq!(r, vec![k(2), k(1)]);
    }

    #[test]
    fn opposite_side() {
        assert!(opposite_to_backstop(i(-5), i(3)));
        assert!(opposite_to_backstop(i(5), i(-3)));
        assert!(!opposite_to_backstop(i(5), i(3)));
        assert!(!opposite_to_backstop(i(0), i(3)));
        assert!(!opposite_to_backstop(i(5), i(0)));
    }

    #[test]
    fn slack_is_equity_strictly_above_maintenance() {
        assert!(has_slack(i(101), u(100)));
        assert!(!has_slack(i(100), u(100)));
        assert!(!has_slack(i(-5), u(0)));
        assert!(!has_slack(i(1), u(2)));
    }

    #[test]
    fn empty_input() {
        assert!(rank_candidates(vec![], 8).is_empty());
    }
}
