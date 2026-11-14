//! Prometheus metrics + health state shared with the HTTP server.
use prometheus_client::{
    encoding::{text::encode, EncodeLabelSet},
    metrics::{counter::Counter, family::Family, gauge::Gauge},
    registry::Registry,
};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct KindLabel {
    pub kind: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ReasonLabel {
    pub kind: String,
    pub reason: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct FeedLabel {
    pub feed: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ResultLabel {
    pub result: String,
}

pub struct Metrics {
    registry: Registry,
    pub liquidations_sent: Counter,
    pub txs_sent: Family<KindLabel, Counter>,
    pub tx_failures: Family<KindLabel, Counter>,
    pub sim_reverts: Family<ReasonLabel, Counter>,
    pub dry_run_actions: Family<KindLabel, Counter>,
    pub oracle_waits: Counter,
    pub ticks: Counter,
    pub tick_errors: Counter,
    pub head_block: Gauge,
    pub scanned_block: Gauge,
    pub head_lag: Gauge,
    pub accounts_tracked: Gauge,
    pub accounts_with_positions: Gauge,
    pub conds_tracked: Gauge,
    pub twaps_tracked: Gauge,
    pub markets_with_adl_debt: Gauge,
    pub skipped_unprofitable: Family<KindLabel, Counter>,
    pub lost_races: Counter,
    pub reorgs: Counter,
    pub rpc_active_endpoint: Gauge,
    pub multicall_enabled: Gauge,
    // ---- Pyth pusher
    pub pyth_age_seconds: Family<FeedLabel, Gauge>,
    pub pyth_push: Family<ResultLabel, Counter>,
    pub pyth_fee_wei: Counter,
    pub pyth_gas_wei: Counter,
    pub pyth_hermes_errors: Family<KindLabel, Counter>,
    pub pyth_budget_spent_wei: Gauge,
    pub pyth_backoff_seconds: Gauge,
    pub pyth_enabled: Gauge,
}

impl Metrics {
    pub fn new() -> Metrics {
        let mut r = Registry::with_prefix("keeper");
        let m = Metrics {
            registry: Registry::default(),
            liquidations_sent: Counter::default(),
            txs_sent: Family::default(),
            tx_failures: Family::default(),
            sim_reverts: Family::default(),
            dry_run_actions: Family::default(),
            oracle_waits: Counter::default(),
            ticks: Counter::default(),
            tick_errors: Counter::default(),
            head_block: Gauge::default(),
            scanned_block: Gauge::default(),
            head_lag: Gauge::default(),
            accounts_tracked: Gauge::default(),
            accounts_with_positions: Gauge::default(),
            conds_tracked: Gauge::default(),
            twaps_tracked: Gauge::default(),
            markets_with_adl_debt: Gauge::default(),
            skipped_unprofitable: Family::default(),
            lost_races: Counter::default(),
            reorgs: Counter::default(),
            rpc_active_endpoint: Gauge::default(),
            multicall_enabled: Gauge::default(),
            pyth_age_seconds: Family::default(),
            pyth_push: Family::default(),
            pyth_fee_wei: Counter::default(),
            pyth_gas_wei: Counter::default(),
            pyth_hermes_errors: Family::default(),
            pyth_budget_spent_wei: Gauge::default(),
            pyth_backoff_seconds: Gauge::default(),
            pyth_enabled: Gauge::default(),
        };
        r.register("liquidations_sent", "Liquidation transactions mined successfully", m.liquidations_sent.clone());
        r.register("txs_sent", "Transactions mined successfully, by kind", m.txs_sent.clone());
        r.register("tx_failures", "Failed submissions (unexpected reverts, RPC errors, timeouts), by kind", m.tx_failures.clone());
        r.register("sim_reverts", "Simulations that reverted, by kind and reason", m.sim_reverts.clone());
        r.register("dry_run_actions", "Actions that would have been sent in dry-run mode, by kind", m.dry_run_actions.clone());
        r.register("oracle_waits", "Times an action was deferred because the oracle was degraded", m.oracle_waits.clone());
        r.register("ticks", "Completed poll cycles", m.ticks.clone());
        r.register("tick_errors", "Poll cycles that hit an error", m.tick_errors.clone());
        r.register("head_block", "Chain head block number", m.head_block.clone());
        r.register("scanned_block", "Last block whose logs have been applied", m.scanned_block.clone());
        r.register("head_lag", "Head minus last scanned block", m.head_lag.clone());
        r.register("accounts_tracked", "Accounts discovered from Deposit/Fill events", m.accounts_tracked.clone());
        r.register("accounts_with_positions", "Tracked accounts holding a position", m.accounts_with_positions.clone());
        r.register("conditionals_tracked", "Active conditional orders being watched", m.conds_tracked.clone());
        r.register("twaps_tracked", "Active TWAP orders being watched", m.twaps_tracked.clone());
        r.register("markets_with_adl_debt", "Markets whose adlDebt > 0", m.markets_with_adl_debt.clone());
        r.register("skipped_unprofitable", "Liquidations skipped because estimated gas cost exceeded the keeper reward, by kind", m.skipped_unprofitable.clone());
        r.register("lost_races", "Transactions that were mined but reverted because someone else acted first (benign)", m.lost_races.clone());
        r.register("reorgs", "Chain reorganisations detected by the block-hash check", m.reorgs.clone());
        r.register("rpc_active_endpoint", "Index of the RPC endpoint currently preferred", m.rpc_active_endpoint.clone());
        r.register("multicall_enabled", "1 when reads are batched through Multicall3", m.multicall_enabled.clone());
        r.register("pyth_age_seconds", "Chain time minus the on-chain Pyth publishTime, per feed (alert above half the exchange's max age)", m.pyth_age_seconds.clone());
        r.register("pyth_push", "Pyth pusher decisions by result (sent, dry_run, skipped_*, failed_*)", m.pyth_push.clone());
        r.register("pyth_fee_wei", "Pyth update fees paid (wei)", m.pyth_fee_wei.clone());
        r.register("pyth_gas_wei", "Gas paid for Pyth pushes (wei)", m.pyth_gas_wei.clone());
        r.register("pyth_hermes_errors", "Hermes request failures by kind (unauthorized, rate_limited, server, client, network, bad_body)", m.pyth_hermes_errors.clone());
        r.register("pyth_budget_spent_wei", "Wei spent (or reserved) on Pyth pushes in the last hour", m.pyth_budget_spent_wei.clone());
        r.register("pyth_backoff_seconds", "Seconds the pusher will wait before its next attempt after a failure (0 = none)", m.pyth_backoff_seconds.clone());
        r.register("pyth_enabled", "1 when the Pyth pusher is enabled", m.pyth_enabled.clone());
        Metrics { registry: r, ..m }
    }

    pub fn render(&self) -> String {
        let mut s = String::new();
        let _ = encode(&mut s, &self.registry);
        s
    }

    pub fn inc_kind(fam: &Family<KindLabel, Counter>, kind: &str) {
        fam.get_or_create(&KindLabel { kind: kind.to_string() }).inc();
    }

    pub fn inc_pyth(&self, result: &str) {
        self.pyth_push.get_or_create(&ResultLabel { result: result.to_string() }).inc();
    }

    pub fn inc_revert(&self, kind: &str, reason: &str) {
        self.sim_reverts.get_or_create(&ReasonLabel { kind: kind.to_string(), reason: reason.to_string() }).inc();
    }
}

impl Default for Metrics {
    fn default() -> Self { Self::new() }
}

/// Liveness/readiness inputs.
#[derive(Default)]
pub struct Health {
    last_ok_unix: AtomicU64,
    lag: AtomicU64,
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Health {
    pub fn mark_ok(&self, lag: u64) {
        self.last_ok_unix.store(unix_now(), Ordering::Relaxed);
        self.lag.store(lag, Ordering::Relaxed);
    }

    /// Ready = a poll cycle completed recently and the scan keeps up with head.
    pub fn ready(&self, now: u64, max_age_secs: u64, max_lag: u64) -> bool {
        Self::ready_from(self.last_ok_unix.load(Ordering::Relaxed), self.lag.load(Ordering::Relaxed), now, max_age_secs, max_lag)
    }

    pub fn ready_from(last_ok: u64, lag: u64, now: u64, max_age_secs: u64, max_lag: u64) -> bool {
        last_ok != 0 && now.saturating_sub(last_ok) <= max_age_secs && lag <= max_lag
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_rules() {
        assert!(!Health::ready_from(0, 0, 100, 10, 5)); // never completed a cycle
        assert!(Health::ready_from(95, 3, 100, 10, 5));
        assert!(!Health::ready_from(80, 3, 100, 10, 5)); // stale
        assert!(!Health::ready_from(95, 6, 100, 10, 5)); // lagging
    }

    #[test]
    fn render_contains_required_series() {
        let m = Metrics::new();
        m.liquidations_sent.inc();
        Metrics::inc_kind(&m.tx_failures, "liquidate");
        m.head_lag.set(3);
        m.accounts_tracked.set(2);
        let out = m.render();
        assert!(out.contains("keeper_liquidations_sent_total 1"), "{out}");
        assert!(out.contains("keeper_tx_failures_total{kind=\"liquidate\"} 1"), "{out}");
        assert!(out.contains("keeper_head_lag 3"));
        assert!(out.contains("keeper_accounts_tracked 2"));
    }
}
