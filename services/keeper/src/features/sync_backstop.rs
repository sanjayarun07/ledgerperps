//! Feature 8: permissionless `syncBackstop()` (BACKSTOP-1 phase 1).
//!
//! The backstop takes inventory at mark; when the mark moves against it the loss is NOT recorded until someone syncs. `syncBackstop`
//! is idempotent: with negative equity it charges the deficit to insurance first and records the rest as `unresolvedBadDebt` /
//! `adlDebt` / `bsDebt` (which ADL then clears); with positive equity it repays earlier draws. `withdraw`, `liquidate`, `adl` and
//! `settleDelisted` sync internally, so this job just makes sure the loss is recorded soon, before the next user action.
//!
//! When it runs: every `sync_backstop_interval_secs`, and immediately whenever any market's mark changed since the previous check while
//! the backstop holds inventory (an oracle update). Then it reads `backstopEquity`, `bsInsDrawn`, `bsDebt` and sends only if the
//! contract would actually change something (`plan`). It pays the keeper nothing: the profitability gate is a gas BUDGET
//! (`sync_backstop_max_gas_usd`, `--force-unprofitable` overrides). Every send is `eth_call`-simulated first; dry-run never sends.
use crate::{
    abi::IPerp,
    actions::{Ctx, Outcome},
    chain::CallErr,
    errors::RevertKind,
    profit::usd_to_micro,
};
use alloy::{
    primitives::{Bytes, B256, I256, U256},
    sol_types::SolCall,
};
use std::{collections::HashMap, time::{Duration, Instant}};
use tracing::{debug, info};

/// Per-keeper memory between ticks.
#[derive(Default)]
pub struct SyncState {
    last_check: Option<Instant>,
    last_marks: HashMap<u8, U256>,
}

/// True when the check should run now: the periodic interval elapsed, or a mark moved while the backstop holds inventory.
pub fn check_due(since_last: Option<Duration>, interval: Duration, mark_changed: bool, backstop_has_inventory: bool) -> bool {
    match since_last {
        None => true,
        Some(d) => d >= interval || (mark_changed && backstop_has_inventory),
    }
}

/// True when `syncBackstop` would change state: a deficit to record (equity < 0), or positive equity with earlier draws to repay.
pub fn plan(equity: I256, ins_drawn: U256, bs_debt: U256) -> bool {
    equity.is_negative() || (equity.is_positive() && (!ins_drawn.is_zero() || !bs_debt.is_zero()))
}

pub async fn run(ctx: &Ctx, st: &mut SyncState, n_markets: u8, backstop: B256) {
    let interval = Duration::from_secs(ctx.cfg.sync_backstop_interval_secs);
    // cheap trigger inputs: backstop inventory + current marks
    let mut has_inventory = false;
    let mut changed = false;
    for m in 0..n_markets {
        if let Ok(p) = ctx.chain.position(backstop, m).await {
            if !p.size.is_zero() {
                has_inventory = true;
            }
        }
        if let Ok(mk) = ctx.chain.mark_price(m).await {
            if st.last_marks.insert(m, mk).is_some_and(|prev| prev != mk) {
                changed = true;
            }
        }
    }
    if !check_due(st.last_check.map(|t| t.elapsed()), interval, changed, has_inventory) {
        return;
    }
    let equity = match ctx.chain.backstop_equity().await {
        Ok(e) => e,
        Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
            ctx.metrics.oracle_waits.inc();
            info!("sync-backstop: backstopEquity reverted OracleDegraded; waiting (checked again next tick)");
            return; // keep last_check so the next tick retries
        }
        Err(e) => {
            debug!(error = %e, "sync-backstop: backstopEquity failed");
            return;
        }
    };
    st.last_check = Some(Instant::now());
    let (drawn, debt) = (ctx.chain.bs_ins_drawn().await.unwrap_or_default(), ctx.chain.bs_debt().await.unwrap_or_default());
    if !plan(equity, drawn, debt) {
        return;
    }
    let budget = U256::from(usd_to_micro(ctx.cfg.sync_backstop_max_gas_usd)) + U256::from(usd_to_micro(ctx.cfg.min_profit_usd));
    let detail = format!("equity={equity} ins_drawn={drawn} bs_debt={debt}");
    let data = Bytes::from(IPerp::syncBackstopCall {}.abi_encode());
    let out = ctx.submit_gated("sync_backstop", &detail, data, Some(budget)).await;
    match out {
        Outcome::Sent(_) => info!(%detail, "syncBackstop sent"),
        Outcome::Unprofitable | Outcome::DryRun => {
            st.last_check = None; // not done: look again next tick
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i(n: i64) -> I256 { I256::try_from(n).unwrap() }
    fn u(n: u64) -> U256 { U256::from(n) }

    #[test]
    fn plans_only_when_the_contract_would_change_something() {
        assert!(plan(i(-1), u(0), u(0)), "deficit to record");
        assert!(!plan(i(0), u(5), u(5)), "zero equity: nothing to record or repay");
        assert!(!plan(i(10), u(0), u(0)), "positive equity but nothing was drawn");
        assert!(plan(i(10), u(3), u(0)), "repay insurance draws");
        assert!(plan(i(10), u(0), u(3)), "repay backstop-originated debt");
    }

    #[test]
    fn due_on_interval_or_on_mark_move_with_inventory() {
        let iv = Duration::from_secs(60);
        assert!(check_due(None, iv, false, false), "first tick always checks");
        assert!(!check_due(Some(Duration::from_secs(5)), iv, false, true), "no move: wait for the interval");
        assert!(check_due(Some(Duration::from_secs(60)), iv, false, false), "interval elapsed");
        assert!(check_due(Some(Duration::from_secs(5)), iv, true, true), "oracle update while holding inventory");
        assert!(!check_due(Some(Duration::from_secs(5)), iv, true, false), "mark moved but the backstop is flat");
    }
}
