//! Feature 1: poke funding for every market on an interval. Reverts are skipped (not failures).
use crate::{abi::IPerp, actions::{Ctx, Outcome}};
use alloy::{primitives::Bytes, sol_types::SolCall};
use std::{collections::HashMap, time::{Duration, Instant}};

/// Due when never run, or when at least `interval_secs` have elapsed since the last run.
pub fn funding_due(since_last: Option<Duration>, interval_secs: u64) -> bool {
    match since_last {
        None => true,
        Some(d) => d >= Duration::from_secs(interval_secs),
    }
}

/// Fallback cadence when a market's `fundingInterval` cannot be read.
pub const DEFAULT_INTERVAL_SECS: u64 = 300;

/// Effective poke interval: the operator override if set, else the market's own `fundingInterval` (never 0).
pub fn effective_interval(override_secs: Option<u64>, market_interval: Option<u32>) -> u64 {
    override_secs.or(market_interval.map(u64::from)).unwrap_or(DEFAULT_INTERVAL_SECS).max(1)
}

/// Poke every market whose own interval has elapsed since *its* last poke. `last` is the per-market clock.
pub async fn run(ctx: &Ctx, n_markets: u8, last: &mut HashMap<u8, Instant>) {
    for m in 0..n_markets {
        let mi = ctx.chain.market_info(m).await.ok().map(|i| i.funding_interval);
        let interval = effective_interval(ctx.cfg.funding_interval_secs, mi);
        if !funding_due(last.get(&m).map(|t| t.elapsed()), interval) {
            continue;
        }
        last.insert(m, Instant::now());
        let data = Bytes::from(IPerp::pokeFundingCall { m }.abi_encode());
        match ctx.submit("poke_funding", &format!("market={m} interval={interval}s"), data).await {
            Outcome::Sent(_) | Outcome::DryRun | Outcome::Reverted(_) | Outcome::Failed(_) | Outcome::Unprofitable => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_market_interval_selection() {
        assert_eq!(effective_interval(None, Some(3600)), 3600);
        assert_eq!(effective_interval(None, Some(60)), 60);
        assert_eq!(effective_interval(Some(5), Some(3600)), 5, "operator override wins");
        assert_eq!(effective_interval(None, None), DEFAULT_INTERVAL_SECS);
        assert_eq!(effective_interval(None, Some(0)), 1, "never zero");
        // two markets on different cadences become due at different times
        let t = |s| Some(Duration::from_secs(s));
        assert!(funding_due(t(61), effective_interval(None, Some(60))));
        assert!(!funding_due(t(61), effective_interval(None, Some(3600))));
    }

    #[test]
    fn due_logic() {
        assert!(funding_due(None, 300));
        assert!(!funding_due(Some(Duration::from_secs(299)), 300));
        assert!(funding_due(Some(Duration::from_secs(300)), 300));
    }
}
