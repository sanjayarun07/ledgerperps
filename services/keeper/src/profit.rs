//! Liquidation profitability: expected keeper reward (mirrors `PerpLiquidation.liquidate`) vs. gas cost.
//! All money below is in micro-USD (1e6 = 1 USDC), the exchange's collateral unit.
use alloy::primitives::U256;

const BPS: u64 = 10_000;
const SIZE_SCALE: u64 = 100_000_000; // 1e8, contract SIZE_SCALE

/// Contract parameters that determine the keeper's cut (public getters on the exchange).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiqParams {
    pub liq_fee_bps: u32,
    pub keeper_share_bps: u32,
    pub close_factor_bps: u32,
    pub full_close_notional: u64,
}

fn notional_floor(size: U256, px: U256) -> U256 {
    size.saturating_mul(px) / U256::from(SIZE_SCALE)
}

/// Size the contract will close: whole position when its notional <= `fullCloseNotional`, else `closeFactorBps` of it,
/// rounded down to the lot; 0 or over-size falls back to the whole position.
pub fn close_size(abs_size: U256, mark: U256, lot: u64, p: &LiqParams) -> U256 {
    let mut c = if notional_floor(abs_size, mark) <= U256::from(p.full_close_notional) {
        abs_size
    } else {
        abs_size.saturating_mul(U256::from(p.close_factor_bps)) / U256::from(BPS)
    };
    if lot > 0 {
        c = (c / U256::from(lot)) * U256::from(lot);
    }
    if c.is_zero() || c > abs_size { abs_size } else { c }
}

/// Keeper reward in micro-USD: `fee = ceil(notional(closeSz) * liqFeeBps / 1e4)`, `cut = fee * keeperShareBps / 1e4`.
pub fn keeper_reward(abs_size: U256, mark: U256, lot: u64, p: &LiqParams) -> U256 {
    let cs = close_size(abs_size, mark, lot, p);
    let n = notional_floor(cs, mark);
    let fee = (n.saturating_mul(U256::from(p.liq_fee_bps)) + U256::from(BPS - 1)) / U256::from(BPS);
    fee.saturating_mul(U256::from(p.keeper_share_bps)) / U256::from(BPS)
}

/// Gas cost in micro-USD: `gas * fee_per_gas_wei * native_usd_micro / 1e18`.
pub fn gas_cost_micro_usd(gas: u64, fee_per_gas_wei: u128, native_usd_micro: u128) -> U256 {
    U256::from(gas).saturating_mul(U256::from(fee_per_gas_wei)).saturating_mul(U256::from(native_usd_micro)) / U256::from(10u128.pow(18))
}

pub fn usd_to_micro(usd: f64) -> u128 {
    if !usd.is_finite() || usd <= 0.0 { 0 } else { (usd * 1e6).round() as u128 }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Send,
    SkipUnprofitable,
}

/// Send iff forced, or `reward - cost >= min_profit` (all micro-USD).
pub fn decide(reward: U256, cost: U256, min_profit: U256, force: bool) -> Decision {
    if force || reward >= cost.saturating_add(min_profit) { Decision::Send } else { Decision::SkipUnprofitable }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(n: u64) -> U256 { U256::from(n) }
    // 0.5% fee, keeper gets 50% of it, close factor 50%, whole-close under 1000 USDC notional
    const P: LiqParams = LiqParams { liq_fee_bps: 50, keeper_share_bps: 5000, close_factor_bps: 5000, full_close_notional: 1_000_000_000 };

    #[test]
    fn partial_close_reward() {
        // 1 BTC (1e8) at 45,500 USDC (45_500e6): notional 45,500 USDC > 1000 => close 50% = 0.5 BTC (22,750 USDC)
        let size = u(100_000_000);
        let px = u(45_500_000_000);
        assert_eq!(close_size(size, px, 1, &P), u(50_000_000));
        // fee = 22,750 * 0.5% = 113.75 USDC ; keeper 50% = 56.875 USDC
        assert_eq!(keeper_reward(size, px, 1, &P), u(56_875_000));
    }

    #[test]
    fn small_position_closes_fully_and_lot_rounding() {
        // 0.01 BTC at 45,500 => 455 USDC <= 1000 => full close
        assert_eq!(close_size(u(1_000_000), u(45_500_000_000), 1, &P), u(1_000_000));
        // lot rounding down: 50% of 1_000_001 = 500_000 (lot 100_000 => 500_000)
        let big = u(300_000_000);
        assert_eq!(close_size(big, u(45_500_000_000), 100_000, &P), u(150_000_000));
        // rounds to zero => whole position (contract: closeSz == 0 => abs_)
        let p2 = LiqParams { close_factor_bps: 1, ..P };
        assert_eq!(close_size(u(200_000_000), u(45_500_000_000), 100_000_000, &p2), u(200_000_000));
    }

    #[test]
    fn fee_rounds_up_like_the_contract() {
        // notional 1 micro-USD * 50 bps => ceil(0.005)=1 fee, keeper 50% floor => 0
        let p = LiqParams { full_close_notional: u64::MAX, ..P };
        assert_eq!(keeper_reward(u(1), u(100_000_000), 1, &p), u(0));
    }

    #[test]
    fn gas_cost_conversion() {
        // 500k gas * 20 gwei = 0.01 ETH ; at $3000 => $30
        assert_eq!(gas_cost_micro_usd(500_000, 20_000_000_000, usd_to_micro(3000.0)), u(30_000_000));
        assert_eq!(usd_to_micro(-1.0), 0);
        assert_eq!(usd_to_micro(f64::NAN), 0);
    }

    #[test]
    fn decision_table() {
        assert_eq!(decide(u(100), u(50), u(0), false), Decision::Send);
        assert_eq!(decide(u(50), u(50), u(0), false), Decision::Send); // break-even sends when min_profit = 0
        assert_eq!(decide(u(49), u(50), u(0), false), Decision::SkipUnprofitable);
        assert_eq!(decide(u(100), u(50), u(51), false), Decision::SkipUnprofitable); // min profit not met
        assert_eq!(decide(u(100), u(50), u(50), false), Decision::Send);
        assert_eq!(decide(u(0), u(50), u(0), true), Decision::Send); // forced
        assert_eq!(decide(u(5), U256::MAX, u(1), false), Decision::SkipUnprofitable); // saturating add, no overflow panic
    }
}
