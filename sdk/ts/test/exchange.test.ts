// Integration tests against a LOCAL hardhat node (npx hardhat node). Each run deploys a fresh exchange.
import { beforeAll, describe, expect, it } from "vitest";
import { chainIsUp, deployFresh, fund, hhAccount, type Env } from "./env.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { acctKey, MarketState, newCloid, PerpError, Tif, toPrice, toSize, toUsdc, OrderValidationError, signOrder } from "../src/index.js";

const up = await chainIsUp();
const d = up ? describe : describe.skip;
const P = (n: number | string) => toPrice(n);
const S = (n: number | string) => toSize(n);

d("PerpClient against local node", () => {
  let env: Env;
  beforeAll(async () => {
    env = await deployFresh();
  });

  it("reads markets and config", async () => {
    const c = env.client(hhAccount(1));
    const ms = await c.markets();
    expect(ms).toHaveLength(1);
    expect(ms[0]!.tick).toBe(100_000n);
    expect(ms[0]!.state).toBe(MarketState.Normal);
    expect(await c.markPrice(0)).toBe(P(50000));
    const o = await c.oracleStatus(0);
    expect(o.fresh).toBe(true);
    expect(o.price).toBe(P(50000));
  });

  it("deposit / transferInternal / withdraw", async () => {
    const c = await fund(env, 1, toUsdc(10_000));
    expect(await c.collateral()).toBe(toUsdc(10_000));
    await c.transferInternal(0, 1, toUsdc(1000));
    expect(await c.collateral(1)).toBe(toUsdc(1000));
    expect(await c.collateral(0)).toBe(toUsdc(9000));
    const before = await c.usdcBalance();
    await c.withdraw(toUsdc(500));
    expect((await c.usdcBalance()) - before).toBe(toUsdc(500));
    await expect(c.withdraw(toUsdc(1_000_000))).rejects.toMatchObject({ errorName: "Unhealthy" });
  });

  it("limit orders rest, book snapshot, replace, cancel, cancelAll, errors", async () => {
    const maker = await fund(env, 2, toUsdc(100_000));
    const bid = await maker.placeOrder({ market: 0, isBuy: true, price: P(49900), size: S("0.5"), cloid: newCloid() });
    expect(bid.orderId).toBeGreaterThan(0n);
    expect(bid.filled).toBe(0n);
    const ask = await maker.placeOrder({ market: 0, isBuy: false, price: P(50100), size: S("0.5") });
    const snap = await maker.bookSnapshot(0, 5);
    expect(snap.bids[0]).toEqual({ price: P(49900), size: S("0.5") });
    expect(snap.asks[0]).toEqual({ price: P(50100), size: S("0.5") });
    expect((await maker.openOrders()).map((o) => o.id)).toEqual([bid.orderId, ask.orderId]);
    expect((await maker.accountState()).reservedOrderMargin).toBeGreaterThan(0n);

    const rep = await maker.replaceOrder(bid.orderId, { market: 0, isBuy: true, price: P(49950), size: S("0.5") });
    expect(await maker.getOrder(bid.orderId)).toBeUndefined();
    expect((await maker.getOrder(rep.orderId))!.price).toBe(P(49950));

    await maker.cancelOrder(ask.orderId);
    expect((await maker.openOrders()).map((o) => o.id)).toEqual([rep.orderId]);
    await maker.cancelAll();
    expect(await maker.openOrders()).toEqual([]);
    expect((await maker.accountState()).reservedOrderMargin).toBe(0n);

    // custom error decoding
    const cl = newCloid();
    await maker.placeOrder({ market: 0, isBuy: true, price: P(49000), size: S("0.1"), cloid: cl });
    await expect(maker.placeOrder({ market: 0, isBuy: true, price: P(49000), size: S("0.1"), cloid: cl })).rejects.toMatchObject({ errorName: "DuplicateClientId" });
    await expect(maker.placeOrder({ market: 0, isBuy: true, price: P(50000), size: S("0.1"), tif: Tif.PostOnly, cloid: newCloid() }, { skipValidation: true })).resolves.toBeTruthy(); // no asks: does not cross
    await maker.placeOrder({ market: 0, isBuy: false, price: P(50500), size: S("0.1") });
    await expect(maker.placeOrder({ market: 0, isBuy: true, price: P(50500), size: S("0.1"), tif: Tif.PostOnly })).rejects.toBeInstanceOf(PerpError);
    await expect(maker.placeOrder({ market: 0, isBuy: true, price: P(50500), size: S("5"), tif: Tif.FOK })).rejects.toMatchObject({ errorName: "FokUnfilled" });
    await expect(maker.placeOrder({ market: 0, isBuy: true, price: 50_000_050_000n, size: S("0.1") })).rejects.toBeInstanceOf(OrderValidationError);
    await expect(maker.placeOrder({ market: 0, isBuy: true, price: 50_000_050_000n, size: S("0.1") }, { skipValidation: true })).rejects.toMatchObject({ errorName: "BadParam", args: ["tick"] });
    await maker.cancelAll();
  });

  it("market order (IOC with slippage) crosses a resting maker and positions update", async () => {
    const maker = await fund(env, 3, toUsdc(100_000));
    const taker = await fund(env, 4, toUsdc(20_000));
    await maker.placeOrder({ market: 0, isBuy: false, price: P(50050), size: S("1") });
    const r = await taker.marketOrder({ market: 0, isBuy: true, size: S("0.2"), slippageBps: 20 });
    expect(r.filled).toBe(S("0.2"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(P(50050));
    const pos = await taker.positions();
    expect(pos[0]!.size).toBe(S("0.2"));
    const mpos = await maker.positions();
    expect(mpos[0]!.size).toBe(-S("0.2"));
    const st = await taker.accountState();
    expect(st.maintenanceMargin).toBeGreaterThan(0n);
    expect(st.equity).toBeLessThan(toUsdc(20_000)); // fee paid
    // IOC with a limit below the ask does nothing (no revert)
    const none = await taker.marketOrder({ market: 0, isBuy: true, size: S("0.1"), refPrice: P(49000), slippageBps: 0 });
    expect(none.filled).toBe(0n);
    // fills history
    const fills = await taker.getFills({ acct: taker.acct() });
    expect(fills.length).toBeGreaterThanOrEqual(1);
    // close out: reduce-only market sell
    const close = await taker.marketOrder({ market: 0, isBuy: false, size: S("0.2"), reduceOnly: true, refPrice: P(50000), slippageBps: 100 });
    expect(close.filled).toBe(0n); // no bids -> nothing to hit
    await maker.cancelAll();
  });

  it("EIP-712 signed order relayed by a third party; replay and wrong signer rejected; agent signer works", async () => {
    const owner = await fund(env, 5, toUsdc(50_000));
    const relayer = env.client(hhAccount(6)); // pays gas only; no funds
    const deadline = (await owner.chainTime()) + 600n; // dev chains drift ahead of wall-clock
    const signed = await owner.signOrder({ market: 0, isBuy: true, price: P(49000), size: S("0.1"), cloid: newCloid() });
    const res = await relayer.placeSigned(signed);
    expect(res.orderId).toBeGreaterThan(0n);
    expect((await owner.openOrders())[0]!.id).toBe(res.orderId);
    expect(await owner.isNonceUsed(owner.owner, signed.nonce)).toBe(true);
    await expect(relayer.placeSigned(signed)).rejects.toMatchObject({ errorName: "BadParam", args: ["nonce used"] });

    // signature by a stranger is rejected
    const stranger = privateKeyToAccount(generatePrivateKey());
    const bad = await signOrder({ owner: owner.owner, order: { market: 0, isBuy: true, price: P(49000), size: S("0.1") }, chainId: env.deployment.chainId, exchange: env.deployment.exchange, signer: stranger, deadline });
    await expect(relayer.placeSigned(bad)).rejects.toMatchObject({ errorName: "NotAuthorized" });

    // expired deadline
    const old = await owner.signOrder({ market: 0, isBuy: true, price: P(49000), size: S("0.1") }, { deadline: 1n });
    await expect(relayer.placeSigned(old)).rejects.toMatchObject({ errorName: "Expired" });

    // agent key: sign offline with the agent, relay by anyone
    const agent = privateKeyToAccount(generatePrivateKey());
    const exp = (await owner.chainTime()) + 3600n;
    await owner.approveAgent(agent.address, exp);
    expect(await owner.agentExpiry(agent.address)).toBe(exp);
    const bySigner = await signOrder({ owner: owner.owner, order: { market: 0, isBuy: true, price: P(48000), size: S("0.1") }, chainId: env.deployment.chainId, exchange: env.deployment.exchange, signer: agent, deadline });
    expect(bySigner.signer).toBe(agent.address);
    const ok = await relayer.placeSigned(bySigner);
    expect(ok.orderId).toBeGreaterThan(0n);
    await owner.revokeAgent(agent.address);
    const revoked = await signOrder({ owner: owner.owner, order: { market: 0, isBuy: true, price: P(48000), size: S("0.1") }, chainId: env.deployment.chainId, exchange: env.deployment.exchange, signer: agent, deadline });
    await expect(relayer.placeSigned(revoked)).rejects.toMatchObject({ errorName: "NotAuthorized" });
    await owner.cancelAll();
  });

  it("agent key: trades directly for the owner but cannot withdraw", async () => {
    const owner = await fund(env, 7, toUsdc(50_000));
    const agentAcct = privateKeyToAccount(generatePrivateKey());
    // fund agent with gas
    await (env.wallet(hhAccount(0)) as any).sendTransaction({ to: agentAcct.address, value: 10n ** 18n, account: hhAccount(0), chain: env.chain });
    await owner.approveAgentFor(agentAcct.address, 3600);
    const { createWalletClient, http } = await import("viem");
    const { PerpClient } = await import("../src/index.js");
    const agent = new PerpClient({ publicClient: env.pub, walletClient: createWalletClient({ chain: env.chain, transport: http(), account: agentAcct }), exchange: env.deployment.exchange, usdc: env.deployment.usdc, oracle: env.deployment.oracle, owner: owner.owner });
    const o = await agent.placeOrder({ market: 0, isBuy: true, price: P(47000), size: S("0.1") });
    expect((await owner.getOrder(o.orderId))!.acct).toBe(owner.acct());
    await agent.cancelOrder(o.orderId);
    // withdraw acts on the AGENT's own (empty) account - it can never touch the owner's funds
    await expect(agent.withdraw(1n)).rejects.toMatchObject({ errorName: "Unhealthy" });
    // an unrelated key cannot trade for the owner
    const rnd = new PerpClient({ publicClient: env.pub, walletClient: env.wallet(hhAccount(8)), exchange: env.deployment.exchange, owner: owner.owner });
    await expect(rnd.placeOrder({ market: 0, isBuy: true, price: P(47000), size: S("0.1") })).rejects.toMatchObject({ errorName: "NotAuthorized" });
  });

  it("conditional + bracket orders trigger when mark crosses; TWAP slices execute", async () => {
    await env.setOracle(P(50000));
    const maker = await fund(env, 9, toUsdc(500_000));
    const trader = await fund(env, 10, toUsdc(50_000));
    const keeper = env.client(hhAccount(11));
    await maker.placeOrder({ market: 0, isBuy: false, price: P(50100), size: S("2") });
    await trader.marketOrder({ market: 0, isBuy: true, size: S("0.5"), slippageBps: 50 });
    expect((await trader.positions())[0]!.size).toBe(S("0.5"));
    await maker.cancelAll();

    const { tpId, slId } = await trader.placeBracket({ market: 0, tpTrigger: P(52000), tpLimit: P(51500), slTrigger: P(48000), slLimit: P(47500), size: S("0.5") });
    expect((await trader.getConditional(tpId)).sibling).toBe(slId);
    await expect(keeper.executeConditional(tpId)).rejects.toMatchObject({ errorName: "BadParam", args: ["not triggered"] });
    const id = await trader.placeConditional({ market: 0, isBuy: false, above: true, trigger: P(60000), limit: P(59000), size: S("0.1") });
    await trader.cancelConditional(id);
    expect((await trader.getConditional(id)).active).toBe(false);

    // someone bids at 51500+ so the TP can fill, then oracle moves to the trigger
    await maker.placeOrder({ market: 0, isBuy: true, price: P(51900), size: S("2") });
    await env.setOracle(P(52100));
    await keeper.executeConditional(tpId);
    expect((await trader.positions()).length === 0 || (await trader.positions())[0]!.size === 0n).toBe(true);
    expect((await trader.getConditional(slId)).active).toBe(false); // OCO partner dropped
    await maker.cancelAll();
    await env.setOracle(P(50000));

    // TWAP: buy 0.4 in 2 slices (first due immediately)
    await maker.placeOrder({ market: 0, isBuy: false, price: P(50100), size: S("2") });
    const twap = await trader.placeTwap({ market: 0, isBuy: true, total: S("0.4"), slices: 2, intervalSecs: 60, slippageBps: 100 });
    await keeper.executeTwapSlice(twap);
    const st = await trader.twapStatus(twap);
    expect(st.done).toBe(1);
    expect(st.filled).toBe(S("0.2"));
    await expect(keeper.executeTwapSlice(twap)).rejects.toMatchObject({ errorName: "BadParam", args: ["too early"] });
    await trader.cancelTwap(twap);
    expect((await trader.twapStatus(twap)).active).toBe(false);
    await maker.cancelAll();
  });

  it("isolated margin", async () => {
    const maker = await fund(env, 12, toUsdc(500_000));
    const t = await fund(env, 13, toUsdc(20_000));
    await t.setIsolated(0, true);
    await maker.placeOrder({ market: 0, isBuy: false, price: P(50100), size: S("1") });
    await expect(t.marketOrder({ market: 0, isBuy: true, size: S("0.2") })).rejects.toMatchObject({ errorName: "Unhealthy" });
    await t.addIsoMargin(0, toUsdc(2000));
    await t.marketOrder({ market: 0, isBuy: true, size: S("0.2") });
    const iso = await t.isoState(0);
    expect(iso.isolated).toBe(true);
    expect(iso.margin).toBeGreaterThan(toUsdc(1900));
    expect(iso.initialMargin).toBeGreaterThan(0n);
    expect(await t.collateral()).toBe(toUsdc(18_000)); // cross collateral untouched by the trade
    await expect(t.setIsolated(0, false)).rejects.toMatchObject({ errorName: "BadParam" });
    await maker.cancelAll();
  });

  it("keepers: liquidation, funding poke, ADL errors, market state/oracle degraded handling", async () => {
    await env.setOracle(P(50000));
    const maker = await fund(env, 14, toUsdc(2_000_000));
    const weak = await fund(env, 15, toUsdc(6_000));
    const keeper = env.client(hhAccount(16));
    await maker.placeOrder({ market: 0, isBuy: false, price: P(50100), size: S("1") });
    await weak.marketOrder({ market: 0, isBuy: true, size: S("1"), slippageBps: 50 }); // ~50k notional on 6k collateral
    await maker.cancelAll();
    await expect(keeper.liquidate(weak.acct(), 0)).rejects.toMatchObject({ errorName: "NotLiquidatable" });
    expect(await keeper.isLiquidatable(weak.acct(), 0)).toBe(false);
    await env.setOracle(P(45500));
    expect(await keeper.isLiquidatable(weak.acct(), 0)).toBe(true);
    await keeper.liquidate(weak.acct(), 0);
    const left = (await weak.positions())[0]!;
    expect(left.size).toBeLessThan(S("1"));
    expect(await keeper.collateral(0)).toBeGreaterThan(0n); // keeper fee share credited to keeper sub 0

    await keeper.pokeFunding(0);
    await expect(keeper.adl([weak.acct()], 0)).rejects.toMatchObject({ errorName: "BadParam", args: ["no adl debt"] });
    expect(await keeper.adlDebt(0)).toBe(0n);

    // stale oracle -> OracleDegraded surfaces as a typed error
    await env.setOracleAt(P(45500), 1n);
    await expect(keeper.markPrice(0)).rejects.toMatchObject({ errorName: "OracleDegraded" });
    expect((await keeper.oracleStatus(0)).fresh).toBe(false);
    await env.setOracle(P(50000));
    // admin: market state
    const admin = env.client(hhAccount(0));
    await admin.setMarketState(0, MarketState.Paused);
    expect((await admin.marketConfig(0, true)).state).toBe(MarketState.Paused);
    await expect(maker.placeOrder({ market: 0, isBuy: true, price: P(49000), size: S("0.1") })).rejects.toMatchObject({ errorName: "MarketRestricted" });
    await admin.setMarketState(0, MarketState.Normal);
  });

  it("acctKey matches the contract", async () => {
    const c = env.client(hhAccount(1));
    const onchain = await env.pub.readContract({ address: env.deployment.exchange, abi: (await import("../src/index.js")).exchangeAbi, functionName: "acctKey", args: [c.owner, 3] });
    expect(acctKey(c.owner, 3)).toBe(onchain);
  });
  it("writeOff is permissionless and refuses healthy buckets (cannot hurt anyone)", async () => {
    await env.setOracle(P(50000));
    const healthy = await fund(env, 17, toUsdc(1_000));
    const keeper = env.client(hhAccount(16));
    await expect(keeper.writeOff(healthy.acct(), 0)).rejects.toMatchObject({ errorName: "BadParam", args: ["nothing to write off"] });
    expect(await healthy.collateral()).toBe(toUsdc(1_000));
  });
  it("backstop phase 1: syncBackstop is idempotent, views and admin setters work, principal tracks deposits", async () => {
    await env.setOracle(P(50000));
    const c = await fund(env, 18, toUsdc(1_000));
    expect(await c.principal(c.acct())).toBe(toUsdc(1_000));
    const keeper = env.client(hhAccount(16));
    const eq0 = await keeper.backstopEquity();
    await keeper.syncBackstop(); // nothing to record: must not revert
    await keeper.syncBackstop();
    expect(await keeper.backstopEquity()).toBe(eq0);
    expect(await keeper.bsDebt()).toBeLessThanOrEqual(await keeper.unresolvedBadDebt());
    expect(await keeper.wdGateThreshold()).toBe(toUsdc(100)); // default 100 USDC
    expect(await keeper.adlHardPremBps()).toBe(10000);
    expect(await keeper.withdrawGateActive()).toBe(false);
    const h = await keeper.adlHealth(c.acct(), 0);
    expect(h.slack).toBe(h.equity > h.maintenance ? h.equity - h.maintenance : 0n);
    const admin = env.client(hhAccount(0));
    await admin.setWithdrawGate(toUsdc(5));
    expect(await keeper.wdGateThreshold()).toBe(toUsdc(5));
    await admin.setWithdrawGate(toUsdc(100));
    await expect(keeper.setWithdrawGate(0n)).rejects.toBeTruthy(); // not admin/guardian
  });
  it("backstop phase 2: config round trip, inactive auction, poke is a no-op, take/unwind refuse a market that is not elevated, guardian limits", async () => {
    await env.setOracle(P(50000));
    const admin = env.client(hhAccount(0));
    const anyone = env.client(hhAccount(16));
    const off = await anyone.backstopCfg(0);
    expect(off.softNotional).toBe(0n); // feature is OFF until the admin enables a market
    expect((await anyone.backstopAuction(0)).active).toBe(false);
    await admin.setBackstopCfg(0, { softNotional: toUsdc(1_000_000), maxDiscBps: 200, dwell: 60, ramp: 600, maxAge: 3600 });
    const c = await anyone.backstopCfg(0);
    expect(c).toMatchObject({ softNotional: toUsdc(1_000_000), maxDiscBps: 200, dwell: 60, ramp: 600, maxAge: 3600, elevatedSince: 0n });
    await anyone.pokeBackstop(0); // flat backstop: nothing to start
    expect((await anyone.backstopCfg(0)).elevatedSince).toBe(0n);
    expect((await anyone.backstopAuction(0)).active).toBe(false);
    const taker = await fund(env, 19, toUsdc(10_000));
    await expect(taker.takeBackstop(0, 100_000n, P(60000))).rejects.toBeTruthy(); // not elevated / no inventory
    await expect(anyone.unwindBackstop([taker.acct()], 0)).rejects.toBeTruthy();
    await admin.setBackstopTakeFee(5);
    expect(await anyone.backstopTakeFeeBps()).toBe(5);
    await expect(anyone.setBackstopTakeFee(1)).rejects.toBeTruthy(); // not admin/guardian
    await admin.setBackstopPlaceOpen(false);
    expect(await anyone.backstopPlaceOpen()).toBe(false);
    await admin.setBackstopPlaceOpen(true);
    await admin.setBackstopCfg(0, { softNotional: 0n, maxDiscBps: 0, dwell: 0, ramp: 60, maxAge: 60 }); // switch the market off again
    expect((await anyone.backstopCfg(0)).softNotional).toBe(0n);
  });
});
