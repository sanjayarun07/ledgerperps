"""EIP-712 OrderAction signing (domain 'PerpExchange' v1). Must match PerpBase.ORDER_TYPEHASH."""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Optional

from eth_account import Account
from eth_account.messages import encode_typed_data

from .types import OrderParams

EIP712_NAME = "PerpExchange"
EIP712_VERSION = "1"

ORDER_ACTION_FIELDS = [
    {"name": "owner", "type": "address"},
    {"name": "sub", "type": "uint8"},
    {"name": "market", "type": "uint8"},
    {"name": "isBuy", "type": "bool"},
    {"name": "price", "type": "uint64"},
    {"name": "size", "type": "uint128"},
    {"name": "tif", "type": "uint8"},
    {"name": "reduceOnly", "type": "bool"},
    {"name": "cloid", "type": "uint64"},
    {"name": "expiry", "type": "uint64"},
    {"name": "nonce", "type": "uint256"},
    {"name": "deadline", "type": "uint256"},
]


@dataclass
class SignedOrder:
    owner: str
    sub: int
    params: OrderParams
    nonce: int
    deadline: int
    signature: bytes
    signer: str


def random_nonce() -> int:
    return secrets.randbits(192)


def typed_data(owner: str, sub: int, p: OrderParams, nonce: int, deadline: int, chain_id: int, exchange: str) -> dict:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "OrderAction": ORDER_ACTION_FIELDS,
        },
        "primaryType": "OrderAction",
        "domain": {"name": EIP712_NAME, "version": EIP712_VERSION, "chainId": chain_id, "verifyingContract": exchange},
        "message": {
            "owner": owner,
            "sub": sub,
            "market": p.market,
            "isBuy": p.is_buy,
            "price": p.price,
            "size": p.size,
            "tif": int(p.tif),
            "reduceOnly": p.reduce_only,
            "cloid": p.cloid,
            "expiry": p.expiry,
            "nonce": nonce,
            "deadline": deadline,
        },
    }


def sign_order(
    signer: "Account",
    owner: str,
    params: OrderParams,
    chain_id: int,
    exchange: str,
    sub: int = 0,
    nonce: Optional[int] = None,
    deadline: Optional[int] = None,
) -> SignedOrder:
    """`signer` is the owner's account or an agent approved with approve_agent. Default deadline = wall-clock + 300s
    (dev chains can drift ahead of wall-clock; PerpClient.sign_order uses chain time instead)."""
    nonce = random_nonce() if nonce is None else nonce
    deadline = int(time.time()) + 300 if deadline is None else deadline
    msg = encode_typed_data(full_message=typed_data(owner, sub, params, nonce, deadline, chain_id, exchange))
    sig = Account.sign_message(msg, private_key=signer.key).signature
    return SignedOrder(owner, sub, params, nonce, deadline, bytes(sig), signer.address)
