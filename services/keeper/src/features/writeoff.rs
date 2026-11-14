//! Feature 7: permissionless `writeOff(account, market)` for accounts that are FLAT and NEGATIVE.
//!
//! The contract records such a loss itself in liquidations, delist settlement and ordinary fills (LEDGER-1), so this is the
//! backstop sweep for losses that could otherwise sit unrecorded (LIQ-2): insurance covers the deficit first, the rest becomes
//! `unresolvedBadDebt` / `adlDebt[market]`, which the ADL feature then clears. The call cannot touch a healthy or non-negative
//! bucket (it reverts `nothing to write off`), so a wrong guess is harmless. It pays the keeper NOTHING on-chain, therefore the
//! profitability gate is a gas BUDGET: send only if the estimated gas cost <= `writeoff_max_gas_usd` (or `--force-unprofitable`).
//!
//! Detection (views only, then `eth_call` simulation as the final authority):
//!   * isolated bucket: `positions(a,m)` has `isolated && size == 0 && isoMargin < 0`;
//!   * cross bucket: no open cross position and `accountState(a).equity < 0`.
//!     The cross loss is booked to one market's `adlDebt`: the first non-isolated market where the backstop holds inventory
//!     (ADL needs it), else the first non-isolated market.
use crate::{
    abi::IPerp,
    actions::{Ctx, Outcome},
    chain::CallErr,
    errors::RevertKind,
    profit::usd_to_micro,
    state::State,
};
use alloy::{
    primitives::{Bytes, B256, I256, U256},
    sol_types::SolCall,
};
use std::collections::BTreeSet;
use tracing::{debug, info};

/// One `positions(a, m)` read, reduced to what the sweep needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PosView {
    pub market: u8,
    pub size: I256,
    pub isolated: bool,
    pub iso_margin: I256,
}

/// Markets to call `writeOff(acct, market)` for. `cross_equity` is `accountState(a).equity` (only consulted when the account
/// holds no cross position); `backstop_open` lists markets in which the backstop holds a position.
pub fn plan(pos: &[PosView], cross_equity: Option<I256>, backstop_open: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = pos.iter().filter(|p| p.isolated && p.size.is_zero() && p.iso_margin.is_negative()).map(|p| p.market).collect();
    let has_cross_position = pos.iter().any(|p| !p.isolated && !p.size.is_zero());
    if !has_cross_position && cross_equity.is_some_and(|e| e.is_negative()) {
        let free = |p: &&PosView| !p.isolated;
        let pick = pos.iter().filter(free).find(|p| backstop_open.contains(&p.market)).or_else(|| pos.iter().find(free));
        if let Some(p) = pick {
            out.push(p.market);
        }
    }
    out
}

/// True when a mined/simulated outcome means this account needs no further check right now.
fn settled(o: &Outcome) -> bool {
    match o {
        Outcome::Sent(_) => true,
        Outcome::Reverted(k) => !matches!(k, RevertKind::OracleDegraded | RevertKind::MarketRestricted),
        _ => false,
    }
}

pub async fn run(ctx: &Ctx, state: &mut State, n_markets: u8, backstop: B256) {
    let accts = state.writeoff_pending();
    if accts.is_empty() || n_markets == 0 {
        return;
    }
    let budget = usd_to_micro(ctx.cfg.writeoff_max_gas_usd);
    let reward = U256::from(budget) + U256::from(usd_to_micro(ctx.cfg.min_profit_usd));

    // backstop inventory per market (so the cross loss lands where ADL can act)
    let mut backstop_open = vec![];
    for m in 0..n_markets {
        if let Ok(p) = ctx.chain.position(backstop, m).await {
            if !p.size.is_zero() {
                backstop_open.push(m);
            }
        }
    }

    let reqs: Vec<(B256, u8)> = accts.iter().flat_map(|a| (0..n_markets).map(move |m| (*a, m))).collect();
    let results = ctx.chain.read_positions(&reqs).await;
    let width = n_markets as usize;
    let mut sent = 0usize;
    for ((chunk_reqs, chunk_res), acct) in reqs.chunks(width).zip(results.chunks(width)).zip(accts.iter()) {
        let mut views = vec![];
        let mut ok = true;
        for ((_, m), r) in chunk_reqs.iter().zip(chunk_res) {
            match r {
                Ok(p) => views.push(PosView { market: *m, size: p.size, isolated: p.isolated, iso_margin: p.isoMargin }),
                Err(e) => {
                    debug!(%acct, market = *m, error = %e, "write-off: position read failed; will retry");
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        let has_cross = views.iter().any(|p| !p.isolated && !p.size.is_zero());
        let mut cross_equity = None;
        if !has_cross {
            match ctx.chain.account_state(*acct).await {
                Ok(s) => cross_equity = Some(s.equity),
                Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                    ctx.metrics.oracle_waits.inc();
                    info!(%acct, "write-off: accountState reverted OracleDegraded; waiting");
                    continue;
                }
                Err(e) => {
                    debug!(%acct, error = %e, "write-off: accountState failed; will retry");
                    continue;
                }
            }
        }
        let markets: BTreeSet<u8> = plan(&views, cross_equity, &backstop_open).into_iter().collect();
        let mut done = true;
        for m in markets {
            if sent >= ctx.cfg.max_actions_per_tick {
                done = false;
                break;
            }
            let data = Bytes::from(IPerp::writeOffCall { a: *acct, market: m }.abi_encode());
            let detail = format!("acct={acct} market={m}");
            let out = ctx.submit_gated("write_off", &detail, data, Some(reward)).await;
            if out.is_sent() {
                sent += 1;
                info!(%acct, market = m, "write-off sent");
            }
            if !settled(&out) {
                done = false;
            }
        }
        if done {
            if let Some(meta) = state.accounts.get_mut(acct) {
                meta.check_writeoff = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i(n: i64) -> I256 { I256::try_from(n).unwrap() }
    fn flat(market: u8) -> PosView { PosView { market, size: i(0), isolated: false, iso_margin: i(0) } }
    fn iso_flat(market: u8, margin: i64) -> PosView { PosView { market, size: i(0), isolated: true, iso_margin: i(margin) } }

    #[test]
    fn healthy_or_zero_balance_needs_nothing() {
        assert!(plan(&[flat(0), flat(1)], Some(i(0)), &[]).is_empty());
        assert!(plan(&[flat(0), flat(1)], Some(i(5)), &[]).is_empty());
        assert!(plan(&[flat(0)], None, &[]).is_empty());
    }

    #[test]
    fn negative_flat_cross_account_books_to_the_market_where_the_backstop_holds_inventory() {
        assert_eq!(plan(&[flat(0), flat(1), flat(2)], Some(i(-7)), &[2]), vec![2]);
        assert_eq!(plan(&[flat(0), flat(1), flat(2)], Some(i(-7)), &[]), vec![0]);
    }

    #[test]
    fn open_cross_position_is_the_liquidators_job() {
        let open = PosView { market: 1, size: i(3), isolated: false, iso_margin: i(0) };
        assert!(plan(&[flat(0), open], Some(i(-7)), &[1]).is_empty());
    }

    #[test]
    fn cross_loss_never_uses_a_market_whose_bucket_is_isolated() {
        assert_eq!(plan(&[iso_flat(0, 10), flat(1)], Some(i(-1)), &[0]), vec![1]);
        assert!(plan(&[iso_flat(0, 10)], Some(i(-1)), &[0]).is_empty());
    }

    #[test]
    fn isolated_flat_negative_margin_is_written_off_per_market() {
        assert_eq!(plan(&[iso_flat(0, -5), iso_flat(1, 5), iso_flat(2, -1)], Some(i(0)), &[]), vec![0, 2]);
        // an isolated position that still has size is not flat
        let open_iso = PosView { market: 0, size: i(2), isolated: true, iso_margin: i(-5) };
        assert!(plan(&[open_iso], None, &[]).is_empty());
    }

    #[test]
    fn settled_outcomes() {
        assert!(settled(&Outcome::Reverted(RevertKind::BadParam("nothing to write off".into()))));
        assert!(!settled(&Outcome::Reverted(RevertKind::OracleDegraded)));
        assert!(!settled(&Outcome::Unprofitable));
        assert!(!settled(&Outcome::DryRun));
    }
}
