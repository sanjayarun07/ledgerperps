//! Shared execution context and the single "simulate, then (maybe) send" path used by every feature.
use crate::{
    chain::{CallErr, Chain, SendError, Sent},
    config::Config,
    errors::{Disposition, RevertKind},
    metrics::Metrics,
};
use crate::profit::{decide, gas_cost_micro_usd, usd_to_micro, Decision};
use alloy::primitives::{Bytes, U256};
use std::{collections::HashMap, sync::Arc};
use tracing::{debug, info, warn};

pub struct Ctx {
    pub cfg: Arc<Config>,
    pub chain: Arc<Chain>,
    pub metrics: Arc<Metrics>,
}

#[derive(Debug)]
pub enum Outcome {
    Sent(Sent),
    /// Simulation passed; nothing sent because of dry-run / no signer.
    DryRun,
    /// Simulation (or the final gas estimate) reverted; see `RevertKind::disposition`.
    Reverted(RevertKind),
    /// Simulation passed but the estimated gas cost exceeds the keeper reward (liquidations only).
    Unprofitable,
    Failed(String),
}

/// What a mined-but-reverted transaction means, given a re-simulation of the same call afterwards.
#[derive(Debug, PartialEq, Eq)]
pub enum MinedRevert {
    /// The opportunity is gone ("not liquidatable", "inactive", "no position", ...): another party got there first.
    LostRace(RevertKind),
    Failure,
}

pub fn classify_mined_revert(resim: &Result<(), CallErr>) -> MinedRevert {
    match resim {
        Err(CallErr::Revert(k)) if k.disposition() == Disposition::Skip => MinedRevert::LostRace(k.clone()),
        _ => MinedRevert::Failure,
    }
}

/// micro-USD as a decimal string (`12.345678`).
pub fn fmt_micro(v: U256) -> String {
    let m = U256::from(1_000_000u64);
    format!("{}.{:06}", v / m, v % m)
}

impl Outcome {
    pub fn is_sent(&self) -> bool { matches!(self, Outcome::Sent(_)) }
}

impl Ctx {
    /// eth_call first; only a call that would succeed is signed and sent. Oracle-degraded / paused reverts are a
    /// normal "wait", never counted as failures.
    pub async fn submit(&self, kind: &'static str, detail: &str, data: Bytes) -> Outcome {
        self.submit_gated(kind, detail, data, None).await
    }

    /// Like `submit`, but with `reward = Some(micro-USD)` the call is first checked for profitability against the
    /// estimated gas cost (skipped when unprofitable unless `force_unprofitable`).
    pub async fn submit_gated(&self, kind: &'static str, detail: &str, data: Bytes, reward: Option<U256>) -> Outcome {
        match self.chain.simulate(&data).await {
            Ok(()) => {}
            Err(CallErr::Revert(k)) => return self.reverted(kind, detail, k),
            Err(CallErr::Transport(s)) => {
                Metrics::inc_kind(&self.metrics.tx_failures, kind);
                warn!(kind, detail, error = %s, "simulation transport error");
                return Outcome::Failed(s);
            }
        }
        if let Some(reward) = reward {
            match self.chain.estimate_cost(&data).await {
                Ok((gas, fee)) => {
                    let cost = gas_cost_micro_usd(gas, fee, usd_to_micro(self.cfg.native_usd_price));
                    let min_profit = U256::from(usd_to_micro(self.cfg.min_profit_usd));
                    match decide(reward, cost, min_profit, self.cfg.force_unprofitable) {
                        Decision::Send => {
                            info!(kind, detail, reward_usd = %fmt_micro(reward), est_gas_cost_usd = %fmt_micro(cost), gas, max_fee_wei = fee, forced = self.cfg.force_unprofitable, "profitability check passed");
                        }
                        Decision::SkipUnprofitable => {
                            Metrics::inc_kind(&self.metrics.skipped_unprofitable, kind);
                            warn!(kind, detail, reward_usd = %fmt_micro(reward), est_gas_cost_usd = %fmt_micro(cost), gas, max_fee_wei = fee, "SKIPPING: estimated gas cost exceeds keeper reward (use --force-unprofitable to override)");
                            return Outcome::Unprofitable;
                        }
                    }
                }
                // Liquidations protect the exchange: if we cannot price the gas we do not silently hold back.
                Err(e) => warn!(kind, detail, error = %e, "gas cost estimate unavailable; proceeding without profitability gate"),
            }
        }
        if self.cfg.dry_run || !self.chain.can_send() {
            Metrics::inc_kind(&self.metrics.dry_run_actions, kind);
            info!(kind, detail, "DRY-RUN: simulation ok, would send");
            return Outcome::DryRun;
        }
        let data_clone = data.clone();
        match self.chain.execute(kind, data).await {
            Ok(sent) => {
                Metrics::inc_kind(&self.metrics.txs_sent, kind);
                let cost_wei = sent.cost_wei();
                let cost_usd = gas_cost_micro_usd(sent.gas_used, sent.effective_gas_price, usd_to_micro(self.cfg.native_usd_price));
                info!(kind, detail, tx = %sent.hash, block = sent.block, gas_used = sent.gas_used, attempts = sent.attempts, cost_wei, est_cost_usd = %fmt_micro(cost_usd), "tx mined");
                Outcome::Sent(sent)
            }
            Err(SendError::Reverted(k)) => self.reverted(kind, detail, k),
            Err(SendError::MinedRevert(h)) => {
                // We lost a race (someone liquidated/executed first between our simulation and inclusion) iff the same call
                // now reverts with an "opportunity gone" error. Anything else is a genuine failure.
                let again = self.chain.simulate(&data_clone).await;
                match classify_mined_revert(&again) {
                    MinedRevert::LostRace(k) => {
                        self.metrics.lost_races.inc();
                        info!(kind, detail, tx = %h, reason = %k.label(), "transaction reverted on-chain because another party acted first (benign; gas was spent)");
                        Outcome::Reverted(k)
                    }
                    MinedRevert::Failure => {
                        Metrics::inc_kind(&self.metrics.tx_failures, kind);
                        warn!(kind, detail, tx = %h, "transaction mined but reverted");
                        Outcome::Failed(format!("mined revert {h}"))
                    }
                }
            }
            Err(e) => {
                Metrics::inc_kind(&self.metrics.tx_failures, kind);
                warn!(kind, detail, error = %e, "submission failed");
                Outcome::Failed(e.to_string())
            }
        }
    }

    fn reverted(&self, kind: &'static str, detail: &str, k: RevertKind) -> Outcome {
        self.metrics.inc_revert(kind, &k.label());
        match k.disposition() {
            Disposition::Wait => {
                if k == RevertKind::OracleDegraded {
                    self.metrics.oracle_waits.inc();
                    info!(kind, detail, "oracle degraded: waiting, will not act on stale prices");
                } else {
                    debug!(kind, detail, reason = %k.label(), "not actionable yet");
                }
            }
            Disposition::Skip => debug!(kind, detail, reason = %k.label(), "opportunity gone"),
            Disposition::Fail => {
                Metrics::inc_kind(&self.metrics.tx_failures, kind);
                warn!(kind, detail, reason = %k.label(), "unexpected revert in simulation");
            }
        }
        Outcome::Reverted(k)
    }
}

/// Per-tick mark price cache. `None` = oracle degraded/unreadable for that market this tick.
#[derive(Default)]
pub struct Marks {
    cache: HashMap<u8, Option<U256>>,
}

impl Marks {
    pub async fn get(&mut self, ctx: &Ctx, m: u8) -> Option<U256> {
        if let Some(v) = self.cache.get(&m) {
            return *v;
        }
        let v = match ctx.chain.mark_price(m).await {
            Ok(p) => Some(p),
            Err(CallErr::Revert(RevertKind::OracleDegraded)) => {
                ctx.metrics.oracle_waits.inc();
                info!(market = m, "markPrice reverted OracleDegraded: skipping market this cycle");
                None
            }
            Err(e) => {
                debug!(market = m, error = %e, "markPrice unavailable");
                None
            }
        };
        self.cache.insert(m, v);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mined_revert_is_a_benign_lost_race_only_when_the_opportunity_is_gone() {
        assert_eq!(classify_mined_revert(&Err(CallErr::Revert(RevertKind::NotLiquidatable))), MinedRevert::LostRace(RevertKind::NotLiquidatable));
        assert_eq!(classify_mined_revert(&Err(CallErr::Revert(RevertKind::Inactive))), MinedRevert::LostRace(RevertKind::Inactive));
        assert_eq!(classify_mined_revert(&Err(CallErr::Revert(RevertKind::BadParam("no position".into())))), MinedRevert::LostRace(RevertKind::BadParam("no position".into())));
        // still liquidatable but the tx reverted for some other reason: a real failure
        assert_eq!(classify_mined_revert(&Ok(())), MinedRevert::Failure);
        assert_eq!(classify_mined_revert(&Err(CallErr::Revert(RevertKind::OracleDegraded))), MinedRevert::Failure);
        assert_eq!(classify_mined_revert(&Err(CallErr::Transport("x".into()))), MinedRevert::Failure);
    }

    #[test]
    fn micro_usd_format() {
        assert_eq!(fmt_micro(U256::from(56_875_000u64)), "56.875000");
        assert_eq!(fmt_micro(U256::from(5u64)), "0.000005");
    }
}
