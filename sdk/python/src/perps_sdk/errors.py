"""Decoding of the exchange's custom errors from web3 exceptions."""
from __future__ import annotations

import json
import re
from importlib import resources
from typing import Any, Dict, List, Optional, Tuple

from eth_abi import decode as abi_decode
from eth_utils import function_signature_to_4byte_selector

_HUMAN = {
    "NotAuthorized": "caller is not the account owner or an unexpired agent (or the signature is invalid)",
    "BadParam": "invalid parameter",
    "MarketRestricted": "market is paused/degraded or the exchange is globally paused",
    "OracleDegraded": "oracle price is missing or stale",
    "Unhealthy": "insufficient margin / withdrawable collateral",
    "ReduceOnlyViolation": "order would not reduce the position",
    "PostOnlyCross": "post-only order would cross the book",
    "FokUnfilled": "fill-or-kill order could not be completely filled",
    "DuplicateClientId": "client order id (cloid) already used on this account",
    "TooManyOrders": "too many open orders / conditionals / TWAPs",
    "PriceTooFarFromTop": "price too far from top of book",
    "OICap": "open-interest cap reached",
    "NotLiquidatable": "account is above maintenance margin",
    "Expired": "order or signature has expired",
    "WithdrawGated": "Withdrawals above your deposited amount are temporarily limited while the exchange has unresolved bad debt (you can still withdraw up to your principal(acct))",
}


class PerpError(Exception):
    def __init__(self, name: str, args: Tuple[Any, ...] = (), raw: Optional[str] = None):
        self.error_name = name
        self.error_args = args
        self.raw = raw
        detail = f"({', '.join(str(a) for a in args)})" if args else ""
        hint = f": {_HUMAN[name]}" if name in _HUMAN else ""
        super().__init__(f"{name}{detail}{hint}")

    def is_(self, name: str, first_arg: Any = None) -> bool:
        return self.error_name == name and (first_arg is None or (self.error_args and self.error_args[0] == first_arg))


def _load_error_table() -> Dict[bytes, Tuple[str, List[str]]]:
    table: Dict[bytes, Tuple[str, List[str]]] = {}
    base = resources.files("perps_sdk").joinpath("abi")
    for fn in ("exchange.json", "erc20.json"):
        for f in json.loads(base.joinpath(fn).read_text()):
            if f["type"] != "error":
                continue
            types = [i["type"] for i in f["inputs"]]
            sig = f"{f['name']}({','.join(types)})"
            table[function_signature_to_4byte_selector(sig)] = (f["name"], types)
    table[bytes.fromhex("08c379a0")] = ("Error", ["string"])
    table[bytes.fromhex("4e487b71")] = ("Panic", ["uint256"])
    return table


_TABLE: Optional[Dict[bytes, Tuple[str, List[str]]]] = None
_HEX = re.compile(r"0x[0-9a-fA-F]{8,}")


def _hex_candidates(e: BaseException, depth: int = 0) -> List[str]:
    out: List[str] = []
    if depth > 6:
        return out
    for a in getattr(e, "args", ()):
        if isinstance(a, str):
            out += _HEX.findall(a)
        elif isinstance(a, dict):
            out += _HEX.findall(json.dumps(a, default=str))
    d = getattr(e, "data", None)
    if isinstance(d, str):
        out += _HEX.findall(d)
    elif isinstance(d, dict):
        out += _HEX.findall(json.dumps(d, default=str))
    for nxt in (e.__cause__, e.__context__):
        if nxt is not None:
            out += _hex_candidates(nxt, depth + 1)
    return out


def decode_error(exc: BaseException) -> Optional[PerpError]:
    """Returns a PerpError if the exception carries decodable revert data for a known custom error, else None."""
    global _TABLE
    if isinstance(exc, PerpError):
        return exc
    if _TABLE is None:
        _TABLE = _load_error_table()
    for h in _hex_candidates(exc):
        raw = bytes.fromhex(h[2:])
        ent = _TABLE.get(raw[:4])
        if ent is None:
            continue
        name, types = ent
        try:
            args = abi_decode(types, raw[4:]) if types else ()
        except Exception:
            continue
        return PerpError(name, tuple(args), h)
    return None
