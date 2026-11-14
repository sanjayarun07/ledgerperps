"""Unit helpers. price 1e6, size 1e8, USDC 1e6. All on-chain-facing values are plain ints (raw units)."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import List, Union

PRICE_DECIMALS = 6
SIZE_DECIMALS = 8
USDC_DECIMALS = 6
SIZE_SCALE = 10**8
BPS = 10_000

Dec = Union[str, int, float, Decimal]


def _to_raw(v: Dec, decimals: int) -> int:
    d = Decimal(str(v)) if not isinstance(v, Decimal) else v
    scaled = d * (10**decimals)
    if scaled != scaled.to_integral_value():
        raise ValueError(f"{v} has more than {decimals} decimals")
    return int(scaled)


def to_price(v: Dec) -> int:
    return _to_raw(v, PRICE_DECIMALS)


def to_size(v: Dec) -> int:
    return _to_raw(v, SIZE_DECIMALS)


def to_usdc(v: Dec) -> int:
    return _to_raw(v, USDC_DECIMALS)


def _fmt(v: int, decimals: int) -> str:
    neg = v < 0
    s = str(abs(v)).rjust(decimals + 1, "0")
    out = s[:-decimals] + "." + s[-decimals:]
    out = out.rstrip("0").rstrip(".")
    return ("-" if neg else "") + out


def from_price(v: int) -> str:
    return _fmt(v, PRICE_DECIMALS)


def from_size(v: int) -> str:
    return _fmt(v, SIZE_DECIMALS)


def from_usdc(v: int) -> str:
    return _fmt(v, USDC_DECIMALS)


def notional_floor(size: int, price: int) -> int:
    return size * price // SIZE_SCALE


def round_down(v: int, step: int) -> int:
    return v // step * step


def round_up(v: int, step: int) -> int:
    return (v + step - 1) // step * step


def round_price_to_tick(price: int, tick: int, mode: str = "nearest") -> int:
    if mode == "down":
        return round_down(price, tick)
    if mode == "up":
        return round_up(price, tick)
    return (price + tick // 2) // tick * tick


def slippage_price(is_buy: bool, ref_price: int, slippage_bps: int, tick: int) -> int:
    """Worst acceptable price for a market-as-IOC order (buy rounds up, sell rounds down, min one tick)."""
    if not 0 <= slippage_bps <= BPS:
        raise ValueError("slippage_bps out of range")
    if ref_price <= 0:
        raise ValueError("ref_price must be positive")
    if is_buy:
        return round_up((ref_price * (BPS + slippage_bps) + BPS - 1) // BPS, tick)
    return max(round_down(ref_price * (BPS - slippage_bps) // BPS, tick), tick)


@dataclass
class MarketLimits:
    tick: int
    lot: int
    min_notional: int
    max_order_size: int


class OrderValidationError(ValueError):
    def __init__(self, problems: List[str]):
        super().__init__("invalid order: " + "; ".join(problems))
        self.problems = problems


def validate_order(m: MarketLimits, price: int, size: int, reduce_only: bool = False) -> List[str]:
    errs: List[str] = []
    if price <= 0:
        errs.append("price must be > 0")
    elif price % m.tick:
        errs.append(f"price {price} is not a multiple of tick {m.tick}")
    if size <= 0:
        errs.append("size must be > 0")
    else:
        if size % m.lot:
            errs.append(f"size {size} is not a multiple of lot {m.lot}")
        if size > m.max_order_size:
            errs.append(f"size {size} exceeds max_order_size {m.max_order_size}")
    if not reduce_only and price > 0 and size > 0 and notional_floor(size, price) < m.min_notional:
        errs.append(f"notional {notional_floor(size, price)} below min_notional {m.min_notional}")
    return errs
