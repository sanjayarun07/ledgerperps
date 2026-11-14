//! Decoded contract events and ABI-driven log decoding.
//!
//! Every log emitted by the exchange router is decoded against the merged ABI (`abi/PerpExchange.merged.json`)
//! into an [`Ev`]. Unknown / uninteresting events (role changes, EIP-712 domain) decode to [`Ev::Other`] so that
//! *every* log is still persisted. Large integers are carried as `u128`/`i128` (saturating on overflow, which cannot
//! happen for USDC 1e6 / size 1e8 scaled quantities in practice) and serialised as decimal strings.

use alloy_dyn_abi::{DynSolValue, EventExt};
use alloy_json_abi::{Event, JsonAbi};
use alloy_primitives::{Address, B256, I256, U256};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Location + provenance of an event. `(block, log_index)` is the unique, totally ordered key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    pub block: u64,
    pub log_index: u32,
    pub tx_hash: B256,
    pub block_hash: B256,
    pub ts: u64,
}

impl Meta {
    pub fn key(&self) -> u128 {
        pos_key(self.block, self.log_index)
    }
}

pub fn pos_key(block: u64, log_index: u32) -> u128 {
    ((block as u128) << 32) | log_index as u128
}

/// `Ev::Other` name prefixes for logs the embedded ABI cannot decode. The raw topics/data are stored, so
/// `reindex-from-raw` can re-derive them after the ABI is refreshed.
pub const UNKNOWN_PREFIX: &str = "Unknown:";
pub const UNDECODABLE_PREFIX: &str = "Undecodable:";

/// The undecoded log payload, stored next to the decoded event so decoders can be re-run later.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawData {
    pub topics: Vec<B256>,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRecord {
    pub meta: Meta,
    pub ev: Ev,
    /// Raw topics + data (None for rows written before raw storage existed).
    #[serde(default, skip_serializing)]
    pub raw: Option<RawData>,
}

mod dec_u128 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}
mod dec_i128 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &i128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i128, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// Cancel reasons, mirroring `PerpBase.CancelReason`.
pub mod cancel {
    pub const USER: u8 = 0;
    pub const EXPIRED: u8 = 1;
    pub const SELF_TRADE: u8 = 2;
    pub const INVALID_REDUCE_ONLY: u8 = 3;
    pub const MAKER_MARGIN: u8 = 4;
    pub const FILLED: u8 = 5;
    pub const LIQUIDATION: u8 = 6;
    pub const REPLACED: u8 = 7;
    /// Resting order's price was outside index +/- bandBps at match time (WASH-1 fill price band).
    pub const PRICE_BAND: u8 = 8;
    pub fn name(r: u8) -> &'static str {
        match r {
            USER => "user",
            EXPIRED => "expired",
            SELF_TRADE => "self_trade",
            INVALID_REDUCE_ONLY => "invalid_reduce_only",
            MAKER_MARGIN => "maker_margin",
            FILLED => "filled",
            LIQUIDATION => "liquidation",
            REPLACED => "replaced",
            PRICE_BAND => "price_band",
            _ => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ev {
    Deposit {
        acct: B256,
        from: Address,
        #[serde(with = "dec_u128")]
        amount: u128,
    },
    Withdraw {
        acct: B256,
        #[serde(with = "dec_u128")]
        amount: u128,
    },
    InternalTransfer {
        from: B256,
        to: B256,
        #[serde(with = "dec_u128")]
        amount: u128,
    },
    OrderAccepted {
        id: u64,
        acct: B256,
        market: u8,
        is_buy: bool,
        price: u64,
        #[serde(with = "dec_u128")]
        size: u128,
        tif: u8,
        reduce_only: bool,
        cloid: u64,
    },
    OrderRested {
        id: u64,
        #[serde(with = "dec_u128")]
        remaining: u128,
    },
    OrderCanceled {
        id: u64,
        reason: u8,
        #[serde(with = "dec_u128")]
        remaining: u128,
    },
    OrderTruncated {
        id: u64,
        #[serde(with = "dec_u128")]
        remaining: u128,
    },
    Fill {
        trade_id: u64,
        market: u8,
        maker_order_id: u64,
        maker: B256,
        taker: B256,
        taker_is_buy: bool,
        price: u64,
        #[serde(with = "dec_u128")]
        size: u128,
        #[serde(with = "dec_u128")]
        taker_fee: u128,
        #[serde(with = "dec_i128")]
        maker_fee: i128,
    },
    Liquidated {
        acct: B256,
        market: u8,
        keeper: Address,
        #[serde(with = "dec_u128")]
        size: u128,
        price: u64,
        #[serde(with = "dec_u128")]
        fee: u128,
        #[serde(with = "dec_u128")]
        bad_debt: u128,
    },
    BadDebtUnresolved {
        acct: B256,
        #[serde(with = "dec_u128")]
        amount: u128,
    },
    FundingUpdated {
        market: u8,
        #[serde(with = "dec_u128")]
        intervals: u128,
        #[serde(with = "dec_i128")]
        rate: i128,
        #[serde(with = "dec_i128")]
        new_index: i128,
    },
    FundingSettled {
        acct: B256,
        market: u8,
        #[serde(with = "dec_i128")]
        owed: i128,
    },
    MarketState {
        market: u8,
        state: u8,
    },
    CondPlaced {
        id: u64,
        acct: B256,
        market: u8,
        is_buy: bool,
        above: bool,
        trigger: u64,
        limit: u64,
        #[serde(with = "dec_u128")]
        size: u128,
        reduce_only: bool,
        sibling: u64,
    },
    CondTriggered {
        id: u64,
        mark_price: u64,
    },
    CondCanceled {
        id: u64,
    },
    AgentApproved {
        acct: B256,
        agent: Address,
        expiry: u64,
    },
    IsolatedMode {
        acct: B256,
        market: u8,
        on: bool,
    },
    IsoMargin {
        acct: B256,
        market: u8,
        #[serde(with = "dec_i128")]
        delta: i128,
    },
    TwapPlaced {
        id: u64,
        acct: B256,
        market: u8,
        is_buy: bool,
        #[serde(with = "dec_u128")]
        total: u128,
        slices: u16,
        interval: u32,
        slippage_bps: u32,
        reduce_only: bool,
    },
    TwapSlice {
        id: u64,
        slice_index: u16,
        #[serde(with = "dec_u128")]
        filled: u128,
        ok: bool,
    },
    TwapDone {
        id: u64,
        #[serde(with = "dec_u128")]
        filled: u128,
        failed: u16,
    },
    TwapCanceled {
        id: u64,
        #[serde(with = "dec_u128")]
        filled: u128,
    },
    AdlExecuted {
        target: B256,
        market: u8,
        #[serde(with = "dec_u128")]
        size: u128,
        price: u64,
        #[serde(with = "dec_u128")]
        debt_cleared: u128,
        /// Mark price of the backstop leg, if the contract version emits it (`markPrice`); older ones do not.
        #[serde(default)]
        mark_price: Option<u64>,
    },
    Recapitalized {
        market: u8,
        from: Address,
        #[serde(with = "dec_u128")]
        amount: u128,
    },
    /// Any other ABI event (AccessControl, EIP712 domain, ...) is stored but has no read model.
    /// Backstop Phase 2: market's backstop inventory notional crossed the soft cap (elevated).
    BackstopElevated {
        market: u8,
        #[serde(with = "dec_u128")]
        notional: u128,
    },
    BackstopRelaxed { market: u8 },
    /// Dutch-auction take: `acct` traded `size` at `price` against the BACKSTOP (no Fill event is emitted).
    BackstopTaken {
        market: u8,
        taker: Address,
        acct: B256,
        taker_sold: bool,
        #[serde(with = "dec_u128")]
        size: u128,
        price: u64,
        #[serde(with = "dec_u128")]
        disc_bps: u128,
        #[serde(with = "dec_u128")]
        fee: u128,
    },
    /// Keeper unwind: `target` closed `size` at mark against the BACKSTOP (no Fill event is emitted).
    BackstopUnwound {
        market: u8,
        target: B256,
        #[serde(with = "dec_u128")]
        size: u128,
        price: u64,
    },
    BackstopCfgSet {
        market: u8,
        #[serde(with = "dec_u128")]
        soft_notional: u128,
        max_disc_bps: u16,
        dwell: u32,
        ramp: u32,
        max_age: u32,
    },
    BackstopPlaceOpenSet { open: bool },
    BackstopTakeFeeSet { bps: u32 },
    /// Backstop (BACKSTOP-1) sync: deficit charged to insurance / recorded as debt, or earlier draws repaid.
    BackstopSynced {
        #[serde(with = "dec_i128")]
        equity_before: i128,
        #[serde(with = "dec_u128")]
        from_insurance: u128,
        #[serde(with = "dec_u128")]
        to_debt: u128,
        market: u8,
        #[serde(with = "dec_u128")]
        refunded_insurance: u128,
        #[serde(with = "dec_u128")]
        repaid_debt: u128,
    },
    /// ADL skipped a target without slack (never reverts the batch).
    AdlSkipped {
        target: B256,
        market: u8,
        #[serde(with = "dec_u128")]
        slack: u128,
    },
    AdlHardPremSet {
        bps: u32,
    },
    WithdrawGateSet {
        #[serde(with = "dec_u128")]
        threshold: u128,
    },
    Other {
        name: String,
    },
}

impl Ev {
    pub fn name(&self) -> &str {
        match self {
            Ev::Deposit { .. } => "Deposit",
            Ev::Withdraw { .. } => "Withdraw",
            Ev::InternalTransfer { .. } => "InternalTransfer",
            Ev::OrderAccepted { .. } => "OrderAccepted",
            Ev::OrderRested { .. } => "OrderRested",
            Ev::OrderCanceled { .. } => "OrderCanceled",
            Ev::OrderTruncated { .. } => "OrderTruncated",
            Ev::Fill { .. } => "Fill",
            Ev::Liquidated { .. } => "Liquidated",
            Ev::BadDebtUnresolved { .. } => "BadDebtUnresolved",
            Ev::FundingUpdated { .. } => "FundingUpdated",
            Ev::FundingSettled { .. } => "FundingSettled",
            Ev::MarketState { .. } => "MarketState",
            Ev::CondPlaced { .. } => "CondPlaced",
            Ev::CondTriggered { .. } => "CondTriggered",
            Ev::CondCanceled { .. } => "CondCanceled",
            Ev::AgentApproved { .. } => "AgentApproved",
            Ev::IsolatedMode { .. } => "IsolatedMode",
            Ev::IsoMargin { .. } => "IsoMargin",
            Ev::TwapPlaced { .. } => "TwapPlaced",
            Ev::TwapSlice { .. } => "TwapSlice",
            Ev::TwapDone { .. } => "TwapDone",
            Ev::TwapCanceled { .. } => "TwapCanceled",
            Ev::AdlExecuted { .. } => "AdlExecuted",
            Ev::Recapitalized { .. } => "Recapitalized",
            Ev::BackstopSynced { .. } => "BackstopSynced",
            Ev::AdlSkipped { .. } => "AdlSkipped",
            Ev::AdlHardPremSet { .. } => "AdlHardPremSet",
            Ev::WithdrawGateSet { .. } => "WithdrawGateSet",
            Ev::BackstopElevated { .. } => "BackstopElevated",
            Ev::BackstopRelaxed { .. } => "BackstopRelaxed",
            Ev::BackstopTaken { .. } => "BackstopTaken",
            Ev::BackstopUnwound { .. } => "BackstopUnwound",
            Ev::BackstopCfgSet { .. } => "BackstopCfgSet",
            Ev::BackstopPlaceOpenSet { .. } => "BackstopPlaceOpenSet",
            Ev::BackstopTakeFeeSet { .. } => "BackstopTakeFeeSet",
            Ev::Other { name } => name,
        }
    }
}

// ---------------------------------------------------------------------------------------------- decoding

pub struct Decoder {
    by_selector: HashMap<B256, Event>,
}

/// A raw log as returned by `eth_getLogs`, already validated for the fields we need.
#[derive(Clone, Debug)]
pub struct RawLog {
    pub block: u64,
    pub log_index: u32,
    pub tx_hash: B256,
    pub block_hash: B256,
    pub topics: Vec<B256>,
    pub data: Vec<u8>,
}

impl RawLog {
    pub fn from_json(v: &serde_json::Value) -> anyhow::Result<Self> {
        let q = |k: &str| -> anyhow::Result<u64> {
            let s = v.get(k).and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("log missing {k}"))?;
            Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
        };
        let h = |k: &str| -> anyhow::Result<B256> {
            let s = v.get(k).and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("log missing {k}"))?;
            Ok(s.parse()?)
        };
        if v.get("removed").and_then(|x| x.as_bool()).unwrap_or(false) {
            anyhow::bail!("node returned a removed log (reorg in flight)");
        }
        let topics = v
            .get("topics")
            .and_then(|x| x.as_array())
            .ok_or_else(|| anyhow::anyhow!("log missing topics"))?
            .iter()
            .map(|t| t.as_str().unwrap_or("").parse::<B256>().map_err(anyhow::Error::from))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let data_s = v.get("data").and_then(|x| x.as_str()).unwrap_or("0x");
        let data = hex_to_bytes(data_s)?;
        Ok(Self {
            block: q("blockNumber")?,
            log_index: q("logIndex")? as u32,
            tx_hash: h("transactionHash")?,
            block_hash: h("blockHash")?,
            topics,
            data,
        })
    }
}

pub fn hex_to_bytes(s: &str) -> anyhow::Result<Vec<u8>> {
    let s = s.trim_start_matches("0x");
    if !s.len().is_multiple_of(2) {
        anyhow::bail!("odd hex length");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Into::into))
        .collect()
}

struct Args {
    m: HashMap<String, DynSolValue>,
}

fn sat_u128(v: U256) -> u128 {
    u128::try_from(v).unwrap_or(u128::MAX)
}
fn sat_i128(v: I256) -> i128 {
    i128::try_from(v).unwrap_or(if v.is_negative() { i128::MIN } else { i128::MAX })
}

impl Args {
    fn get(&self, k: &str) -> anyhow::Result<&DynSolValue> {
        self.m.get(k).ok_or_else(|| anyhow::anyhow!("missing event arg {k}"))
    }
    fn u(&self, k: &str) -> anyhow::Result<U256> {
        match self.get(k)? {
            DynSolValue::Uint(v, _) => Ok(*v),
            o => anyhow::bail!("arg {k}: expected uint, got {o:?}"),
        }
    }
    fn u128(&self, k: &str) -> anyhow::Result<u128> {
        Ok(sat_u128(self.u(k)?))
    }
    fn u64(&self, k: &str) -> anyhow::Result<u64> {
        Ok(u64::try_from(self.u(k)?)?)
    }
    fn opt_u64(&self, k: &str) -> anyhow::Result<Option<u64>> {
        if self.m.contains_key(k) {
            Ok(Some(self.u64(k)?))
        } else {
            Ok(None)
        }
    }
    fn u32(&self, k: &str) -> anyhow::Result<u32> {
        Ok(u32::try_from(self.u(k)?)?)
    }
    fn u16(&self, k: &str) -> anyhow::Result<u16> {
        Ok(u16::try_from(self.u(k)?)?)
    }
    fn u8(&self, k: &str) -> anyhow::Result<u8> {
        Ok(u8::try_from(self.u(k)?)?)
    }
    fn i128(&self, k: &str) -> anyhow::Result<i128> {
        match self.get(k)? {
            DynSolValue::Int(v, _) => Ok(sat_i128(*v)),
            o => anyhow::bail!("arg {k}: expected int, got {o:?}"),
        }
    }
    fn b(&self, k: &str) -> anyhow::Result<bool> {
        match self.get(k)? {
            DynSolValue::Bool(v) => Ok(*v),
            o => anyhow::bail!("arg {k}: expected bool, got {o:?}"),
        }
    }
    fn addr(&self, k: &str) -> anyhow::Result<Address> {
        match self.get(k)? {
            DynSolValue::Address(v) => Ok(*v),
            o => anyhow::bail!("arg {k}: expected address, got {o:?}"),
        }
    }
    fn b32(&self, k: &str) -> anyhow::Result<B256> {
        match self.get(k)? {
            DynSolValue::FixedBytes(v, _) => Ok(*v),
            o => anyhow::bail!("arg {k}: expected bytes32, got {o:?}"),
        }
    }
}

impl Decoder {
    pub fn from_abi_json(json: &str) -> anyhow::Result<Self> {
        let abi: JsonAbi = serde_json::from_str(json)?;
        let mut by_selector = HashMap::new();
        for e in abi.events() {
            by_selector.insert(e.selector(), e.clone());
        }
        Ok(Self { by_selector })
    }

    pub fn embedded() -> anyhow::Result<Self> {
        Self::from_abi_json(include_str!("../abi/PerpExchange.merged.json"))
    }

    /// Number of distinct event signatures in the ABI (used by tests to assert the ABI was loaded).
    pub fn event_count(&self) -> usize {
        self.by_selector.len()
    }

    /// Decode one log. Never fails on an unrecognised log: a selector that is not in the embedded ABI (a newer
    /// contract version) or a payload that does not match it is stored as `Ev::Other` with the raw topics/data, so
    /// ingestion keeps going and `reindex-from-raw` can re-derive the event once the ABI is refreshed.
    pub fn decode(&self, log: &RawLog, ts: u64) -> anyhow::Result<EventRecord> {
        Ok(EventRecord {
            meta: Meta {
                block: log.block,
                log_index: log.log_index,
                tx_hash: log.tx_hash,
                block_hash: log.block_hash,
                ts,
            },
            ev: self.decode_ev(&log.topics, &log.data),
            raw: Some(RawData {
                topics: log.topics.clone(),
                data: log.data.clone(),
            }),
        })
    }

    pub fn decode_ev(&self, topics: &[B256], data: &[u8]) -> Ev {
        let Some(topic0) = topics.first() else {
            return Ev::Other {
                name: format!("{UNDECODABLE_PREFIX}anonymous"),
            };
        };
        let Some(ev) = self.by_selector.get(topic0) else {
            return Ev::Other {
                name: format!("{UNKNOWN_PREFIX}{topic0}"),
            };
        };
        match self.try_decode(ev, topics, data) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(event = %ev.name, error = %format!("{e:#}"), "event in ABI but payload did not decode; stored raw as Other");
                Ev::Other {
                    name: format!("{UNDECODABLE_PREFIX}{}", ev.name),
                }
            }
        }
    }

    fn try_decode(&self, ev: &Event, topics: &[B256], data: &[u8]) -> anyhow::Result<Ev> {
        let d = ev.decode_log_parts(topics.iter().copied(), data)?;
        let mut idx = d.indexed.into_iter();
        let mut body = d.body.into_iter();
        let mut m = HashMap::new();
        for p in &ev.inputs {
            let v = if p.indexed { idx.next() } else { body.next() };
            m.insert(p.name.clone(), v.ok_or_else(|| anyhow::anyhow!("event arg count mismatch"))?);
        }
        build(&ev.name, &Args { m })
    }
}

fn build(name: &str, a: &Args) -> anyhow::Result<Ev> {
    Ok(match name {
        "Deposit" => Ev::Deposit {
            acct: a.b32("acct")?,
            from: a.addr("from")?,
            amount: a.u128("amount")?,
        },
        "Withdraw" => Ev::Withdraw {
            acct: a.b32("acct")?,
            amount: a.u128("amount")?,
        },
        "InternalTransfer" => Ev::InternalTransfer {
            from: a.b32("from")?,
            to: a.b32("to")?,
            amount: a.u128("amount")?,
        },
        "OrderAccepted" => Ev::OrderAccepted {
            id: a.u64("id")?,
            acct: a.b32("acct")?,
            market: a.u8("market")?,
            is_buy: a.b("isBuy")?,
            price: a.u64("price")?,
            size: a.u128("size")?,
            tif: a.u8("tif")?,
            reduce_only: a.b("reduceOnly")?,
            cloid: a.u64("cloid")?,
        },
        "OrderRested" => Ev::OrderRested {
            id: a.u64("id")?,
            remaining: a.u128("remaining")?,
        },
        "OrderCanceled" => Ev::OrderCanceled {
            id: a.u64("id")?,
            reason: a.u8("reason")?,
            remaining: a.u128("remaining")?,
        },
        "OrderTruncated" => Ev::OrderTruncated {
            id: a.u64("id")?,
            remaining: a.u128("remaining")?,
        },
        "Fill" => Ev::Fill {
            trade_id: a.u64("tradeId")?,
            market: a.u8("market")?,
            maker_order_id: a.u64("makerOrderId")?,
            maker: a.b32("maker")?,
            taker: a.b32("taker")?,
            taker_is_buy: a.b("takerIsBuy")?,
            price: a.u64("price")?,
            size: a.u128("size")?,
            taker_fee: a.u128("takerFee")?,
            maker_fee: a.i128("makerFee")?,
        },
        "Liquidated" => Ev::Liquidated {
            acct: a.b32("acct")?,
            market: a.u8("market")?,
            keeper: a.addr("keeper")?,
            size: a.u128("size")?,
            price: a.u64("price")?,
            fee: a.u128("fee")?,
            bad_debt: a.u128("badDebt")?,
        },
        "BadDebtUnresolved" => Ev::BadDebtUnresolved {
            acct: a.b32("acct")?,
            amount: a.u128("amount")?,
        },
        "FundingUpdated" => Ev::FundingUpdated {
            market: a.u8("market")?,
            intervals: a.u128("intervals")?,
            rate: a.i128("rate")?,
            new_index: a.i128("newIndex")?,
        },
        "FundingSettled" => Ev::FundingSettled {
            acct: a.b32("acct")?,
            market: a.u8("market")?,
            owed: a.i128("owed")?,
        },
        "MarketState" => Ev::MarketState {
            market: a.u8("market")?,
            state: a.u8("s")?,
        },
        "CondPlaced" => Ev::CondPlaced {
            id: a.u64("id")?,
            acct: a.b32("acct")?,
            market: a.u8("market")?,
            is_buy: a.b("isBuy")?,
            above: a.b("above")?,
            trigger: a.u64("trigger")?,
            limit: a.u64("limit")?,
            size: a.u128("size")?,
            reduce_only: a.b("reduceOnly")?,
            sibling: a.u64("sibling")?,
        },
        "CondTriggered" => Ev::CondTriggered {
            id: a.u64("id")?,
            mark_price: a.u64("markPrice")?,
        },
        "CondCanceled" => Ev::CondCanceled { id: a.u64("id")? },
        "AgentApproved" => Ev::AgentApproved {
            acct: a.b32("acct")?,
            agent: a.addr("agent")?,
            expiry: a.u64("expiry")?,
        },
        "IsolatedMode" => Ev::IsolatedMode {
            acct: a.b32("acct")?,
            market: a.u8("market")?,
            on: a.b("on")?,
        },
        "IsoMargin" => Ev::IsoMargin {
            acct: a.b32("acct")?,
            market: a.u8("market")?,
            delta: a.i128("delta")?,
        },
        "TwapPlaced" => Ev::TwapPlaced {
            id: a.u64("id")?,
            acct: a.b32("acct")?,
            market: a.u8("market")?,
            is_buy: a.b("isBuy")?,
            total: a.u128("total")?,
            slices: a.u16("slices")?,
            interval: a.u32("interval")?,
            slippage_bps: a.u32("slippageBps")?,
            reduce_only: a.b("reduceOnly")?,
        },
        "TwapSlice" => Ev::TwapSlice {
            id: a.u64("id")?,
            slice_index: a.u16("sliceIndex")?,
            filled: a.u128("filled")?,
            ok: a.b("ok")?,
        },
        "TwapDone" => Ev::TwapDone {
            id: a.u64("id")?,
            filled: a.u128("filled")?,
            failed: a.u16("failed")?,
        },
        "TwapCanceled" => Ev::TwapCanceled {
            id: a.u64("id")?,
            filled: a.u128("filled")?,
        },
        "AdlExecuted" => Ev::AdlExecuted {
            target: a.b32("target")?,
            market: a.u8("market")?,
            size: a.u128("size")?,
            price: a.u64("price")?,
            debt_cleared: a.u128("debtCleared")?,
            mark_price: a.opt_u64("markPrice")?,
        },
        "Recapitalized" => Ev::Recapitalized {
            market: a.u8("market")?,
            from: a.addr("from")?,
            amount: a.u128("amount")?,
        },
        "BackstopSynced" => Ev::BackstopSynced {
            equity_before: a.i128("equityBefore")?,
            from_insurance: a.u128("fromInsurance")?,
            to_debt: a.u128("toDebt")?,
            market: a.u8("market")?,
            refunded_insurance: a.u128("refundedInsurance")?,
            repaid_debt: a.u128("repaidDebt")?,
        },
        "AdlSkipped" => Ev::AdlSkipped {
            target: a.b32("target")?,
            market: a.u8("market")?,
            slack: a.u128("slack")?,
        },
        "AdlHardPremSet" => Ev::AdlHardPremSet { bps: a.u32("bps")? },
        "WithdrawGateSet" => Ev::WithdrawGateSet { threshold: a.u128("threshold")? },
        "BackstopElevated" => Ev::BackstopElevated { market: a.u8("market")?, notional: a.u128("notional")? },
        "BackstopRelaxed" => Ev::BackstopRelaxed { market: a.u8("market")? },
        "BackstopTaken" => Ev::BackstopTaken {
            market: a.u8("market")?,
            taker: a.addr("taker")?,
            acct: a.b32("acct")?,
            taker_sold: a.b("takerSold")?,
            size: a.u128("size")?,
            price: a.u64("price")?,
            disc_bps: a.u128("discBps")?,
            fee: a.u128("fee")?,
        },
        "BackstopUnwound" => Ev::BackstopUnwound {
            market: a.u8("market")?,
            target: a.b32("target")?,
            size: a.u128("size")?,
            price: a.u64("price")?,
        },
        "BackstopCfgSet" => Ev::BackstopCfgSet {
            market: a.u8("market")?,
            soft_notional: a.u128("softNotional")?,
            max_disc_bps: a.u16("maxDiscBps")?,
            dwell: a.u32("dwell")?,
            ramp: a.u32("ramp")?,
            max_age: a.u32("maxAge")?,
        },
        "BackstopPlaceOpenSet" => Ev::BackstopPlaceOpenSet { open: a.b("open")? },
        "BackstopTakeFeeSet" => Ev::BackstopTakeFeeSet { bps: a.u32("bps")? },
        other => Ev::Other { name: other.to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_loads_and_covers_core_events() {
        let d = Decoder::embedded().unwrap();
        assert!(d.event_count() >= 25, "merged ABI should expose all exchange events, got {}", d.event_count());
        // every Ev variant name that is not Other must exist in the ABI
        let names: std::collections::HashSet<_> = d.by_selector.values().map(|e| e.name.clone()).collect();
        for n in [
            "Deposit",
            "Withdraw",
            "OrderAccepted",
            "Fill",
            "Liquidated",
            "FundingUpdated",
            "TwapPlaced",
            "AdlExecuted",
            "CondPlaced",
            "IsoMargin",
            "BackstopSynced",
            "AdlSkipped",
            "AdlHardPremSet",
            "WithdrawGateSet",
            "BackstopElevated",
            "BackstopRelaxed",
            "BackstopTaken",
            "BackstopUnwound",
            "BackstopCfgSet",
            "BackstopPlaceOpenSet",
            "BackstopTakeFeeSet",
        ] {
            assert!(names.contains(n), "{n} missing from ABI");
        }
    }

    #[test]
    fn decodes_a_fill_log() {
        // Build the log by ABI-encoding with alloy so the test does not depend on a node.
        use alloy_dyn_abi::DynSolValue as V;
        let d = Decoder::embedded().unwrap();
        let ev = d.by_selector.values().find(|e| e.name == "Fill").unwrap().clone();
        let maker = B256::repeat_byte(0xaa);
        let taker = B256::repeat_byte(0xbb);
        let body = V::Tuple(vec![
            V::Uint(U256::from(7u64), 64),
            V::FixedBytes(maker, 32),
            V::FixedBytes(taker, 32),
            V::Bool(true),
            V::Uint(U256::from(50_000_000_000u64), 64),
            V::Uint(U256::from(40_000_000u64), 128),
            V::Uint(U256::from(10_000_000u64), 256),
            V::Int(I256::try_from(-5i64).unwrap(), 256),
        ]);
        let data = body.abi_encode_params();
        let topics = vec![ev.selector(), B256::from(U256::from(3u64)), B256::from(U256::from(0u64))];
        let log = RawLog {
            block: 5,
            log_index: 2,
            tx_hash: B256::ZERO,
            block_hash: B256::ZERO,
            topics,
            data,
        };
        let rec = d.decode(&log, 1000).unwrap();
        match rec.ev {
            Ev::Fill {
                trade_id,
                market,
                maker_order_id,
                price,
                size,
                taker_fee,
                maker_fee,
                taker_is_buy,
                ..
            } => {
                assert_eq!(
                    (trade_id, market, maker_order_id, price, size, taker_fee, maker_fee, taker_is_buy),
                    (3, 0, 7, 50_000_000_000, 40_000_000, 10_000_000, -5, true)
                );
            }
            o => panic!("wrong variant {o:?}"),
        }
        assert_eq!(rec.meta.key(), (5u128 << 32) | 2);
    }

    #[test]
    fn ev_json_roundtrip() {
        let e = Ev::Fill {
            trade_id: 1,
            market: 0,
            maker_order_id: 2,
            maker: B256::ZERO,
            taker: B256::ZERO,
            taker_is_buy: false,
            price: u64::MAX,
            size: u128::MAX,
            taker_fee: 5,
            maker_fee: i128::MIN,
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: Ev = serde_json::from_str(&s).unwrap();
        assert_eq!(e, back);
    }
}
