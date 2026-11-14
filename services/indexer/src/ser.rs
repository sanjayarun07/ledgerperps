//! Serde helpers: 64+ bit scaled integers are rendered as decimal strings in the API so JS clients never lose precision.
use serde::Serializer;

pub fn u128s<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}
pub fn i128s<S: Serializer>(v: &i128, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}
pub fn u64s<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}
pub fn opt_u64s<S: Serializer>(v: &Option<u64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(x) => s.serialize_str(&x.to_string()),
        None => s.serialize_none(),
    }
}
pub fn opt_u128s<S: Serializer>(v: &Option<u128>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(x) => s.serialize_str(&x.to_string()),
        None => s.serialize_none(),
    }
}

// ------------------------------------------------------------------------------------------------ deserialisers
// The API renders large integers as decimal strings; snapshots (see `State::to_snapshot`) round-trip the very same
// representation, so every `*s` serialiser has a matching deserialiser here.
use serde::{Deserialize, Deserializer};
use std::cell::Cell;

pub fn d_u64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
}
pub fn d_u128<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
    String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
}
pub fn d_i128<'de, D: Deserializer<'de>>(d: D) -> Result<i128, D::Error> {
    String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
}
pub fn d_opt_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| s.parse().map_err(serde::de::Error::custom))
        .transpose()
}
pub fn d_opt_u128<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u128>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| s.parse().map_err(serde::de::Error::custom))
        .transpose()
}

/// Every `&'static str` label the read models use (sides, tifs, statuses, kinds, cancel reasons).
const STATICS: &[&str] = &[
    "buy",
    "sell",
    "gtc",
    "ioc",
    "fok",
    "post_only",
    "unknown",
    "user",
    "expired",
    "self_trade",
    "invalid_reduce_only",
    "maker_margin",
    "filled",
    "liquidation",
    "replaced",
    "price_band",
    "backstop_synced",
    "adl_skipped",
    "adl_hard_prem_set",
    "withdraw_gate_set",
    "deposit",
    "withdraw",
    "internal_transfer",
    "iso_margin",
    "bad_debt_unresolved",
    "adl",
    "recapitalized",
    "active",
    "done",
    "canceled",
    "triggered",
    "conditional",
    "twap",
];

fn intern<E: serde::de::Error>(s: &str) -> Result<&'static str, E> {
    STATICS
        .iter()
        .find(|x| **x == s)
        .copied()
        .ok_or_else(|| E::custom(format!("unknown label {s:?} in snapshot")))
}
pub fn d_static<'de, D: Deserializer<'de>>(d: D) -> Result<&'static str, D::Error> {
    intern(&String::deserialize(d)?)
}
pub fn d_opt_static<'de, D: Deserializer<'de>>(d: D) -> Result<Option<&'static str>, D::Error> {
    Option::<String>::deserialize(d)?.map(|s| intern(&s)).transpose()
}

thread_local! {
    static SNAPSHOT_MODE: Cell<bool> = const { Cell::new(false) };
}

/// Run `f` with "snapshot mode" on: row fields that are hidden from the public API (`hide_unless_snapshot`) are
/// serialised too, so a snapshot captures the complete reducer state. Serialisation is synchronous and thread-local.
pub fn in_snapshot_mode<T>(f: impl FnOnce() -> T) -> T {
    SNAPSHOT_MODE.with(|c| c.set(true));
    let r = f();
    SNAPSHOT_MODE.with(|c| c.set(false));
    r
}

/// `skip_serializing_if` predicate: true (=> skip) in normal API serialisation, false while snapshotting.
pub fn hide_unless_snapshot<T>(_: &T) -> bool {
    !SNAPSHOT_MODE.with(|c| c.get())
}

/// `with` module for `Option<&'static str>` (plain `deserialize_with` makes serde infer a `'de: 'static` bound).
pub mod opt_static {
    use serde::{Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &Option<&'static str>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(x) => s.serialize_some(x),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<&'static str>, D::Error> {
        super::d_opt_static(d)
    }
}
