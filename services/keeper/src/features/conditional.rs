//! Feature 3: execute conditional (TP/SL/stop) orders once the on-chain MARK crosses the trigger.
use crate::{
    abi::IPerp,
    actions::{Ctx, Marks, Outcome},
    errors::RevertKind,
    state::State,
};
use alloy::{primitives::{Bytes, U256}, sol_types::SolCall};
use tracing::debug;

/// Mirrors `PerpExtras.executeConditional`: reverts "not triggered" when (above ? mk < trigger : mk > trigger).
pub fn cond_triggered(above: bool, trigger: u64, mark: U256) -> bool {
    let t = U256::from(trigger);
    if above { mark >= t } else { mark <= t }
}

pub async fn run(ctx: &Ctx, state: &mut State, marks: &mut Marks) {
    let ids: Vec<(u64, crate::state::CondRec)> = state.conds.iter().map(|(k, v)| (*k, v.clone())).collect();
    let mut sent = 0usize;
    for (id, rec) in ids {
        if sent >= ctx.cfg.max_actions_per_tick {
            break;
        }
        let Some(mark) = marks.get(ctx, rec.market).await else { continue }; // oracle degraded: wait
        if !cond_triggered(rec.above, rec.trigger, mark) {
            continue;
        }
        let data = Bytes::from(IPerp::executeConditionalCall { id }.abi_encode());
        match ctx.submit("execute_conditional", &format!("id={id} market={} mark={mark} trigger={}", rec.market, rec.trigger), data).await {
            Outcome::Sent(_) => {
                sent += 1;
                state.conds.remove(&id); // consumed (a sibling, if any, is removed via its CondCanceled event)
            }
            Outcome::Reverted(RevertKind::Inactive) => {
                debug!(id, "conditional already gone; dropping");
                state.conds.remove(&id);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_rules() {
        let u = U256::from;
        // above: fire when mark >= trigger
        assert!(cond_triggered(true, 100, u(100)));
        assert!(cond_triggered(true, 100, u(101)));
        assert!(!cond_triggered(true, 100, u(99)));
        // below: fire when mark <= trigger
        assert!(cond_triggered(false, 100, u(100)));
        assert!(cond_triggered(false, 100, u(1)));
        assert!(!cond_triggered(false, 100, u(101)));
    }
}
