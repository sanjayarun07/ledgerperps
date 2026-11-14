"""Integration tests against a local hardhat node (fresh deployment per session)."""
import pytest
from eth_account import Account

from perps_sdk import (MarketState, OrderParams, OrderValidationError, PerpError, Tif, acct_key, new_cloid, sign_order, to_price, to_size, to_usdc)

P, S, U = to_price, to_size, to_usdc


def test_reads(env):
    c = env.client(1)
    ms = c.markets()
    assert len(ms) == 1 and ms[0].tick == 100_000 and ms[0].state == MarketState.NORMAL
    assert c.mark_price(0) == P(50000)
    st = c.oracle_status(0)
    assert st.fresh and st.price == P(50000)
    assert acct_key(c.owner, 3) == bytes(c.ex.functions.acctKey(c.owner, 3).call())


def test_deposit_transfer_withdraw(env, fund):
    c = fund(1, 10_000)
    assert c.collateral() == U(10_000)
    c.transfer_internal(0, 1, U(1000))
    assert c.collateral(1) == U(1000) and c.collateral(0) == U(9000)
    before = c.usdc_balance()
    c.withdraw(U(500))
    assert c.usdc_balance() - before == U(500)
    with pytest.raises(PerpError) as ei:
        c.withdraw(U(1_000_000))
    assert ei.value.error_name == "Unhealthy"


def test_limit_orders_book_cancel_replace_errors(env, fund):
    m = fund(2, 100_000)
    bid = m.place_order(OrderParams(0, True, P(49900), S("0.5"), cloid=new_cloid()))
    assert bid.order_id > 0 and bid.filled == 0
    ask = m.place_order(OrderParams(0, False, P(50100), S("0.5")))
    snap = m.book_snapshot(0, 5)
    assert (snap.bids[0].price, snap.bids[0].size) == (P(49900), S("0.5"))
    assert (snap.asks[0].price, snap.asks[0].size) == (P(50100), S("0.5"))
    assert [o.id for o in m.open_orders()] == [bid.order_id, ask.order_id]
    assert m.account_state().reserved_order_margin > 0
    rep = m.replace_order(bid.order_id, OrderParams(0, True, P(49950), S("0.5")))
    assert m.get_order(bid.order_id) is None and m.get_order(rep.order_id).price == P(49950)
    m.cancel_order(ask.order_id)
    assert [o.id for o in m.open_orders()] == [rep.order_id]
    m.cancel_all()
    assert m.open_orders() == []

    cl = new_cloid()
    m.place_order(OrderParams(0, True, P(49000), S("0.1"), cloid=cl))
    with pytest.raises(PerpError) as ei:
        m.place_order(OrderParams(0, True, P(49000), S("0.1"), cloid=cl))
    assert ei.value.error_name == "DuplicateClientId"
    m.place_order(OrderParams(0, False, P(50500), S("0.1")))
    with pytest.raises(PerpError) as ei:
        m.place_order(OrderParams(0, True, P(50500), S("0.1"), Tif.POST_ONLY))
    assert ei.value.error_name == "PostOnlyCross"
    with pytest.raises(PerpError) as ei:
        m.place_order(OrderParams(0, True, P(50500), S("5"), Tif.FOK))
    assert ei.value.error_name == "FokUnfilled"
    with pytest.raises(OrderValidationError):
        m.place_order(OrderParams(0, True, 50_000_050_000, S("0.1")))
    with pytest.raises(PerpError) as ei:
        m.place_order(OrderParams(0, True, 50_000_050_000, S("0.1")), validate=False)
    assert ei.value.is_("BadParam", "tick")
    m.cancel_all()


def test_market_order_fills(env, fund):
    maker = fund(3, 100_000)
    taker = fund(4, 20_000)
    maker.place_order(OrderParams(0, False, P(50050), S("1")))
    r = taker.market_order(0, True, S("0.2"), slippage_bps=20)
    assert r.filled == S("0.2") and len(r.fills) == 1 and r.fills[0].price == P(50050)
    assert taker.positions()[0].size == S("0.2")
    assert maker.positions()[0].size == -S("0.2")
    assert taker.account_state().equity < U(20_000)
    assert taker.get_fills(acct=taker.acct())
    maker.cancel_all()


def test_signed_orders_and_agents(env, fund):
    owner = fund(5, 50_000)
    relayer = env.client(6)
    chain_id, ex = owner.chain_id(), owner.exchange_address
    dl = owner.chain_time() + 600  # dev chains drift ahead of wall-clock; use chain time for deadlines
    signed = owner.sign_order(OrderParams(0, True, P(49000), S("0.1"), cloid=new_cloid()))
    res = relayer.place_signed(signed)
    assert res.order_id > 0 and owner.open_orders()[0].id == res.order_id
    assert owner.is_nonce_used(owner.owner, signed.nonce)
    with pytest.raises(PerpError) as ei:
        relayer.place_signed(signed)
    assert ei.value.is_("BadParam", "nonce used")

    stranger = Account.create()
    bad = sign_order(stranger, owner.owner, OrderParams(0, True, P(49000), S("0.1")), chain_id, ex, deadline=dl)
    with pytest.raises(PerpError) as ei:
        relayer.place_signed(bad)
    assert ei.value.error_name == "NotAuthorized"
    old = owner.sign_order(OrderParams(0, True, P(49000), S("0.1")), deadline=1)
    with pytest.raises(PerpError) as ei:
        relayer.place_signed(old)
    assert ei.value.error_name == "Expired"

    agent = Account.create()
    exp = owner.chain_time() + 3600
    owner.approve_agent(agent.address, exp)
    assert owner.agent_expiry(agent.address) == exp
    ok = relayer.place_signed(sign_order(agent, owner.owner, OrderParams(0, True, P(48000), S("0.1")), chain_id, ex, deadline=dl))
    assert ok.order_id > 0
    owner.revoke_agent(agent.address)
    with pytest.raises(PerpError) as ei:
        relayer.place_signed(sign_order(agent, owner.owner, OrderParams(0, True, P(48000), S("0.1")), chain_id, ex, deadline=dl))
    assert ei.value.error_name == "NotAuthorized"
    owner.cancel_all()


def test_keepers_and_degraded_oracle(env, fund):
    from perps_sdk import PerpClient

    env.set_oracle(P(50000))
    maker = fund(14, 2_000_000)
    weak = fund(15, 6_000)
    keeper = env.client(16)
    maker.place_order(OrderParams(0, False, P(50100), S("1")))
    weak.market_order(0, True, S("1"), slippage_bps=50)
    maker.cancel_all()
    with pytest.raises(PerpError) as ei:
        keeper.liquidate(weak.acct(), 0)
    assert ei.value.error_name == "NotLiquidatable"
    env.set_oracle(P(45500))
    assert keeper.is_liquidatable(weak.acct(), 0)
    keeper.liquidate(weak.acct(), 0)
    assert weak.positions()[0].size < S("1")
    keeper.poke_funding(0)

    env.set_oracle_at(P(45500), 1)
    with pytest.raises(PerpError) as ei:
        keeper.mark_price(0)
    assert ei.value.error_name == "OracleDegraded"
    assert not keeper.oracle_status(0).fresh
    env.set_oracle(P(50000))
