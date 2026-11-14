"""Python SDK for the Perps exchange (UNAUDITED local prototype). Raw units: price 1e6, size 1e8, USDC 1e6."""
from .client import PerpClient, acct_key
from .errors import PerpError, decode_error
from .signing import SignedOrder, sign_order, typed_data
from .types import (
    AccountState, BookLevel, CancelReason, cancel_reason_text, BookSnapshot, Fill, MarketConfig, MarketState, OracleStatus, OrderParams,
    PlaceResult, Position, RestingOrder, Tif, new_cloid,
)
from .units import (
    OrderValidationError, from_price, from_size, from_usdc, notional_floor, round_price_to_tick, slippage_price,
    to_price, to_size, to_usdc, validate_order, MarketLimits,
)

__all__ = [n for n in dir() if not n.startswith("_")]
