//! Feature 4: execute TWAP slices when due. A slice never reverts for child-order failure (the contract counts it),
//! so the keeper only needs the schedule.
use crate::{
    abi::IPerp,
    actions::{Ctx, Outcome},
    chain::CallErr,
    errors::RevertKind,
    state::State,
};
use alloy::{primitives::Bytes, sol_types::SolCall};
use tracing::debug;

/// Due when active and the latest block time has reached `next_time`.
pub fn twap_due(active: bool, next_time: u64, block_ts: u64) -> bool {
    active && block_ts >= next_time
}

pub async fn run(ctx: &Ctx, state: &mut State, head_ts: u64) {
    let ids: Vec<u64> = state.twaps.iter().copied().collect();
    let mut sent = 0usize;
    for id in ids {
        if sent >= ctx.cfg.max_actions_per_tick {
            break;
        }
        let st = match ctx.chain.twap_status(id).await {
            Ok(s) => s,
            Err(CallErr::Revert(_)) | Err(CallErr::Transport(_)) => continue,
        };
        if !st.active {
            debug!(id, "twap inactive; dropping");
            state.twaps.remove(&id);
            continue;
        }
        if !twap_due(st.active, st.nextTime, head_ts) {
            continue;
        }
        let data = Bytes::from(IPerp::executeTwapSliceCall { id }.abi_encode());
        match ctx.submit("execute_twap_slice", &format!("id={id} slice={}/{}", st.done + 1, st.slices), data).await {
            Outcome::Sent(_) => sent += 1,
            Outcome::Reverted(RevertKind::Inactive) => {
                state.twaps.remove(&id);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_rules() {
        assert!(twap_due(true, 100, 100));
        assert!(twap_due(true, 100, 500));
        assert!(!twap_due(true, 100, 99));
        assert!(!twap_due(false, 0, 500));
    }
}
