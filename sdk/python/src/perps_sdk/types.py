from __future__ import annotations

import enum
import secrets
from dataclasses import dataclass, field
from typing import List


class Tif(enum.IntEnum):
    GTC = 0
    IOC = 1
    FOK = 2
    POST_ONLY = 3


class MarketState(enum.IntEnum):
    NORMAL = 0
    REDUCE_ONLY = 1
    ORACLE_DEGRADED = 2
    PAUSED = 3
    RECOVERY = 4


class CancelReason(enum.IntEnum):
    """Matches PerpBase.CancelReason (OrderCanceled event)."""

    USER = 0
    EXPIRED = 1
    SELF_TRADE = 2
    INVALID_REDUCE_ONLY = 3
    MAKER_MARGIN = 4
    FILLED = 5
    LIQUIDATION = 6
    REPLACED = 7
    PRICE_BAND = 8  # resting order outside index +/- bandBps at match time (WASH-1)


_CANCEL_TEXT = {
    CancelReason.USER: "Order cancelled by you",
    CancelReason.EXPIRED: "Order cancelled: it expired",
    CancelReason.SELF_TRADE: "Order cancelled: it would have traded against your own order",
    CancelReason.INVALID_REDUCE_ONLY: "Order cancelled: it would have increased your position",
    CancelReason.MAKER_MARGIN: "Order cancelled: not enough margin to keep it open",
    CancelReason.FILLED: "Order filled",
    CancelReason.LIQUIDATION: "Order cancelled by a liquidation",
    CancelReason.REPLACED: "Order replaced",
    CancelReason.PRICE_BAND: "Order cancelled: its price was too far from the oracle price",
}


def cancel_reason_text(reason: int) -> str:
    try:
        return _CANCEL_TEXT[CancelReason(reason)]
    except (ValueError, KeyError):
        return f"Order cancelled (reason {reason})"


def new_cloid() -> int:
    """Random non-zero uint64 client order id (single-use per account, forever)."""
    return (secrets.randbits(63)) or 1


@dataclass
class OrderParams:
    """RAW units: price 1e6, size 1e8. price must be a multiple of tick, size of lot."""

    market: int
    is_buy: bool
    price: int
    size: int
    tif: Tif = Tif.GTC
    reduce_only: bool = False
    cloid: int = 0
    expiry: int = 0

    def as_tuple(self):
        return (self.market, self.is_buy, self.price, self.size, int(self.tif), self.reduce_only, self.cloid, self.expiry)


@dataclass
class MarketConfig:
    id: int
    state: MarketState
    feed: bytes
    tick: int
    lot: int
    min_notional: int
    max_order_size: int
    max_oi: int
    oi: int
    max_age: int
    band_bps: int
    max_spread_bps: int
    funding_interval: int


@dataclass
class AccountState:
    equity: int
    initial_margin: int
    maintenance_margin: int
    reserved_order_margin: int
    available: int


@dataclass
class Position:
    market: int
    size: int
    basis: int
    isolated: bool
    iso_margin: int
    iso_reserved: int


@dataclass
class BookLevel:
    price: int
    size: int


@dataclass
class BookSnapshot:
    market: int
    bids: List[BookLevel] = field(default_factory=list)
    asks: List[BookLevel] = field(default_factory=list)


@dataclass
class RestingOrder:
    id: int
    acct: bytes
    size: int
    price: int
    expiry: int
    cloid: int
    market: int
    is_buy: bool
    reduce_only: bool


@dataclass
class Fill:
    trade_id: int
    market: int
    maker_order_id: int
    maker: bytes
    taker: bytes
    taker_is_buy: bool
    price: int
    size: int
    taker_fee: int
    maker_fee: int


@dataclass
class PlaceResult:
    tx_hash: str
    order_id: int
    filled: int
    fills: List[Fill]
    gas_used: int


@dataclass
class OracleStatus:
    price: int
    updated_at: int
    age_sec: int
    max_age: int
    fresh: bool
