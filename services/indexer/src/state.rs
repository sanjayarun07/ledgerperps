//! The read model: a *pure, deterministic reducer* over the ordered event log.
//!
//! `State::apply` is the only way read models change. It is
//!  * idempotent: an event whose `(block, log_index)` key is <= the last applied key is skipped, so feeding the same
//!    logs twice is identical to feeding them once;
//!  * deterministic: no clocks, randomness or I/O, so a fresh replay of the persisted event log reconstructs
//!    byte-identical read models (see `digest`), and a reorg rollback is "truncate the log, replay".
//!
//! NOTE: everything here is *derived* from logs. Balances/collateral are NOT tracked and must never be taken from
//! this service; the chain is authoritative.

use crate::events::{cancel, Ev, EventRecord, Meta};
use crate::ser::*;
use alloy_primitives::{keccak256, Address, B256, I256};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};

/// Aliases (not literal `&'static str`) so serde's derive does not infer a `'de: 'static` bound; values are interned
/// from a fixed table when a snapshot is loaded (`ser::d_static`).
pub type Lbl = &'static str;
pub type OptLbl = Option<&'static str>;

pub const SIZE_SCALE: i128 = 100_000_000;

/// `(price, total size)` pairs.
pub type Levels = Vec<(u64, u128)>;

// ------------------------------------------------------------------------------------------------ enums

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Interval {
    #[serde(rename = "1m")]
    M1,
    #[serde(rename = "5m")]
    M5,
    #[serde(rename = "1h")]
    H1,
}

impl Interval {
    pub const ALL: [Interval; 3] = [Interval::M1, Interval::M5, Interval::H1];
    pub fn secs(self) -> u64 {
        match self {
            Interval::M1 => 60,
            Interval::M5 => 300,
            Interval::H1 => 3600,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Interval::M1 => "1m",
            Interval::M5 => "5m",
            Interval::H1 => "1h",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "1m" => Some(Interval::M1),
            "5m" => Some(Interval::M5),
            "1h" => Some(Interval::H1),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Accepted,
    Open,
    PartiallyFilled,
    Filled,
    Canceled,
    Expired,
    Rejected,
}

impl OrderStatus {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "accepted" => Self::Accepted,
            "open" => Self::Open,
            "partially_filled" => Self::PartiallyFilled,
            "filled" => Self::Filled,
            "canceled" => Self::Canceled,
            "expired" => Self::Expired,
            "rejected" => Self::Rejected,
            _ => return None,
        })
    }
}

/// Order status as a pure function of aggregate facts (so replay order inside a block cannot matter).
///
/// * `Filled` cancel reason => filled (the contract emits `OrderCanceled(Filled)` *before* the final `Fill`).
/// * `Expired` => expired.
/// * system cancels of a resting maker with zero fills (self-trade, invalid reduce-only, maker margin) => rejected.
///   Orders that revert on-chain emit no events and are therefore invisible to the indexer.
/// * other cancels => canceled (including IOC remainders after partial fills).
/// * no cancel: filled>=size => filled; rested => open / partially_filled; otherwise accepted (transient in-tx state).
pub fn derive_status(filled: u128, size: u128, rested: bool, cancel_reason: Option<u8>) -> OrderStatus {
    match cancel_reason {
        Some(cancel::FILLED) => OrderStatus::Filled,
        Some(cancel::EXPIRED) => OrderStatus::Expired,
        Some(cancel::SELF_TRADE) | Some(cancel::INVALID_REDUCE_ONLY) | Some(cancel::MAKER_MARGIN) => {
            if filled == 0 {
                OrderStatus::Rejected
            } else {
                OrderStatus::Canceled
            }
        }
        Some(_) => OrderStatus::Canceled,
        None => {
            if filled >= size {
                OrderStatus::Filled
            } else if rested {
                if filled > 0 {
                    OrderStatus::PartiallyFilled
                } else {
                    OrderStatus::Open
                }
            } else {
                OrderStatus::Accepted
            }
        }
    }
}

fn tif_name(t: u8) -> &'static str {
    match t {
        0 => "gtc",
        1 => "ioc",
        2 => "fok",
        3 => "post_only",
        _ => "unknown",
    }
}

pub fn market_state_name(s: u8) -> &'static str {
    match s {
        0 => "normal",
        1 => "reduce_only",
        2 => "oracle_degraded",
        3 => "paused",
        4 => "recovery",
        _ => "unknown",
    }
}

// ------------------------------------------------------------------------------------------------ rows

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParentRef {
    #[serde(deserialize_with = "d_static")]
    pub kind: Lbl,
    pub id: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrderRow {
    pub id: u64,
    pub acct: B256,
    pub market: u8,
    #[serde(deserialize_with = "d_static")]
    pub side: Lbl,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub price: u64,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub size: u128,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub filled: u128,
    /// Quantity still resting on the book (0 unless open / partially_filled).
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub remaining: u128,
    #[serde(serialize_with = "opt_u128s", deserialize_with = "d_opt_u128")]
    pub avg_fill_price: Option<u128>,
    pub status: OrderStatus,
    #[serde(deserialize_with = "d_static")]
    pub tif: Lbl,
    pub reduce_only: bool,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub cloid: u64,
    #[serde(with = "opt_static")]
    pub cancel_reason: OptLbl,
    pub truncated: bool,
    pub parent: Option<ParentRef>,
    pub created_block: u64,
    pub created_ts: u64,
    pub updated_block: u64,
    pub updated_ts: u64,
    pub tx_hash: B256,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub is_buy: bool,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub rested: bool,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub cancel_code: Option<u8>,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub fill_value: u128,
}

impl OrderRow {
    fn refresh(&mut self) {
        self.status = derive_status(self.filled, self.size, self.rested, self.cancel_code);
        self.avg_fill_price = self.fill_value.checked_div(self.filled);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FillRow {
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub trade_id: u64,
    pub market: u8,
    pub maker_order_id: u64,
    pub taker_order_id: Option<u64>,
    pub maker: B256,
    pub taker: B256,
    #[serde(deserialize_with = "d_static")]
    pub taker_side: Lbl,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub price: u64,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub size: u128,
    /// price * size / 1e8, floored (USDC 1e6).
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub notional: u128,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub taker_fee: u128,
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub maker_fee: i128,
    pub block: u64,
    pub log_index: u32,
    pub ts: u64,
    pub tx_hash: B256,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub key: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Candle {
    /// bucket start (unix seconds)
    pub t: u64,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub o: u64,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub h: u64,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub l: u64,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub c: u64,
    /// base volume (1e8 scale)
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub v: u128,
    /// quote volume (USDC 1e6)
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub qv: u128,
    pub n: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PositionRow {
    pub acct: B256,
    pub market: u8,
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub size: i128,
    /// signed sum(size*price) (contract `basis`, 1e14 scale)
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub basis: i128,
    /// |basis|/|size| floored (price units), None when flat
    #[serde(serialize_with = "opt_u128s", deserialize_with = "d_opt_u128")]
    pub entry_price: Option<u128>,
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub realized_pnl: i128,
    /// taker fees paid + maker fees (negative = rebate), 1e6
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub fees_paid: i128,
    /// funding owed, positive = paid by the account, 1e6
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub funding_paid: i128,
    /// true when ADL touched a backstop leg whose fill price is not in the event. Size and basis stay exact (an ADL
    /// leg only *reduces* the backstop, and a reduction removes basis pro rata, independent of price); only
    /// `realized_pnl` uses an estimated price (from `AdlExecuted.debtCleared/size`), within `realized_pnl_error_bound`.
    pub approximate: bool,
    /// Upper bound of |realized_pnl - on-chain realised pnl| from estimated ADL backstop prices (USDC 1e6 units).
    /// 0 when `approximate` is false.
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128", default)]
    pub realized_pnl_error_bound: u128,
    pub updated_block: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FundingUpdateRow {
    pub market: u8,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub intervals: u128,
    /// per-interval rate, 1e12 = 100%
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub rate: i128,
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub new_index: i128,
    pub block: u64,
    pub log_index: u32,
    pub ts: u64,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub key: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FundingSettleRow {
    pub acct: B256,
    pub market: u8,
    /// positive = account paid
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub owed: i128,
    pub block: u64,
    pub log_index: u32,
    pub ts: u64,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub key: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiquidationRow {
    pub acct: B256,
    pub market: u8,
    pub keeper: Address,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub size: u128,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub price: u64,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub fee: u128,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub bad_debt: u128,
    pub block: u64,
    pub log_index: u32,
    pub ts: u64,
    pub tx_hash: B256,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub key: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BadDebtRow {
    /// bad_debt_unresolved | adl | recapitalized
    #[serde(deserialize_with = "d_static")]
    pub kind: Lbl,
    pub acct: Option<B256>,
    pub market: Option<u8>,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub amount: u128,
    #[serde(serialize_with = "opt_u128s", deserialize_with = "d_opt_u128")]
    pub size: Option<u128>,
    #[serde(serialize_with = "opt_u64s", deserialize_with = "d_opt_u64")]
    pub price: Option<u64>,
    pub block: u64,
    pub log_index: u32,
    pub ts: u64,
    pub tx_hash: B256,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub key: u128,
}

/// Backstop / ADL-safety / withdrawal-gate events (served at `/v1/backstop/events`). Amounts are decimal strings (micro-USDC, 1e6) or null.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackstopRow {
    /// backstop_synced | adl_skipped | adl_hard_prem_set | withdraw_gate_set
    #[serde(deserialize_with = "d_static")]
    pub kind: Lbl,
    pub market: Option<u8>,
    pub target: Option<B256>,
    pub equity_before: Option<String>,
    pub from_insurance: Option<String>,
    pub to_debt: Option<String>,
    pub refunded_insurance: Option<String>,
    pub repaid_debt: Option<String>,
    pub slack: Option<String>,
    pub bps: Option<u32>,
    pub threshold: Option<String>,
    pub block: u64,
    pub log_index: u32,
    pub ts: u64,
    pub tx_hash: B256,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub key: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferRow {
    /// deposit | withdraw | internal_transfer | iso_margin
    #[serde(deserialize_with = "d_static")]
    pub kind: Lbl,
    pub acct: B256,
    pub counterparty: Option<B256>,
    pub from_address: Option<Address>,
    pub market: Option<u8>,
    /// USDC 1e6; negative only for iso_margin removals
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub amount: i128,
    pub block: u64,
    pub log_index: u32,
    pub ts: u64,
    pub tx_hash: B256,
    #[serde(skip_serializing_if = "hide_unless_snapshot", default)]
    pub key: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SliceRow {
    pub index: u16,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub filled: u128,
    pub ok: bool,
    pub block: u64,
    pub ts: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TwapRow {
    pub id: u64,
    pub acct: B256,
    pub market: u8,
    #[serde(deserialize_with = "d_static")]
    pub side: Lbl,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub total: u128,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub filled: u128,
    pub slices: u16,
    pub slices_done: u16,
    pub slices_failed: u16,
    pub interval_secs: u32,
    pub slippage_bps: u32,
    pub reduce_only: bool,
    /// active | done | canceled
    #[serde(deserialize_with = "d_static")]
    pub status: Lbl,
    pub slice_log: Vec<SliceRow>,
    pub created_block: u64,
    pub created_ts: u64,
    pub updated_block: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CondRow {
    pub id: u64,
    pub acct: B256,
    pub market: u8,
    #[serde(deserialize_with = "d_static")]
    pub side: Lbl,
    /// fire when mark >= trigger (true) or <= trigger (false)
    pub above: bool,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub trigger: u64,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub limit: u64,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub size: u128,
    pub reduce_only: bool,
    pub sibling: u64,
    /// active | triggered | canceled
    #[serde(deserialize_with = "d_static")]
    pub status: Lbl,
    #[serde(serialize_with = "opt_u64s", deserialize_with = "d_opt_u64")]
    pub trigger_mark_price: Option<u64>,
    pub created_block: u64,
    pub created_ts: u64,
    pub updated_block: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct MarketRow {
    pub id: u8,
    pub state: u8,
    #[serde(serialize_with = "opt_u64s", deserialize_with = "d_opt_u64")]
    pub last_price: Option<u64>,
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub funding_rate: i128,
    #[serde(serialize_with = "i128s", deserialize_with = "d_i128")]
    pub funding_index: i128,
    pub last_funding_ts: Option<u64>,
    /// sum of long position sizes (contract definition of open interest), 1e8
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub open_interest: u128,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub volume_base: u128,
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub volume_quote: u128,
    pub trade_count: u64,
}

/// Static market configuration, read via eth_call at startup (not event-derived; excluded from `digest`).
#[derive(Clone, Debug, Serialize, Default, PartialEq, Eq)]
pub struct MarketMeta {
    pub name: Option<String>,
    pub tick: Option<u64>,
    pub lot: Option<u64>,
    pub min_notional: Option<u64>,
    pub max_order_size: Option<String>,
    pub max_oi: Option<String>,
    pub funding_interval: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BookDelta {
    pub market: u8,
    pub seq: u64,
    /// "bid" | "ask"
    #[serde(deserialize_with = "d_static")]
    pub side: Lbl,
    #[serde(serialize_with = "u64s", deserialize_with = "d_u64")]
    pub price: u64,
    /// new total size at this level (0 = level removed)
    #[serde(serialize_with = "u128s", deserialize_with = "d_u128")]
    pub size: u128,
}

#[derive(Clone, Debug, Default)]
pub struct Book {
    pub seq: u64,
    pub bids: BTreeMap<u64, u128>,
    pub asks: BTreeMap<u64, u128>,
}

/// Side-effects of applying an event, consumed by the websocket hub.
#[derive(Clone, Debug)]
pub enum Out {
    Book(BookDelta),
    Trade(FillRow),
    Candle { market: u8, interval: Interval, candle: Candle },
    Order(OrderRow),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Counters {
    pub applied: u64,
    pub duplicates_skipped: u64,
    pub unknown_refs: u64,
    pub overflow: u64,
    /// events stored as `Other` because their selector / shape is not in the embedded ABI (re-derivable from raw)
    #[serde(default)]
    pub undecoded: u64,
    pub by_name: BTreeMap<String, u64>,
}

// ------------------------------------------------------------------------------------------------ state

/// Default in-memory trade window (fills kept in RAM; older ones are served from Postgres).
pub const DEFAULT_MAX_FILLS: usize = 500_000;

pub struct State {
    pub last_key: Option<u128>,
    pub last_ts: u64,
    pub markets: BTreeMap<u8, MarketRow>,
    pub meta: BTreeMap<u8, MarketMeta>,
    pub orders: BTreeMap<u64, OrderRow>,
    pub orders_by_acct: HashMap<B256, Vec<u64>>,
    /// Bounded window of the most recent fills (ascending by key). Fills older than `fills_evicted_key` live only in
    /// the Postgres event log. `fills_base` is the absolute index of `fills[0]`; the `fills_by_*` indexes hold
    /// absolute indexes.
    pub fills: VecDeque<FillRow>,
    pub fills_base: u64,
    /// Key of the newest fill that was evicted from the window (None = nothing evicted, the window is complete).
    pub fills_evicted_key: Option<u128>,
    pub max_fills: usize,
    pub fills_by_market: HashMap<u8, VecDeque<u64>>,
    pub fills_by_acct: HashMap<B256, VecDeque<u64>>,
    pub books: BTreeMap<u8, Book>,
    pub candles: BTreeMap<(u8, Interval), BTreeMap<u64, Candle>>,
    pub positions: BTreeMap<(B256, u8), PositionRow>,
    pub funding_updates: Vec<FundingUpdateRow>,
    pub funding_settles: Vec<FundingSettleRow>,
    pub funding_settles_by_acct: HashMap<B256, Vec<u32>>,
    pub liquidations: Vec<LiquidationRow>,
    pub bad_debt: Vec<BadDebtRow>,
    pub backstop: Vec<BackstopRow>,
    pub transfers: Vec<TransferRow>,
    pub transfers_by_acct: HashMap<B256, Vec<u32>>,
    pub twaps: BTreeMap<u64, TwapRow>,
    pub conds: BTreeMap<u64, CondRow>,
    pub counters: Counters,
    // per-transaction context (reset whenever the tx hash changes)
    cur_tx: Option<B256>,
    last_taker: Option<u64>,
    last_accepted: Option<u64>,
    pending_parent: Option<(B256, ParentRef)>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            last_key: None,
            last_ts: 0,
            markets: BTreeMap::new(),
            meta: BTreeMap::new(),
            orders: BTreeMap::new(),
            orders_by_acct: HashMap::new(),
            fills: VecDeque::new(),
            fills_base: 0,
            fills_evicted_key: None,
            max_fills: DEFAULT_MAX_FILLS,
            fills_by_market: HashMap::new(),
            fills_by_acct: HashMap::new(),
            books: BTreeMap::new(),
            candles: BTreeMap::new(),
            positions: BTreeMap::new(),
            funding_updates: Vec::new(),
            funding_settles: Vec::new(),
            funding_settles_by_acct: HashMap::new(),
            liquidations: Vec::new(),
            bad_debt: Vec::new(),
            backstop: Vec::new(),
            transfers: Vec::new(),
            transfers_by_acct: HashMap::new(),
            twaps: BTreeMap::new(),
            conds: BTreeMap::new(),
            counters: Counters::default(),
            cur_tx: None,
            last_taker: None,
            last_accepted: None,
            pending_parent: None,
        }
    }
}

pub fn backstop_key() -> B256 {
    keccak256("PERP.BACKSTOP")
}

/// `keccak256(abi.encode(owner, sub))` — mirrors `PerpBase.acctKey`.
pub fn acct_key(owner: Address, sub: u8) -> B256 {
    let mut buf = [0u8; 64];
    buf[12..32].copy_from_slice(owner.as_slice());
    buf[63] = sub;
    keccak256(buf)
}

fn i256(v: i128) -> I256 {
    I256::try_from(v).unwrap_or(I256::ZERO)
}
fn sat(v: I256) -> (i128, bool) {
    match i128::try_from(v) {
        Ok(x) => (x, false),
        Err(_) => (if v.is_negative() { i128::MIN } else { i128::MAX }, true),
    }
}
/// Solidity-style `_fdiv`: floor division.
fn fdiv(a: I256, b: I256) -> I256 {
    let q = a / b;
    if (a % b != I256::ZERO) && (a.is_negative() != b.is_negative()) {
        q - I256::ONE
    } else {
        q
    }
}

/// Mirrors `PerpBase._applyFill` position accounting. Returns (realized pnl, overflowed).
pub fn apply_position_fill(size: &mut i128, basis: &mut i128, q: i128, px: u64) -> (i128, bool) {
    let old = i256(*size);
    let qq = i256(q);
    let pxx = I256::try_from(px).unwrap_or(I256::ZERO);
    let mut b = i256(*basis);
    let mut pnl = I256::ZERO;
    let nw = old + qq;
    if old == I256::ZERO || (old > I256::ZERO) == (qq > I256::ZERO) {
        b += qq * pxx;
    } else {
        let aq = qq.unsigned_abs();
        let ao = old.unsigned_abs();
        let closed = if aq < ao { aq } else { ao };
        let closed_s = I256::try_from(closed).unwrap_or(I256::ZERO);
        let ao_s = I256::try_from(ao).unwrap_or(I256::ONE);
        let rem_b = b * closed_s / ao_s;
        let val = if old > I256::ZERO { closed_s } else { -closed_s } * pxx;
        let scaled = val - rem_b;
        pnl = fdiv(scaled, i256(SIZE_SCALE));
        b -= rem_b;
        if aq > ao {
            let extra = I256::try_from(aq - ao).unwrap_or(I256::ZERO);
            b = if qq > I256::ZERO { extra * pxx } else { -(extra * pxx) };
        }
    }
    if nw == I256::ZERO {
        b = I256::ZERO;
    }
    let (s, o1) = sat(nw);
    let (bb, o2) = sat(b);
    let (p, o3) = sat(pnl);
    *size = s;
    *basis = bb;
    (p, o1 || o2 || o3)
}

/// Estimate the mark price used for the ADL backstop leg when the event does not carry it.
/// Contract: `pT = mk -/+ prem` for a long/short target and `debtCleared = floor(size*prem/1e8)`, so
/// `prem >= debtCleared*1e8/size` with error < `1e8/size + 1` price units.
pub fn adl_mark_estimate(target_long: bool, target_price: u64, size: u128, debt_cleared: u128) -> u64 {
    let prem = debt_cleared
        .saturating_mul(SIZE_SCALE as u128)
        .checked_div(size)
        .map_or(0, |v| u64::try_from(v).unwrap_or(u64::MAX));
    if target_long {
        target_price.saturating_add(prem)
    } else {
        target_price.saturating_sub(prem)
    }
}

/// Upper bound on the realised-PnL error of one estimated ADL backstop fill. The price error is < 1e8/size + 1 price
/// units, so the pnl error is < size*(1e8/size + 1)/1e8 = 1 + size/1e8 micro-USDC (+1 for flooring).
pub fn adl_pnl_error_bound(size: u128) -> u128 {
    (size / SIZE_SCALE as u128).saturating_add(2)
}

impl FillRow {
    /// Build a row from a stored `Fill` event. `taker_order_id` is the in-tx taker order (see the reducer).
    pub fn from_event(m: &Meta, ev: &Ev, taker_order_id: Option<u64>) -> Option<FillRow> {
        let Ev::Fill {
            trade_id,
            market,
            maker_order_id,
            maker,
            taker,
            taker_is_buy,
            price,
            size,
            taker_fee,
            maker_fee,
        } = ev
        else {
            return None;
        };
        Some(FillRow {
            trade_id: *trade_id,
            market: *market,
            maker_order_id: *maker_order_id,
            taker_order_id,
            maker: *maker,
            taker: *taker,
            taker_side: side(*taker_is_buy),
            price: *price,
            size: *size,
            notional: notional(*size, *price),
            taker_fee: *taker_fee,
            maker_fee: *maker_fee,
            block: m.block,
            log_index: m.log_index,
            ts: m.ts,
            tx_hash: m.tx_hash,
            key: m.key(),
        })
    }
}

fn notional(size: u128, px: u64) -> u128 {
    // floor(size*px/1e8) in 256-bit to avoid overflow
    let v = alloy_primitives::U256::from(size) * alloy_primitives::U256::from(px) / alloy_primitives::U256::from(SIZE_SCALE as u64);
    u128::try_from(v).unwrap_or(u128::MAX)
}

fn side(is_buy: bool) -> &'static str {
    if is_buy {
        "buy"
    } else {
        "sell"
    }
}

impl State {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fresh state that keeps the static (non-event) market metadata of `self`.
    pub fn fresh_like(&self) -> Self {
        let mut s = State::new();
        s.meta = self.meta.clone();
        s.max_fills = self.max_fills.max(1);
        s
    }

    /// Absolute-index accessor for the fill window.
    pub fn fill_abs(&self, abs: u64) -> &FillRow {
        &self.fills[(abs - self.fills_base) as usize]
    }

    fn push_fill(&mut self, row: FillRow) {
        let abs = self.fills_base + self.fills.len() as u64;
        let (market, maker, taker) = (row.market, row.maker, row.taker);
        self.fills.push_back(row);
        self.fills_by_market.entry(market).or_default().push_back(abs);
        self.fills_by_acct.entry(maker).or_default().push_back(abs);
        if taker != maker {
            self.fills_by_acct.entry(taker).or_default().push_back(abs);
        }
        self.evict_fills();
    }

    fn evict_fills(&mut self) {
        let max = self.max_fills.max(1);
        while self.fills.len() > max {
            let Some(f) = self.fills.pop_front() else { break };
            let abs = self.fills_base;
            self.fills_base += 1;
            self.fills_evicted_key = Some(f.key);
            if let Some(q) = self.fills_by_market.get_mut(&f.market) {
                if q.front() == Some(&abs) {
                    q.pop_front();
                }
                if q.is_empty() {
                    self.fills_by_market.remove(&f.market);
                }
            }
            for a in [f.maker, f.taker] {
                if let Some(q) = self.fills_by_acct.get_mut(&a) {
                    if q.front() == Some(&abs) {
                        q.pop_front();
                    }
                    if q.is_empty() {
                        self.fills_by_acct.remove(&a);
                    }
                }
            }
        }
    }

    pub fn apply_all(&mut self, recs: &[EventRecord]) -> Vec<Out> {
        let mut out = Vec::new();
        for r in recs {
            out.extend(self.apply(r));
        }
        out
    }

    fn ensure_market(&mut self, id: u8) -> &mut MarketRow {
        self.markets.entry(id).or_insert_with(|| MarketRow { id, ..Default::default() })
    }

    fn book_change(&mut self, market: u8, is_buy: bool, price: u64, delta: i128, out: &mut Vec<Out>) {
        if delta == 0 {
            return;
        }
        let b = self.books.entry(market).or_default();
        let lvl = if is_buy { &mut b.bids } else { &mut b.asks };
        let cur = lvl.get(&price).copied().unwrap_or(0);
        let nw = if delta >= 0 {
            cur.saturating_add(delta as u128)
        } else {
            cur.saturating_sub(delta.unsigned_abs())
        };
        if nw == 0 {
            lvl.remove(&price);
        } else {
            lvl.insert(price, nw);
        }
        b.seq += 1;
        out.push(Out::Book(BookDelta {
            market,
            seq: b.seq,
            side: if is_buy { "bid" } else { "ask" },
            price,
            size: nw,
        }));
    }

    /// Remove whatever the order still has resting on the book.
    fn book_remove_order(&mut self, id: u64, out: &mut Vec<Out>) {
        let Some(o) = self.orders.get(&id) else {
            return;
        };
        let (market, is_buy, price) = (o.market, o.is_buy, o.price);
        let rem = o.remaining;
        if rem > 0 {
            self.orders.get_mut(&id).unwrap().remaining = 0;
            self.book_change(market, is_buy, price, -(rem as i128), out);
        }
    }

    fn position_mut(&mut self, acct: B256, market: u8, block: u64) -> &mut PositionRow {
        let p = self.positions.entry((acct, market)).or_insert_with(|| PositionRow {
            acct,
            market,
            size: 0,
            basis: 0,
            entry_price: None,
            realized_pnl: 0,
            fees_paid: 0,
            funding_paid: 0,
            approximate: false,
            realized_pnl_error_bound: 0,
            updated_block: block,
        });
        p.updated_block = block;
        p
    }

    fn pos_fill(&mut self, acct: B256, market: u8, q: i128, px: u64, block: u64) {
        let (old_size, new_size, ov) = {
            let p = self.position_mut(acct, market, block);
            let old = p.size;
            let (pnl, ov) = apply_position_fill(&mut p.size, &mut p.basis, q, px);
            p.realized_pnl = p.realized_pnl.saturating_add(pnl);
            p.entry_price = if p.size != 0 {
                Some(p.basis.unsigned_abs() / p.size.unsigned_abs())
            } else {
                None
            };
            (old, p.size, ov)
        };
        if ov {
            self.counters.overflow += 1;
        }
        let oi_delta = new_size.max(0) - old_size.max(0);
        let m = self.ensure_market(market);
        m.open_interest = if oi_delta >= 0 {
            m.open_interest.saturating_add(oi_delta as u128)
        } else {
            m.open_interest.saturating_sub(oi_delta.unsigned_abs())
        };
    }

    fn add_fee(&mut self, acct: B256, market: u8, fee: i128, block: u64) {
        let p = self.position_mut(acct, market, block);
        p.fees_paid = p.fees_paid.saturating_add(fee);
    }

    fn roll_candles(&mut self, market: u8, ts: u64, px: u64, size: u128, quote: u128, out: &mut Vec<Out>) {
        for iv in Interval::ALL {
            let t = ts - ts % iv.secs();
            let map = self.candles.entry((market, iv)).or_default();
            let c = map.entry(t).or_insert(Candle {
                t,
                o: px,
                h: px,
                l: px,
                c: px,
                v: 0,
                qv: 0,
                n: 0,
            });
            c.h = c.h.max(px);
            c.l = c.l.min(px);
            c.c = px;
            c.v = c.v.saturating_add(size);
            c.qv = c.qv.saturating_add(quote);
            c.n += 1;
            out.push(Out::Candle {
                market,
                interval: iv,
                candle: c.clone(),
            });
        }
    }

    fn touch_order(&mut self, id: u64, block: u64, ts: u64, out: &mut Vec<Out>) {
        if let Some(o) = self.orders.get_mut(&id) {
            o.updated_block = block;
            o.updated_ts = ts;
            o.refresh();
            out.push(Out::Order(o.clone()));
        }
    }

    /// Apply one event. Returns side-effects for realtime fan-out. Idempotent on the event key.
    pub fn apply(&mut self, rec: &EventRecord) -> Vec<Out> {
        let m = &rec.meta;
        let key = m.key();
        if let Some(last) = self.last_key {
            if key <= last {
                self.counters.duplicates_skipped += 1;
                return vec![];
            }
        }
        self.last_key = Some(key);
        self.last_ts = self.last_ts.max(m.ts);
        self.counters.applied += 1;
        *self.counters.by_name.entry(rec.ev.name().to_string()).or_insert(0) += 1;
        if self.cur_tx != Some(m.tx_hash) {
            self.cur_tx = Some(m.tx_hash);
            self.last_taker = None;
            self.last_accepted = None;
            self.pending_parent = None;
        }
        let (block, ts, log_index, tx_hash) = (m.block, m.ts, m.log_index, m.tx_hash);
        let mut out = Vec::new();

        match &rec.ev {
            Ev::Deposit { acct, from, amount } => {
                self.push_transfer(TransferRow {
                    kind: "deposit",
                    acct: *acct,
                    counterparty: None,
                    from_address: Some(*from),
                    market: None,
                    amount: *amount as i128,
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::Withdraw { acct, amount } => {
                self.push_transfer(TransferRow {
                    kind: "withdraw",
                    acct: *acct,
                    counterparty: None,
                    from_address: None,
                    market: None,
                    amount: *amount as i128,
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::InternalTransfer { from, to, amount } => {
                self.push_transfer(TransferRow {
                    kind: "internal_transfer",
                    acct: *from,
                    counterparty: Some(*to),
                    from_address: None,
                    market: None,
                    amount: *amount as i128,
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::IsoMargin { acct, market, delta } => {
                self.push_transfer(TransferRow {
                    kind: "iso_margin",
                    acct: *acct,
                    counterparty: None,
                    from_address: None,
                    market: Some(*market),
                    amount: *delta,
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::OrderAccepted {
                id,
                acct,
                market,
                is_buy,
                price,
                size,
                tif,
                reduce_only,
                cloid,
            } => {
                self.ensure_market(*market);
                let parent = match &self.pending_parent {
                    Some((a, p)) if a == acct => Some(p.clone()),
                    _ => None,
                };
                if parent.is_some() {
                    self.pending_parent = None;
                }
                let row = OrderRow {
                    id: *id,
                    acct: *acct,
                    market: *market,
                    side: side(*is_buy),
                    price: *price,
                    size: *size,
                    filled: 0,
                    remaining: 0,
                    avg_fill_price: None,
                    status: OrderStatus::Accepted,
                    tif: tif_name(*tif),
                    reduce_only: *reduce_only,
                    cloid: *cloid,
                    cancel_reason: None,
                    truncated: false,
                    parent,
                    created_block: block,
                    created_ts: ts,
                    updated_block: block,
                    updated_ts: ts,
                    tx_hash,
                    is_buy: *is_buy,
                    rested: false,
                    cancel_code: None,
                    fill_value: 0,
                };
                if self.orders.insert(*id, row.clone()).is_none() {
                    self.orders_by_acct.entry(*acct).or_default().push(*id);
                }
                self.last_taker = Some(*id);
                self.last_accepted = Some(*id);
                out.push(Out::Order(row));
            }
            Ev::OrderRested { id, remaining } => {
                if let Some(o) = self.orders.get_mut(id) {
                    o.rested = true;
                    let (market, is_buy, price) = (o.market, o.is_buy, o.price);
                    let old = o.remaining;
                    o.remaining = *remaining;
                    self.book_change(market, is_buy, price, *remaining as i128 - old as i128, &mut out);
                    self.touch_order(*id, block, ts, &mut out);
                } else {
                    self.counters.unknown_refs += 1;
                }
            }
            Ev::OrderCanceled { id, reason, .. } => {
                if self.orders.contains_key(id) {
                    {
                        let o = self.orders.get_mut(id).unwrap();
                        o.cancel_code = Some(*reason);
                        o.cancel_reason = Some(cancel::name(*reason));
                    }
                    // `Filled` cancels are emitted *before* the final Fill; that Fill removes the last quantity
                    // from the book, so the level change is deferred to keep the delta stream consistent.
                    if *reason != cancel::FILLED {
                        self.book_remove_order(*id, &mut out);
                    }
                    self.touch_order(*id, block, ts, &mut out);
                } else {
                    self.counters.unknown_refs += 1;
                }
            }
            Ev::OrderTruncated { id, .. } => {
                if let Some(o) = self.orders.get_mut(id) {
                    o.truncated = true;
                    self.touch_order(*id, block, ts, &mut out);
                } else {
                    self.counters.unknown_refs += 1;
                }
            }
            Ev::Fill {
                trade_id: _,
                market,
                maker_order_id,
                maker,
                taker,
                taker_is_buy,
                price,
                size,
                taker_fee,
                maker_fee,
            } => {
                let taker_order_id = self
                    .last_taker
                    .filter(|t| self.orders.get(t).map(|o| o.acct == *taker && o.market == *market).unwrap_or(false));
                let row = FillRow::from_event(m, &rec.ev, taker_order_id).expect("Fill event");
                let n = row.notional;
                self.push_fill(row.clone());
                {
                    let mk = self.ensure_market(*market);
                    mk.last_price = Some(*price);
                    mk.volume_base = mk.volume_base.saturating_add(*size);
                    mk.volume_quote = mk.volume_quote.saturating_add(n);
                    mk.trade_count += 1;
                }
                // maker order
                if let Some(o) = self.orders.get_mut(maker_order_id) {
                    o.filled = o.filled.saturating_add(*size);
                    o.fill_value = o.fill_value.saturating_add(size.saturating_mul(*price as u128));
                    let (mkt, ib, px) = (o.market, o.is_buy, o.price);
                    let filled_out = o.cancel_code == Some(cancel::FILLED);
                    let reduce = if filled_out { o.remaining } else { (*size).min(o.remaining) };
                    o.remaining -= reduce;
                    self.book_change(mkt, ib, px, -(reduce as i128), &mut out);
                    self.touch_order(*maker_order_id, block, ts, &mut out);
                } else {
                    self.counters.unknown_refs += 1;
                }
                // taker order
                if let Some(t) = taker_order_id {
                    if let Some(o) = self.orders.get_mut(&t) {
                        o.filled = o.filled.saturating_add(*size);
                        o.fill_value = o.fill_value.saturating_add(size.saturating_mul(*price as u128));
                    }
                    self.touch_order(t, block, ts, &mut out);
                }
                // positions: maker is on the opposite side of the taker
                let sq = *size as i128;
                let (tq, mq) = if *taker_is_buy { (sq, -sq) } else { (-sq, sq) };
                self.pos_fill(*maker, *market, mq, *price, block);
                self.pos_fill(*taker, *market, tq, *price, block);
                self.add_fee(*taker, *market, *taker_fee as i128, block);
                self.add_fee(*maker, *market, *maker_fee, block);
                self.roll_candles(*market, ts, *price, *size, n, &mut out);
                out.push(Out::Trade(row));
            }
            Ev::Liquidated {
                acct,
                market,
                keeper,
                size,
                price,
                fee,
                bad_debt,
            } => {
                self.ensure_market(*market);
                let pos = self.positions.get(&(*acct, *market)).map(|p| p.size).unwrap_or(0);
                if pos != 0 {
                    let sq = *size as i128;
                    let q = if pos > 0 { -sq } else { sq };
                    self.pos_fill(*acct, *market, q, *price, block);
                    self.pos_fill(backstop_key(), *market, -q, *price, block);
                } else {
                    self.counters.unknown_refs += 1;
                }
                self.add_fee(*acct, *market, *fee as i128, block);
                self.liquidations.push(LiquidationRow {
                    acct: *acct,
                    market: *market,
                    keeper: *keeper,
                    size: *size,
                    price: *price,
                    fee: *fee,
                    bad_debt: *bad_debt,
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::BadDebtUnresolved { acct, amount } => {
                self.bad_debt.push(BadDebtRow {
                    kind: "bad_debt_unresolved",
                    acct: Some(*acct),
                    market: None,
                    amount: *amount,
                    size: None,
                    price: None,
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::AdlExecuted {
                target,
                market,
                size,
                price,
                debt_cleared,
                mark_price,
            } => {
                self.ensure_market(*market);
                let pos = self.positions.get(&(*target, *market)).map(|p| p.size).unwrap_or(0);
                if pos != 0 {
                    let sq = *size as i128;
                    let q = if pos > 0 { -sq } else { sq };
                    // the target's leg executes at `price` (= mark -/+ concession) => exact
                    self.pos_fill(*target, *market, q, *price, block);
                    // the backstop leg executes at mark. Newer contracts emit it (`markPrice`); older ones do not,
                    // in which case it is estimated from the concession: prem ~= debtCleared*1e8/size.
                    let (bs_px, exact) = match mark_price {
                        Some(mk) => (*mk, true),
                        None => (adl_mark_estimate(pos > 0, *price, *size, *debt_cleared), false),
                    };
                    self.pos_fill(backstop_key(), *market, -q, bs_px, block);
                    if !exact {
                        let bound = adl_pnl_error_bound(*size);
                        let bp = self.position_mut(backstop_key(), *market, block);
                        bp.approximate = true;
                        bp.realized_pnl_error_bound = bp.realized_pnl_error_bound.saturating_add(bound);
                    }
                } else {
                    self.counters.unknown_refs += 1;
                }
                self.bad_debt.push(BadDebtRow {
                    kind: "adl",
                    acct: Some(*target),
                    market: Some(*market),
                    amount: *debt_cleared,
                    size: Some(*size),
                    price: Some(*price),
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::Recapitalized { market, from: _, amount } => {
                self.bad_debt.push(BadDebtRow {
                    kind: "recapitalized",
                    acct: None,
                    market: Some(*market),
                    amount: *amount,
                    size: None,
                    price: None,
                    block,
                    log_index,
                    ts,
                    tx_hash,
                    key,
                });
            }
            Ev::FundingUpdated {
                market,
                intervals,
                rate,
                new_index,
            } => {
                {
                    let mk = self.ensure_market(*market);
                    mk.funding_rate = *rate;
                    mk.funding_index = *new_index;
                    mk.last_funding_ts = Some(ts);
                }
                self.funding_updates.push(FundingUpdateRow {
                    market: *market,
                    intervals: *intervals,
                    rate: *rate,
                    new_index: *new_index,
                    block,
                    log_index,
                    ts,
                    key,
                });
            }
            Ev::FundingSettled { acct, market, owed } => {
                self.ensure_market(*market);
                if let Some(p) = self.positions.get_mut(&(*acct, *market)) {
                    p.funding_paid = p.funding_paid.saturating_add(*owed);
                    p.updated_block = block;
                }
                let idx = self.funding_settles.len() as u32;
                self.funding_settles.push(FundingSettleRow {
                    acct: *acct,
                    market: *market,
                    owed: *owed,
                    block,
                    log_index,
                    ts,
                    key,
                });
                self.funding_settles_by_acct.entry(*acct).or_default().push(idx);
            }
            Ev::MarketState { market, state } => {
                self.ensure_market(*market).state = *state;
            }
            Ev::CondPlaced {
                id,
                acct,
                market,
                is_buy,
                above,
                trigger,
                limit,
                size,
                reduce_only,
                sibling,
            } => {
                self.ensure_market(*market);
                self.conds.insert(
                    *id,
                    CondRow {
                        id: *id,
                        acct: *acct,
                        market: *market,
                        side: side(*is_buy),
                        above: *above,
                        trigger: *trigger,
                        limit: *limit,
                        size: *size,
                        reduce_only: *reduce_only,
                        sibling: *sibling,
                        status: "active",
                        trigger_mark_price: None,
                        created_block: block,
                        created_ts: ts,
                        updated_block: block,
                    },
                );
            }
            Ev::CondCanceled { id } => {
                // NB: the contract emits CondCanceled for a triggered order too (then CondTriggered); the latter wins.
                if let Some(c) = self.conds.get_mut(id) {
                    if c.status == "active" {
                        c.status = "canceled";
                    }
                    c.updated_block = block;
                } else {
                    self.counters.unknown_refs += 1;
                }
            }
            Ev::CondTriggered { id, mark_price } => {
                if let Some(c) = self.conds.get_mut(id) {
                    c.status = "triggered";
                    c.trigger_mark_price = Some(*mark_price);
                    c.updated_block = block;
                    self.pending_parent = Some((c.acct, ParentRef { kind: "conditional", id: *id }));
                } else {
                    self.counters.unknown_refs += 1;
                }
            }
            Ev::TwapPlaced {
                id,
                acct,
                market,
                is_buy,
                total,
                slices,
                interval,
                slippage_bps,
                reduce_only,
            } => {
                self.ensure_market(*market);
                self.twaps.insert(
                    *id,
                    TwapRow {
                        id: *id,
                        acct: *acct,
                        market: *market,
                        side: side(*is_buy),
                        total: *total,
                        filled: 0,
                        slices: *slices,
                        slices_done: 0,
                        slices_failed: 0,
                        interval_secs: *interval,
                        slippage_bps: *slippage_bps,
                        reduce_only: *reduce_only,
                        status: "active",
                        slice_log: vec![],
                        created_block: block,
                        created_ts: ts,
                        updated_block: block,
                    },
                );
            }
            Ev::TwapSlice { id, slice_index, filled, ok } => {
                let acct = self.twaps.get(id).map(|t| t.acct);
                if let Some(t) = self.twaps.get_mut(id) {
                    t.slices_done = t.slices_done.max(slice_index + 1);
                    if *ok {
                        t.filled = t.filled.saturating_add(*filled);
                    } else {
                        t.slices_failed += 1;
                    }
                    t.slice_log.push(SliceRow {
                        index: *slice_index,
                        filled: *filled,
                        ok: *ok,
                        block,
                        ts,
                    });
                    t.updated_block = block;
                } else {
                    self.counters.unknown_refs += 1;
                }
                // the child IOC order was accepted earlier in this very tx
                if let (Some(oid), Some(a)) = (self.last_accepted, acct) {
                    if let Some(o) = self.orders.get_mut(&oid) {
                        if o.acct == a && o.parent.is_none() {
                            o.parent = Some(ParentRef { kind: "twap", id: *id });
                            self.touch_order(oid, block, ts, &mut out);
                        }
                    }
                }
            }
            Ev::TwapDone { id, filled, failed } => {
                if let Some(t) = self.twaps.get_mut(id) {
                    t.status = "done";
                    t.filled = *filled;
                    t.slices_failed = *failed;
                    t.updated_block = block;
                } else {
                    self.counters.unknown_refs += 1;
                }
            }
            Ev::TwapCanceled { id, filled } => {
                if let Some(t) = self.twaps.get_mut(id) {
                    t.status = "canceled";
                    t.filled = *filled;
                    t.updated_block = block;
                } else {
                    self.counters.unknown_refs += 1;
                }
            }
            // stored in the event log, no dedicated read model
            Ev::Other { name } => {
                if name.starts_with(crate::events::UNKNOWN_PREFIX) || name.starts_with(crate::events::UNDECODABLE_PREFIX) {
                    self.counters.undecoded += 1;
                }
            }
            Ev::BackstopSynced { equity_before, from_insurance, to_debt, market, refunded_insurance, repaid_debt } => {
                let deficit = *from_insurance > 0 || *to_debt > 0;
                let mut r = self.backstop_row("backstop_synced", block, log_index, ts, tx_hash, key);
                r.market = deficit.then_some(*market);
                r.equity_before = Some(equity_before.to_string());
                r.from_insurance = Some(from_insurance.to_string());
                r.to_debt = Some(to_debt.to_string());
                r.refunded_insurance = Some(refunded_insurance.to_string());
                r.repaid_debt = Some(repaid_debt.to_string());
                self.backstop.push(r);
            }
            Ev::AdlSkipped { target, market, slack } => {
                let mut r = self.backstop_row("adl_skipped", block, log_index, ts, tx_hash, key);
                r.market = Some(*market);
                r.target = Some(*target);
                r.slack = Some(slack.to_string());
                self.backstop.push(r);
            }
            Ev::AdlHardPremSet { bps } => {
                let mut r = self.backstop_row("adl_hard_prem_set", block, log_index, ts, tx_hash, key);
                r.bps = Some(*bps);
                self.backstop.push(r);
            }
            Ev::WithdrawGateSet { threshold } => {
                let mut r = self.backstop_row("withdraw_gate_set", block, log_index, ts, tx_hash, key);
                r.threshold = Some(threshold.to_string());
                self.backstop.push(r);
            }
            Ev::AgentApproved { .. } | Ev::IsolatedMode { .. } => {}
        }
        out
    }

    fn backstop_row(&self, kind: Lbl, block: u64, log_index: u32, ts: u64, tx_hash: B256, key: u128) -> BackstopRow {
        BackstopRow {
            kind,
            market: None,
            target: None,
            equity_before: None,
            from_insurance: None,
            to_debt: None,
            refunded_insurance: None,
            repaid_debt: None,
            slack: None,
            bps: None,
            threshold: None,
            block,
            log_index,
            ts,
            tx_hash,
            key,
        }
    }

    fn push_transfer(&mut self, t: TransferRow) {
        let idx = self.transfers.len() as u32;
        self.transfers_by_acct.entry(t.acct).or_default().push(idx);
        if let Some(c) = t.counterparty {
            self.transfers_by_acct.entry(c).or_default().push(idx);
        }
        self.transfers.push(t);
    }

    // ------------------------------------------------------------------------------------------ queries

    pub fn book_snapshot(&self, market: u8, depth: usize) -> (u64, Levels, Levels) {
        match self.books.get(&market) {
            None => (0, vec![], vec![]),
            Some(b) => (
                b.seq,
                b.bids.iter().rev().take(depth).map(|(p, s)| (*p, *s)).collect(),
                b.asks.iter().take(depth).map(|(p, s)| (*p, *s)).collect(),
            ),
        }
    }

    /// 24h rolling stats from 1h candles, anchored on the latest indexed block timestamp.
    pub fn stats_24h(&self, market: u8) -> (u128, u128, Option<u64>, Option<u64>, Option<u64>) {
        let Some(map) = self.candles.get(&(market, Interval::H1)) else {
            return (0, 0, None, None, None);
        };
        let from = self.last_ts.saturating_sub(86_400);
        let (mut v, mut qv) = (0u128, 0u128);
        let (mut hi, mut lo, mut open): (Option<u64>, Option<u64>, Option<u64>) = (None, None, None);
        for (t, c) in map.range((from - from % 3600)..) {
            let _ = t;
            v += c.v;
            qv += c.qv;
            hi = Some(hi.map_or(c.h, |x| x.max(c.h)));
            lo = Some(lo.map_or(c.l, |x| x.min(c.l)));
            if open.is_none() {
                open = Some(c.o);
            }
        }
        (v, qv, hi, lo, open)
    }

    /// Canonical dump of every event-derived read model. Two states built from the same log must have equal digests.
    pub fn digest(&self) -> String {
        #[derive(Serialize)]
        struct D<'a> {
            last_key: Option<u128>,
            markets: &'a BTreeMap<u8, MarketRow>,
            orders: Vec<&'a OrderRow>,
            fills: &'a VecDeque<FillRow>,
            fills_evicted_key: Option<u128>,
            books: Vec<(u8, u64, Levels, Levels)>,
            candles: Vec<(u8, &'static str, Vec<&'a Candle>)>,
            positions: Vec<&'a PositionRow>,
            funding_updates: &'a Vec<FundingUpdateRow>,
            funding_settles: &'a Vec<FundingSettleRow>,
            liquidations: &'a Vec<LiquidationRow>,
            bad_debt: &'a Vec<BadDebtRow>,
            backstop: &'a Vec<BackstopRow>,
            transfers: &'a Vec<TransferRow>,
            twaps: Vec<&'a TwapRow>,
            conds: Vec<&'a CondRow>,
        }
        let d = D {
            last_key: self.last_key,
            markets: &self.markets,
            orders: self.orders.values().collect(),
            fills: &self.fills,
            fills_evicted_key: self.fills_evicted_key,
            books: self
                .books
                .iter()
                .map(|(m, b)| {
                    (
                        *m,
                        b.seq,
                        b.bids.iter().map(|(p, s)| (*p, *s)).collect(),
                        b.asks.iter().map(|(p, s)| (*p, *s)).collect(),
                    )
                })
                .collect(),
            candles: self.candles.iter().map(|((m, i), v)| (*m, i.name(), v.values().collect())).collect(),
            positions: self.positions.values().collect(),
            funding_updates: &self.funding_updates,
            funding_settles: &self.funding_settles,
            liquidations: &self.liquidations,
            bad_debt: &self.bad_debt,
            backstop: &self.backstop,
            transfers: &self.transfers,
            twaps: self.twaps.values().collect(),
            conds: self.conds.values().collect(),
        };
        serde_json::to_string(&d).expect("digest serialises")
    }
}

// ------------------------------------------------------------------------------------------------ snapshots

/// Bump when the snapshot layout changes: an unreadable / mismatching snapshot is ignored (full replay instead).
pub const SNAPSHOT_VERSION: u32 = 1;

struct SeqOf<F>(F);
impl<F, I> Serialize for SeqOf<F>
where
    F: Fn() -> I,
    I: IntoIterator,
    I::Item: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq((self.0)())
    }
}

type SnapLevels = Vec<(u64, String)>;
type SnapBook = (u8, u64, SnapLevels, SnapLevels);

#[derive(Deserialize)]
struct SnapIn {
    version: u32,
    last_key: Option<String>,
    last_ts: u64,
    markets: Vec<MarketRow>,
    orders: Vec<OrderRow>,
    fills: Vec<FillRow>,
    fills_evicted_key: Option<String>,
    books: Vec<SnapBook>,
    candles: Vec<(u8, Interval, Vec<Candle>)>,
    positions: Vec<PositionRow>,
    funding_updates: Vec<FundingUpdateRow>,
    funding_settles: Vec<FundingSettleRow>,
    liquidations: Vec<LiquidationRow>,
    bad_debt: Vec<BadDebtRow>,
    #[serde(default)]
    backstop: Vec<BackstopRow>,
    transfers: Vec<TransferRow>,
    twaps: Vec<TwapRow>,
    conds: Vec<CondRow>,
    counters: Counters,
}

impl State {
    /// Serialise the complete reducer state (everything except static market metadata and per-tx scratch, which is
    /// reset at every transaction boundary and snapshots are only taken at block boundaries).
    pub fn to_snapshot(&self) -> String {
        in_snapshot_mode(|| {
            struct V<'a>(&'a State);
            impl Serialize for V<'_> {
                fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
                    use serde::ser::SerializeStruct;
                    let st = self.0;
                    let mut o = ser.serialize_struct("Snapshot", 19)?;
                    o.serialize_field("version", &SNAPSHOT_VERSION)?;
                    o.serialize_field("last_key", &st.last_key.map(|k| k.to_string()))?;
                    o.serialize_field("last_ts", &st.last_ts)?;
                    o.serialize_field("markets", &SeqOf(|| st.markets.values()))?;
                    o.serialize_field("orders", &SeqOf(|| st.orders.values()))?;
                    o.serialize_field("fills", &SeqOf(|| st.fills.iter()))?;
                    o.serialize_field("fills_evicted_key", &st.fills_evicted_key.map(|k| k.to_string()))?;
                    let books: Vec<SnapBook> = st
                        .books
                        .iter()
                        .map(|(m, b)| {
                            let lv = |x: &BTreeMap<u64, u128>| x.iter().map(|(p, s)| (*p, s.to_string())).collect::<SnapLevels>();
                            (*m, b.seq, lv(&b.bids), lv(&b.asks))
                        })
                        .collect();
                    o.serialize_field("books", &books)?;
                    let candles: Vec<(u8, Interval, Vec<&Candle>)> = st.candles.iter().map(|((m, i), v)| (*m, *i, v.values().collect())).collect();
                    o.serialize_field("candles", &candles)?;
                    o.serialize_field("positions", &SeqOf(|| st.positions.values()))?;
                    o.serialize_field("funding_updates", &st.funding_updates)?;
                    o.serialize_field("funding_settles", &st.funding_settles)?;
                    o.serialize_field("liquidations", &st.liquidations)?;
                    o.serialize_field("bad_debt", &st.bad_debt)?;
                    o.serialize_field("backstop", &st.backstop)?;
                    o.serialize_field("transfers", &st.transfers)?;
                    o.serialize_field("twaps", &SeqOf(|| st.twaps.values()))?;
                    o.serialize_field("conds", &SeqOf(|| st.conds.values()))?;
                    o.serialize_field("counters", &st.counters)?;
                    o.end()
                }
            }
            serde_json::to_string(&V(self)).expect("snapshot serialises")
        })
    }

    /// Rebuild a state from `to_snapshot` output. Static metadata and limits come from `like`.
    pub fn from_snapshot(json: &str, like: &State) -> anyhow::Result<State> {
        let s: SnapIn = serde_json::from_str(json)?;
        if s.version != SNAPSHOT_VERSION {
            anyhow::bail!("snapshot version {} != {}", s.version, SNAPSHOT_VERSION);
        }
        let mut st = like.fresh_like();
        st.last_key = s.last_key.map(|k| k.parse()).transpose()?;
        st.last_ts = s.last_ts;
        st.markets = s.markets.into_iter().map(|m| (m.id, m)).collect();
        for o in s.orders {
            st.orders_by_acct.entry(o.acct).or_default().push(o.id);
            st.orders.insert(o.id, o);
        }
        st.fills_evicted_key = s.fills_evicted_key.map(|k| k.parse()).transpose()?;
        for f in s.fills {
            st.push_fill(f);
        }
        for (m, seq, bids, asks) in s.books {
            let parse = |v: SnapLevels| -> anyhow::Result<BTreeMap<u64, u128>> { v.into_iter().map(|(p, z)| Ok((p, z.parse()?))).collect() };
            st.books.insert(
                m,
                Book {
                    seq,
                    bids: parse(bids)?,
                    asks: parse(asks)?,
                },
            );
        }
        for (m, i, cs) in s.candles {
            st.candles.insert((m, i), cs.into_iter().map(|c| (c.t, c)).collect());
        }
        st.positions = s.positions.into_iter().map(|p| ((p.acct, p.market), p)).collect();
        st.funding_updates = s.funding_updates;
        for (i, f) in s.funding_settles.iter().enumerate() {
            st.funding_settles_by_acct.entry(f.acct).or_default().push(i as u32);
        }
        st.funding_settles = s.funding_settles;
        st.liquidations = s.liquidations;
        st.bad_debt = s.bad_debt;
        st.backstop = s.backstop;
        for (i, t) in s.transfers.iter().enumerate() {
            st.transfers_by_acct.entry(t.acct).or_default().push(i as u32);
            if let Some(c) = t.counterparty {
                st.transfers_by_acct.entry(c).or_default().push(i as u32);
            }
        }
        st.transfers = s.transfers;
        st.twaps = s.twaps.into_iter().map(|t| (t.id, t)).collect();
        st.conds = s.conds.into_iter().map(|c| (c.id, c)).collect();
        st.counters = s.counters;
        Ok(st)
    }
}

// ------------------------------------------------------------------------------------------------ paging

pub struct Page {
    pub idx: Vec<usize>,
    pub next: Option<u128>,
}

/// Cursor pagination over a sequence sorted ascending by `key_at`. `cursor` is the key of the last item the client saw.
pub fn page_idx(len: usize, key_at: impl Fn(usize) -> u128, cursor: Option<u128>, limit: usize, desc: bool, pred: impl Fn(usize) -> bool) -> Page {
    let mut idx = Vec::new();
    let mut more = false;
    if !desc {
        let mut i = match cursor {
            None => 0,
            Some(c) => partition(len, |i| key_at(i) <= c),
        };
        while i < len {
            if pred(i) {
                if idx.len() == limit {
                    more = true;
                    break;
                }
                idx.push(i);
            }
            i += 1;
        }
    } else {
        let mut i = match cursor {
            None => len,
            Some(c) => partition(len, |i| key_at(i) < c),
        };
        while i > 0 {
            i -= 1;
            if pred(i) {
                if idx.len() == limit {
                    more = true;
                    break;
                }
                idx.push(i);
            }
        }
    }
    let next = if more { idx.last().map(|i| key_at(*i)) } else { None };
    Page { idx, next }
}

/// First index where `f` is false, assuming `f` is true for a prefix.
fn partition(len: usize, f: impl Fn(usize) -> bool) -> usize {
    let (mut lo, mut hi) = (0usize, len);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if f(mid) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}
