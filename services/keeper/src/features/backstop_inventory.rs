//! Feature 9: backstop PHASE 2 inventory management (permissionless `pokeBackstop` and `unwindBackstop`).
//!
//! Per market the admin configures `backstopCfg(m)`; `softNotional == 0` means the whole feature is OFF for that market and the keeper
//! skips it (3 reads per market per check, at most every `backstop_inventory_interval_secs`).
//!
//! * `pokeBackstop(m)`: the contract only refreshes the elevation clock when something calls it with the current mark (liquidations and
//!   unwinds do it too). The keeper pokes when the inventory notional (`|backstop size| x mark`) is on the other side of `softNotional`
//!   than the stored clock says: above the threshold with no clock running (start the Dutch auction), or at/below it with a clock still
//!   running (relax). It is a no-op otherwise, so no gas is spent on idle markets.
//! * `unwindBackstop(targets, m)`: once a market has been elevated for `maxAge`, ranked profitable accounts on the side opposite the
//!   backstop are closed AT MARK against it. Candidates are screened like ADL (`adlHealth` slack, `adlScore > 0`), ranked by score
//!   (desc, ties by ascending key), at most 8, and the longest prefix that simulates is sent.
//!
//! Neither call pays the keeper anything on-chain, so both use a gas BUDGET gate (`poke_backstop_max_gas_usd`,
//! `unwind_backstop_max_gas_usd`; `--force-unprofitable` overrides). Every send is `eth_call`-simulated first; dry-run never sends.
//! `takeBackstop` (the Dutch auction taker side) is deliberately NOT a keeper job: it is trading, see `bots/src/backstop-taker.ts`.
use crate::{
    abi::IPerp,
    actions::{Ctx, Outcome},
    chain::CallErr,
    errors::RevertKind,
    features::adl::{has_slack, opposite_to_backstop, rank_candidates, MAX_TARGETS},
    profit::usd_to_micro,
    state::State,
};
use alloy::{
    primitives::{Bytes, B256, I256, U256},
    sol_types::SolCall,
};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// Position sizes carry 8 decimals (`SIZE_SCALE`), marks 6; notional is micro-USDC.
const SIZE_SCALE: u64 = 100_000_000;

#[derive(Default)]
pub struct InvState {
    last_check: Option<Instant>,
}

/// |size| x mark / SIZE_SCALE, floored (the contract's `_notionalFloor`).
pub fn notional(size: I256, mark: U256) -> U256 {
    size.unsigned_abs().saturating_mul(mark) / U256::from(SIZE_SCALE)
}

/// Poke only when the stored clock disagrees with the current notional (a poke would change state).
pub fn plan_poke(notional: U256, soft: U256, elevated_since: u64) -> bool {
    !soft.is_zero() && ((notional > soft) != (elevated_since != 0))
}

/// The contract's `unwindBackstop` gate: elevated and `now >= elevatedSince + maxAge`.
pub fn unwind_due(now: u64, elevated_since: u64, max_age: u32) -> bool {
    elevated_since != 0 && now >= elevated_since.saturating_add(max_age as u64)
}

fn unwind_calldata(targets: &[B256], m: u8) -> Bytes {
    Bytes::from(IPerp::unwindBackstopCall { targets: targets.to_vec(), market: m }.abi_encode())
}

pub async fn run(ctx: &Ctx, st: &mut InvState, state: &State, n_markets: u8, backstop_key: B256, now: u64) {
    let interval = Duration::from_secs(ctx.cfg.backstop_inventory_interval_secs);
    if st.last_check.is_some_and(|t| t.elapsed() < interval) {
        return;
    }
    st.last_check = Some(Instant::now());
    for m in 0..n_markets {
        let cfg = match ctx.chain.backstop_cfg(m).await {
            Ok(c) => c,
            Err(e) => {
                debug!(market = m, error = %e, "backstopCfg read failed (contract without phase 2?)");
                continue;
            }
        };
        let soft = U256::from(cfg.softNotional);
        if soft.is_zero() {
            continue; // feature off for this market
        }
        let bs = match ctx.chain.position(backstop_key, m).await {
            Ok(p) => p.size,
            Err(_) => continue,
        };
        let mark = match ctx.chain.mark_price(m).await {
            Ok(p) => p,
            Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                ctx.metrics.oracle_waits.inc();
                info!(market = m, "backstop inventory: oracle degraded, waiting");
                continue;
            }
            Err(e) => {
                debug!(market = m, error = %e, "markPrice failed");
                continue;
            }
        };
        let n = notional(bs, mark);
        let since = cfg.elevatedSince;
        if ctx.cfg.enable_poke_backstop && plan_poke(n, soft, since) {
            let budget = U256::from(usd_to_micro(ctx.cfg.poke_backstop_max_gas_usd)) + U256::from(usd_to_micro(ctx.cfg.min_profit_usd));
            let detail = format!("market={m} notional={n} soft={soft} elevated_since={since}");
            let data = Bytes::from(IPerp::pokeBackstopCall { market: m }.abi_encode());
            if let Outcome::Sent(_) = ctx.submit_gated("poke_backstop", &detail, data, Some(budget)).await {
                info!(%detail, "pokeBackstop sent");
            }
            continue; // the clock just changed; re-evaluate the unwind next check
        }
        if ctx.cfg.enable_unwind_backstop && unwind_due(now, since, cfg.maxAge) && !bs.is_zero() {
            unwind(ctx, state, m, bs, n, soft).await;
        }
    }
}

async fn unwind(ctx: &Ctx, state: &State, m: u8, bs: I256, n: U256, soft: U256) {
    if n <= soft {
        return; // already back under the threshold: the next poke relaxes it
    }
    let mut scored: Vec<(B256, U256)> = vec![];
    for (acct, meta) in &state.accounts {
        if !meta.open.contains(&m) {
            continue;
        }
        let Ok(p) = ctx.chain.position(*acct, m).await else { continue };
        if !opposite_to_backstop(p.size, bs) {
            continue;
        }
        match ctx.chain.adl_health(*acct, m).await {
            Ok(h) if !has_slack(h.eq, h.mm) => continue,
            Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                ctx.metrics.oracle_waits.inc();
                return;
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
                ctx.metrics.oracle_waits.inc();
                return;
            }
            Err(e) => debug!(%acct, error = %e, "adlScore failed"),
        }
    }
    let ranked = rank_candidates(scored, MAX_TARGETS);
    if ranked.is_empty() {
        warn!(market = m, %n, %soft, "backstop inventory is past maxAge but no profitable opposite-side account is known");
        return;
    }
    let mut chosen: Option<Vec<B256>> = None;
    for k in (1..=ranked.len()).rev() {
        if ctx.chain.simulate(&unwind_calldata(&ranked[..k], m)).await.is_ok() {
            chosen = Some(ranked[..k].to_vec());
            break;
        }
    }
    let Some(targets) = chosen else {
        warn!(market = m, candidates = ranked.len(), "unwindBackstop: no candidate prefix simulates successfully");
        return;
    };
    let budget = U256::from(usd_to_micro(ctx.cfg.unwind_backstop_max_gas_usd)) + U256::from(usd_to_micro(ctx.cfg.min_profit_usd));
    let detail = format!("market={m} notional={n} soft={soft} targets={}", targets.len());
    if let Outcome::Sent(_) = ctx.submit_gated("unwind_backstop", &detail, unwind_calldata(&targets, m), Some(budget)).await {
        info!(%detail, "unwindBackstop sent");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(n: u64) -> U256 { U256::from(n) }
    fn i(n: i64) -> I256 { I256::try_from(n).unwrap() }

    #[test]
    fn notional_is_abs_size_times_mark_over_scale() {
        // 1 BTC (1e8) at mark 50,000 (5e10 in 1e6 units) = 50,000 USDC = 5e10 micro-USDC
        assert_eq!(notional(i(100_000_000), u(50_000_000_000)), u(50_000_000_000));
        assert_eq!(notional(i(-100_000_000), u(50_000_000_000)), u(50_000_000_000), "short inventory counts the same");
        assert_eq!(notional(i(0), u(1)), u(0));
    }

    #[test]
    fn poke_only_when_the_clock_disagrees_with_the_notional() {
        assert!(plan_poke(u(11), u(10), 0), "above the cap and no clock: start the auction");
        assert!(!plan_poke(u(11), u(10), 5), "above the cap and clock running: nothing to do");
        assert!(plan_poke(u(10), u(10), 5), "at the cap counts as under it: relax");
        assert!(!plan_poke(u(3), u(10), 0), "under the cap, no clock");
        assert!(!plan_poke(u(11), u(0), 0), "softNotional == 0: feature off");
        assert!(!plan_poke(u(11), u(0), 5), "softNotional == 0: feature off, never poke from here");
    }

    #[test]
    fn unwind_due_only_after_max_age() {
        assert!(!unwind_due(1000, 0, 60), "not elevated");
        assert!(!unwind_due(1059, 1000, 60));
        assert!(unwind_due(1060, 1000, 60));
        assert!(unwind_due(u64::MAX, 1, u32::MAX));
    }

    #[test]
    fn unwind_calldata_matches_the_selector() {
        let d = unwind_calldata(&[B256::repeat_byte(1)], 2);
        assert_eq!(&d[..4], &IPerp::unwindBackstopCall::SELECTOR);
    }
}
