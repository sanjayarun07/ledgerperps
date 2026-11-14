from __future__ import annotations

import json
from importlib import resources
from typing import Any, List, Optional

from eth_abi import encode as abi_encode
from eth_account.signers.local import LocalAccount
from eth_utils import keccak, to_checksum_address
from web3 import Web3
from web3.logs import DISCARD

from .errors import PerpError, decode_error
from .signing import SignedOrder, sign_order
from .types import (
    AccountState,
    BookLevel,
    BookSnapshot,
    Fill,
    MarketConfig,
    MarketState,
    OracleStatus,
    OrderParams,
    PlaceResult,
    Position,
    RestingOrder,
    Tif,
)
from .units import MarketLimits, OrderValidationError, slippage_price, validate_order

MAX_UINT256 = 2**256 - 1


def _abi(name: str) -> list:
    return json.loads(resources.files("perps_sdk").joinpath("abi").joinpath(name).read_text())


def acct_key(owner: str, sub: int) -> bytes:
    """keccak256(abi.encode(owner, sub)) - identical to PerpBase.acctKey."""
    return keccak(abi_encode(["address", "uint8"], [to_checksum_address(owner), sub]))


class PerpClient:
    """Synchronous web3.py client. All numeric args/returns are RAW ints (price 1e6, size 1e8, USDC 1e6)."""

    def __init__(
        self,
        w3: Web3,
        exchange: str,
        account: Optional[LocalAccount] = None,
        usdc: Optional[str] = None,
        oracle: Optional[str] = None,
        owner: Optional[str] = None,
        sub: int = 0,
    ):
        self.w3 = w3
        self.account = account
        self.exchange_address = to_checksum_address(exchange)
        self.ex = w3.eth.contract(address=self.exchange_address, abi=_abi("exchange.json"))
        self.usdc = w3.eth.contract(address=to_checksum_address(usdc), abi=_abi("erc20.json")) if usdc else None
        self.oracle = w3.eth.contract(address=to_checksum_address(oracle), abi=_abi("oracle.json")) if oracle else None
        o = owner or (account.address if account else None)
        if not o:
            raise ValueError("need an account or an explicit owner")
        self.owner = to_checksum_address(o)
        self.sub = sub
        self._cfg: dict[int, MarketConfig] = {}

    @classmethod
    def from_deployment(cls, rpc_url: str, deployment: dict, private_key: Optional[str] = None, **kw) -> "PerpClient":
        w3 = Web3(Web3.HTTPProvider(rpc_url))
        acct = w3.eth.account.from_key(private_key) if private_key else None
        return cls(w3, deployment["exchange"], acct, deployment.get("usdc"), deployment.get("oracle"), **kw)

    # ------------------------------------------------------------------ plumbing
    def acct(self, sub: Optional[int] = None, owner: Optional[str] = None) -> bytes:
        return acct_key(owner or self.owner, self.sub if sub is None else sub)

    def chain_id(self) -> int:
        return self.w3.eth.chain_id

    def chain_time(self) -> int:
        try:
            return int(self.w3.eth.get_block("pending")["timestamp"])
        except Exception:
            return int(self.w3.eth.get_block("latest")["timestamp"])

    def _call(self, fn):
        try:
            return fn.call()
        except Exception as e:  # noqa: BLE001
            d = decode_error(e)
            if d:
                raise d from e
            raise

    def _send(self, fn, gas: Optional[int] = None):
        if not self.account:
            raise RuntimeError("this client has no account; cannot send transactions")
        frm = self.account.address
        try:
            if gas is None:
                gas = int(fn.estimate_gas({"from": frm}) * 1.25)
            tx = fn.build_transaction(
                {"from": frm, "nonce": self.w3.eth.get_transaction_count(frm, "pending"), "gas": gas, "chainId": self.chain_id()}
            )
            signed = self.account.sign_transaction(tx)
            h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        except PerpError:
            raise
        except Exception as e:  # noqa: BLE001
            d = decode_error(e)
            if d:
                raise d from e
            raise
        if rcpt["status"] != 1:
            raise RuntimeError(f"transaction {h.hex()} reverted on-chain")
        return rcpt

    # ------------------------------------------------------------------ collateral
    def mint_mock_usdc(self, to: str, amount: int):
        """LOCAL DEMO ONLY (MockUSDC.mint is permissionless)."""
        return self._send(self.usdc.functions.mint(to_checksum_address(to), amount))

    def approve_usdc(self, amount: int = MAX_UINT256):
        return self._send(self.usdc.functions.approve(self.exchange_address, amount))

    def usdc_balance(self, who: Optional[str] = None) -> int:
        return self._call(self.usdc.functions.balanceOf(to_checksum_address(who or self.owner)))

    def deposit(self, amount: int, to: Optional[str] = None, sub: Optional[int] = None):
        return self._send(self.ex.functions.deposit(to_checksum_address(to or self.owner), self.sub if sub is None else sub, amount))

    def withdraw(self, amount: int, sub: Optional[int] = None):
        return self._send(self.ex.functions.withdraw(self.sub if sub is None else sub, amount))

    def transfer_internal(self, from_sub: int, to_sub: int, amount: int):
        return self._send(self.ex.functions.transferInternal(from_sub, to_sub, amount))

    # ------------------------------------------------------------------ orders
    def _validate(self, p: OrderParams) -> None:
        c = self.market_config(p.market)
        probs = validate_order(MarketLimits(c.tick, c.lot, c.min_notional, c.max_order_size), p.price, p.size, p.reduce_only)
        if probs:
            raise OrderValidationError(probs)

    def _summarize(self, rcpt, acct: bytes) -> PlaceResult:
        accepted = self.ex.events.OrderAccepted().process_receipt(rcpt, errors=DISCARD)
        oid = next((int(e["args"]["id"]) for e in accepted if bytes(e["args"]["acct"]) == acct), 0)
        fills = [
            self._fill(e["args"]) for e in self.ex.events.Fill().process_receipt(rcpt, errors=DISCARD) if bytes(e["args"]["taker"]) == acct
        ]
        return PlaceResult(rcpt["transactionHash"].hex(), oid, sum(f.size for f in fills), fills, int(rcpt["gasUsed"]))

    @staticmethod
    def _fill(a) -> Fill:
        return Fill(int(a["tradeId"]), int(a["market"]), int(a["makerOrderId"]), bytes(a["maker"]), bytes(a["taker"]), bool(a["takerIsBuy"]),
                    int(a["price"]), int(a["size"]), int(a["takerFee"]), int(a["makerFee"]))

    def place_order(self, p: OrderParams, sub: Optional[int] = None, validate: bool = True) -> PlaceResult:
        if validate:
            self._validate(p)
        s = self.sub if sub is None else sub
        rcpt = self._send(self.ex.functions.placeOrder(self.owner, s, p.as_tuple()))
        return self._summarize(rcpt, self.acct(s))

    def reference_price(self, market: int, is_buy: bool) -> int:
        top = self.best_price(market, not is_buy)
        return top if top > 0 else self.mark_price(market)

    def market_order(self, market: int, is_buy: bool, size: int, slippage_bps: int = 50, ref_price: Optional[int] = None,
                     reduce_only: bool = False, cloid: int = 0, sub: Optional[int] = None) -> PlaceResult:
        """Market-as-IOC at a slippage-bounded limit price."""
        c = self.market_config(market)
        ref = ref_price if ref_price is not None else self.reference_price(market, is_buy)
        px = slippage_price(is_buy, ref, slippage_bps, c.tick)
        return self.place_order(OrderParams(market, is_buy, px, size, Tif.IOC, reduce_only, cloid), sub=sub)

    def cancel_order(self, order_id: int):
        return self._send(self.ex.functions.cancelOrder(order_id))

    def cancel_all(self, sub: Optional[int] = None):
        return self._send(self.ex.functions.cancelAll(self.owner, self.sub if sub is None else sub))

    def replace_order(self, old_id: int, p: OrderParams, validate: bool = True) -> PlaceResult:
        if validate:
            self._validate(p)
        old = self.get_order(old_id)
        acct = old.acct if old else self.acct()
        rcpt = self._send(self.ex.functions.replaceOrder(old_id, p.as_tuple()))
        return self._summarize(rcpt, acct)

    # ------------------------------------------------------------------ signed orders / agents
    def sign_order(self, p: OrderParams, sub: Optional[int] = None, nonce: Optional[int] = None, deadline: Optional[int] = None) -> SignedOrder:
        if not self.account:
            raise RuntimeError("no account to sign with")
        return sign_order(self.account, self.owner, p, self.chain_id(), self.exchange_address,
                          self.sub if sub is None else sub, nonce, deadline if deadline is not None else self.chain_time() + 600)

    def place_signed(self, s: SignedOrder) -> PlaceResult:
        rcpt = self._send(self.ex.functions.placeSigned(to_checksum_address(s.owner), s.sub, s.params.as_tuple(), s.nonce, s.deadline, s.signature))
        return self._summarize(rcpt, self.acct(s.sub, s.owner))

    def is_nonce_used(self, owner: str, nonce: int) -> bool:
        return self._call(self.ex.functions.nonceUsed(to_checksum_address(owner), nonce))

    def approve_agent(self, agent: str, expiry: int, sub: Optional[int] = None):
        return self._send(self.ex.functions.approveAgent(self.sub if sub is None else sub, to_checksum_address(agent), expiry))

    def revoke_agent(self, agent: str, sub: Optional[int] = None):
        return self._send(self.ex.functions.revokeAgent(self.sub if sub is None else sub, to_checksum_address(agent)))

    def agent_expiry(self, agent: str, sub: Optional[int] = None) -> int:
        return self._call(self.ex.functions.agentExpiry(self.acct(sub), to_checksum_address(agent)))

    # ------------------------------------------------------------------ keeper calls
    def liquidate(self, acct: bytes, market: int):
        return self._send(self.ex.functions.liquidate(acct, market))

    def write_off(self, acct: bytes, market: int):
        """Permissionless. Records the loss of a FLAT, NEGATIVE bucket (isolated margin of `market`, or cross collateral when the
        account holds no cross position): insurance first, the rest becomes unresolved bad debt / adlDebt(market). Pays no reward.
        Reverts BadParam("nothing to write off") for healthy buckets. May emit BadDebtUnresolved."""
        return self._send(self.ex.functions.writeOff(acct, market))

    def sync_backstop(self):
        """Permissionless, idempotent. Records the backstop's mark-to-market deficit (insurance first, then unresolved bad debt / adlDebt / bsDebt)
        or repays earlier draws when its equity is positive. withdraw/liquidate/adl/settleDelisted also sync internally. Emits BackstopSynced."""
        return self._send(self.ex.functions.syncBackstop())

    def backstop_equity(self) -> int:
        """Signed micro-USDC; negative = an unrecorded backstop deficit."""
        return int(self._call(self.ex.functions.backstopEquity()))

    def adl_health(self, acct: bytes, market: int):
        """(equity, maintenance, slack). A target needs equity > maintenance or adl() skips it with AdlSkipped; adlScore is 0 when equity <= 0."""
        eq, mm = self._call(self.ex.functions.adlHealth(acct, market))
        return int(eq), int(mm), max(int(eq) - int(mm), 0)

    def bs_ins_drawn(self) -> int:
        return int(self._call(self.ex.functions.bsInsDrawn()))

    def bs_debt(self) -> int:
        return int(self._call(self.ex.functions.bsDebt()))

    def unresolved_bad_debt(self) -> int:
        return int(self._call(self.ex.functions.unresolvedBadDebt()))

    def adl_hard_prem_bps(self) -> int:
        return int(self._call(self.ex.functions.adlHardPremBps()))

    def wd_gate_threshold(self) -> int:
        """Withdrawal limiter threshold (micro-USDC); active while unresolvedBadDebt exceeds it."""
        return int(self._call(self.ex.functions.wdGateThreshold()))

    def principal(self, acct: bytes) -> int:
        """Deposited (not earned) collateral still withdrawable while the limiter is active."""
        return int(self._call(self.ex.functions.principal(acct)))

    def withdraw_gate_active(self) -> bool:
        return self.unresolved_bad_debt() > self.wd_gate_threshold()

    def set_adl_hard_prem_bps(self, bps: int):
        """Admin: any value <= 10000; GUARDIAN: may only lower it."""
        return self._send(self.ex.functions.setAdlHardPremBps(bps))

    def set_withdraw_gate(self, threshold: int):
        """Admin: any value (2**256-1 disables the limiter); GUARDIAN: may only lower it. Micro-USDC."""
        return self._send(self.ex.functions.setWithdrawGate(threshold))

    # ---- backstop phase 2 (inventory management)
    def backstop_cfg(self, market: int) -> dict:
        """Per-market inventory parameters; soft_notional == 0 means the feature is OFF for that market. elevated_since == 0 means not elevated."""
        r = self._call(self.ex.functions.backstopCfg(market))
        return {"soft_notional": int(r[0]), "max_disc_bps": int(r[1]), "dwell": int(r[2]), "ramp": int(r[3]), "max_age": int(r[4]), "elevated_since": int(r[5])}

    def backstop_auction(self, market: int) -> dict:
        """Current Dutch-auction quote: takerSells = the backstop is short and the taker sells to it. price 1e6 units, size 1e8 units. Inactive unless elevated."""
        r = self._call(self.ex.functions.backstopAuction(market))
        return {"active": bool(r[0]), "taker_sells": bool(r[1]), "price": int(r[2]), "disc_bps": int(r[3]), "size": int(r[4])}

    def backstop_place_open(self) -> bool:
        return bool(self._call(self.ex.functions.backstopPlaceOpen()))

    def backstop_take_fee_bps(self) -> int:
        return int(self._call(self.ex.functions.backstopTakeFeeBps()))

    def poke_backstop(self, market: int):
        """Permissionless: refresh the market's elevation clock with the current mark (starts/stops the auction). Emits BackstopElevated/BackstopRelaxed."""
        return self._send(self.ex.functions.pokeBackstop(market))

    def take_backstop(self, market: int, size: int, limit_px: int, sub: Optional[int] = None):
        """Take `size` (lot-aligned) of the backstop's inventory at the auction price (max price when buying, min when selling). Pays the take fee
        into insurance; needs initial margin if exposure grows. Emits BackstopTaken (no Fill event)."""
        return self._send(self.ex.functions.takeBackstop(self.owner, self.sub if sub is None else sub, market, size, limit_px))

    def unwind_backstop(self, targets: list, market: int):
        """Permissionless, after max_age of elevation: closes ranked (adlScore desc, key asc, max 8) profitable opposite-side accounts at mark."""
        return self._send(self.ex.functions.unwindBackstop(targets, market))

    def set_backstop_cfg(self, market: int, soft_notional: int, max_disc_bps: int, dwell: int, ramp: int, max_age: int):
        """Admin: any bounded value; GUARDIAN: may only tighten an enabled market. soft_notional=0 turns the market's phase 2 off."""
        return self._send(self.ex.functions.setBackstopCfg(market, soft_notional, max_disc_bps, dwell, ramp, max_age))

    def set_backstop_take_fee(self, bps: int):
        return self._send(self.ex.functions.setBackstopTakeFee(bps))

    def set_backstop_place_open(self, is_open: bool):
        return self._send(self.ex.functions.setBackstopPlaceOpen(is_open))

    def poke_funding(self, market: int):
        return self._send(self.ex.functions.pokeFunding(market))

    def execute_conditional(self, cond_id: int):
        return self._send(self.ex.functions.executeConditional(cond_id))

    def is_liquidatable(self, acct: bytes, market: int) -> bool:
        p = self.get_position(acct, market)
        if p.size == 0:
            return False
        if p.isolated:
            r = self._call(self.ex.functions.isoState(acct, market))
            return r[2] < r[4]
        s = self.account_state_by_key(acct)
        return s.equity < s.maintenance_margin

    # ------------------------------------------------------------------ reads
    def market_count(self) -> int:
        return int(self._call(self.ex.functions.marketCount()))

    def market_config(self, market: int, fresh: bool = False) -> MarketConfig:
        if not fresh and market in self._cfg:
            return self._cfg[market]
        m = self._call(self.ex.functions.getMarket(market))
        # struct comes back as a tuple in ABI order (see PerpBase.Market)
        cfg = MarketConfig(market, MarketState(int(m[1])), bytes(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6]), int(m[7]), int(m[8]),
                           int(m[9]), int(m[10]), int(m[11]), int(m[12]))
        self._cfg[market] = cfg
        return cfg

    def markets(self) -> List[MarketConfig]:
        return [self.market_config(i, fresh=True) for i in range(self.market_count())]

    def mark_price(self, market: int) -> int:
        return int(self._call(self.ex.functions.markPrice(market)))

    def best_price(self, market: int, is_buy: bool) -> int:
        return int(self._call(self.ex.functions.bestPrice(market, is_buy)))

    def book_snapshot(self, market: int, depth: int = 10) -> BookSnapshot:
        def side(is_buy: bool):
            px, sz = self._call(self.ex.functions.bookSnapshot(market, is_buy, depth))
            return [BookLevel(int(p), int(s)) for p, s in zip(px, sz) if p > 0]

        return BookSnapshot(market, side(True), side(False))

    def account_state(self, sub: Optional[int] = None, owner: Optional[str] = None) -> AccountState:
        return self.account_state_by_key(self.acct(sub, owner))

    def account_state_by_key(self, acct: bytes) -> AccountState:
        r = self._call(self.ex.functions.accountState(acct))
        return AccountState(int(r[0]), int(r[1]), int(r[2]), int(r[3]), int(r[4]))

    def collateral(self, sub: Optional[int] = None) -> int:
        return int(self._call(self.ex.functions.collateral(self.acct(sub))))

    def withdrawable(self, sub: Optional[int] = None) -> int:
        return int(self._call(self.ex.functions.withdrawable(self.acct(sub))))

    def get_position(self, acct: bytes, market: int) -> Position:
        r = self._call(self.ex.functions.positions(acct, market))
        return Position(market, int(r[0]), int(r[1]), bool(r[3]), int(r[4]), int(r[5]))

    def positions(self, sub: Optional[int] = None) -> List[Position]:
        a = self.acct(sub)
        ps = [self.get_position(a, m) for m in range(self.market_count())]
        return [p for p in ps if p.size != 0 or p.iso_margin != 0]

    def get_order(self, order_id: int) -> Optional[RestingOrder]:
        r = self._call(self.ex.functions.orders(order_id))
        if r[1] == 0:
            return None
        return RestingOrder(order_id, bytes(r[0]), int(r[1]), int(r[3]), int(r[4]), int(r[7]), int(r[8]), bool(r[9]), bool(r[10]))

    def open_orders(self, sub: Optional[int] = None) -> List[RestingOrder]:
        ids = self._call(self.ex.functions.openOrderIds(self.acct(sub)))
        os_ = [self.get_order(int(i)) for i in ids]
        return [o for o in os_ if o]

    def oracle_status(self, market: int) -> OracleStatus:
        if not self.oracle:
            raise RuntimeError("oracle not configured")
        c = self.market_config(market)
        price, t = self._call(self.oracle.functions.latest(c.feed))
        age = self.chain_time() - int(t)
        return OracleStatus(int(price), int(t), age, c.max_age, price > 0 and 0 <= age <= c.max_age)

    def get_fills(self, from_block: int = 0, to_block: Any = "latest", acct: Optional[bytes] = None) -> List[Fill]:
        logs = self.ex.events.Fill().get_logs(from_block=from_block, to_block=to_block)
        fills = [self._fill(e["args"]) for e in logs]
        return [f for f in fills if acct is None or f.maker == acct or f.taker == acct]
