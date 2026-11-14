//! Classification of contract reverts into what the keeper should DO about them.
use crate::abi::IPerp;
use alloy::sol_types::SolInterface;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertKind {
    /// Oracle read failed or is stale. The keeper must wait: it never acts on untrusted prices.
    OracleDegraded,
    /// Market/global pause or degraded state.
    MarketRestricted,
    /// Account is healthy (or already liquidated).
    NotLiquidatable,
    /// `BadParam("inactive")`: the conditional/TWAP record no longer exists.
    Inactive,
    /// `BadParam("too early")` / `BadParam("not triggered")`: condition not met yet.
    NotYet,
    /// Any other `BadParam(what)`.
    BadParam(String),
    /// Other known custom error (name).
    Known(&'static str),
    /// Revert payload that we could not decode (selector hex or reason string).
    Unknown(String),
    /// The call failed without revert data (transport problem, node error).
    NoData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Retry on a later poll; not an error.
    Wait,
    /// The opportunity is gone; do not retry this item now (drop records if `Inactive`).
    Skip,
    /// Unexpected: count as a failure and log loudly.
    Fail,
}

impl RevertKind {
    pub fn disposition(&self) -> Disposition {
        use RevertKind::*;
        match self {
            OracleDegraded | MarketRestricted | NotYet => Disposition::Wait,
            NotLiquidatable | Inactive => Disposition::Skip,
            BadParam(w) if matches!(w.as_str(), "no adl debt" | "no position" | "nothing to write off" | "not elevated" | "nothing to unwind") => Disposition::Skip,
            _ => Disposition::Fail,
        }
    }

    pub fn label(&self) -> String {
        use RevertKind::*;
        match self {
            OracleDegraded => "oracle_degraded".into(),
            MarketRestricted => "market_restricted".into(),
            NotLiquidatable => "not_liquidatable".into(),
            Inactive => "inactive".into(),
            NotYet => "not_yet".into(),
            BadParam(w) => format!("bad_param:{w}"),
            Known(n) => (*n).to_string(),
            Unknown(s) => format!("unknown:{s}"),
            NoData => "no_revert_data".into(),
        }
    }
}

impl std::fmt::Display for RevertKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.label()) }
}

pub fn classify_revert(data: &[u8]) -> RevertKind {
    use IPerp::IPerpErrors as E;
    if data.is_empty() {
        return RevertKind::NoData;
    }
    match E::abi_decode(data) {
        Ok(E::OracleDegraded(_)) => RevertKind::OracleDegraded,
        Ok(E::MarketRestricted(_)) => RevertKind::MarketRestricted,
        Ok(E::NotLiquidatable(_)) => RevertKind::NotLiquidatable,
        Ok(E::BadParam(b)) => match b.what.as_str() {
            "inactive" => RevertKind::Inactive,
            "too early" | "not triggered" | "not due" => RevertKind::NotYet,
            w => RevertKind::BadParam(w.to_string()),
        },
        Ok(E::NotAuthorized(_)) => RevertKind::Known("not_authorized"),
        Ok(E::Unhealthy(_)) => RevertKind::Known("unhealthy"),
        Ok(E::Expired(_)) => RevertKind::Known("expired"),
        Ok(E::TooManyOrders(_)) => RevertKind::Known("too_many_orders"),
        // withdraw-only (unresolved bad debt above the gate and amount > principal); the keeper never withdraws, but decode it cleanly
        Ok(E::WithdrawGated(_)) => RevertKind::Known("withdraw_gated"),
        // backstopPlace only (soft cap exceeded); the keeper never places backstop orders, but decode it cleanly
        Ok(E::BackstopCap(_)) => RevertKind::Known("backstop_cap"),
        Ok(E::ReentrancyGuardReentrantCall(_)) => RevertKind::Known("reentrancy"),
        Err(_) => match alloy::sol_types::decode_revert_reason(data) {
            Some(r) => RevertKind::Unknown(r),
            None => RevertKind::Unknown(format!("0x{}", alloy::hex::encode(&data[..data.len().min(4)]))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::sol_types::SolError;

    #[test]
    fn oracle_degraded_is_wait() {
        let k = classify_revert(&IPerp::OracleDegraded {}.abi_encode());
        assert_eq!(k, RevertKind::OracleDegraded);
        assert_eq!(k.disposition(), Disposition::Wait);
    }

    #[test]
    fn not_liquidatable_is_skip() {
        let k = classify_revert(&IPerp::NotLiquidatable {}.abi_encode());
        assert_eq!(k.disposition(), Disposition::Skip);
    }

    #[test]
    fn badparam_variants() {
        let enc = |s: &str| IPerp::BadParam { what: s.to_string() }.abi_encode();
        assert_eq!(classify_revert(&enc("inactive")), RevertKind::Inactive);
        assert_eq!(classify_revert(&enc("too early")).disposition(), Disposition::Wait);
        assert_eq!(classify_revert(&enc("not triggered")).disposition(), Disposition::Wait);
        assert_eq!(classify_revert(&enc("no adl debt")).disposition(), Disposition::Skip);
        assert_eq!(classify_revert(&enc("not ranked")).disposition(), Disposition::Fail);
    }

    #[test]
    fn withdraw_gated_decodes_to_a_named_error() {
        let k = classify_revert(&IPerp::WithdrawGated {}.abi_encode());
        assert_eq!(k, RevertKind::Known("withdraw_gated"));
        assert_eq!(k.label(), "withdraw_gated");
    }

    #[test]
    fn backstop_phase2_errors_classify() {
        assert_eq!(classify_revert(&IPerp::BackstopCap {}.abi_encode()), RevertKind::Known("backstop_cap"));
        let enc = |s: &str| IPerp::BadParam { what: s.to_string() }.abi_encode();
        assert_eq!(classify_revert(&enc("not due")).disposition(), Disposition::Wait, "unwind before maxAge: retry later");
        assert_eq!(classify_revert(&enc("not elevated")).disposition(), Disposition::Skip);
        assert_eq!(classify_revert(&enc("nothing to unwind")).disposition(), Disposition::Skip);
        assert_eq!(classify_revert(&enc("not in profit")).disposition(), Disposition::Fail);
    }

    #[test]
    fn garbage_and_empty() {
        assert_eq!(classify_revert(&[]), RevertKind::NoData);
        assert!(matches!(classify_revert(&[1, 2, 3, 4, 5]), RevertKind::Unknown(_)));
        assert_eq!(classify_revert(&[]).disposition(), Disposition::Fail);
    }

    #[test]
    fn string_reason_decoded() {
        // Error("unknown selector")
        let data = alloy::sol_types::Revert::from("unknown selector").abi_encode();
        assert_eq!(classify_revert(&data), RevertKind::Unknown("revert: unknown selector".into()));
    }
}
