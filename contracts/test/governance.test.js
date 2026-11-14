const { expect } = require("chai");
const { ethers, loadFixture, time, usd, btc, TIF, order, deploy, setPx } = require("./helpers");
const px = (n) => usd(n);

async function funded() {
  const e = await deploy();
  for (const s of [e.alice, e.bob, e.carol]) await e.ex.connect(s).deposit(s.address, 0, usd(100_000));
  return e;
}
const types = {
  OrderAction: [
    { name: "owner", type: "address" }, { name: "sub", type: "uint8" }, { name: "market", type: "uint8" }, { name: "isBuy", type: "bool" },
    { name: "price", type: "uint64" }, { name: "size", type: "uint128" }, { name: "tif", type: "uint8" }, { name: "reduceOnly", type: "bool" },
    { name: "cloid", type: "uint64" }, { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
  CancelAction: [
    { name: "owner", type: "address" }, { name: "sub", type: "uint8" }, { name: "orderId", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
};
async function domain(ex) { const n = await ethers.provider.getNetwork(); return { name: "PerpExchange", version: "1", chainId: n.chainId, verifyingContract: await ex.getAddress() }; }

describe("pause policy", () => {
  it("global pause stops new risk but liquidation still works", async () => {
    const { ex, alice, bob, keeper, oracle, key } = await loadFixture(funded);
    await ex.connect(alice).withdraw(0, usd(94_000));
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(1) }));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(1), tif: TIF.IOC }));
    await ex.setGlobalPause(true);
    await expect(ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50100), size: btc(0.1) }))).to.be.revertedWithCustomError(ex, "MarketRestricted");
    await setPx(oracle, px(45500));
    await ex.connect(keeper).liquidate(await key(alice), 0); // must not revert
    expect((await ex.positions(await key(alice), 0)).size).to.equal(btc(0.5));
  });
});

describe("delisting / final settlement", () => {
  it("requires reduce-only first; settles all positions at the frozen price; backstop ends flat", async () => {
    const { ex, alice, bob, oracle, key, admin } = await loadFixture(funded);
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(1) }));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(1), tif: TIF.IOC }));
    await expect(ex.delistMarket(0, px(51000))).to.be.revertedWith("must be reduce-only");
    await ex.setMarketState(0, 1);
    await ex.delistMarket(0, px(51000));
    await expect(ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(0.1) }))).to.be.revertedWithCustomError(ex, "MarketRestricted");
    const [a, b] = [await key(alice), await key(bob)];
    const ca = await ex.collateral(a), cb = await ex.collateral(b);
    await ex.settleDelisted(a, 0);
    await ex.settleDelisted(b, 0);
    expect((await ex.collateral(a)) - ca).to.equal(usd(1000)); // long 1 BTC, 50k -> 51k
    expect((await ex.collateral(b)) - cb).to.equal(-usd(1000));
    for (const x of [a, b, await ex.BACKSTOP()]) expect((await ex.positions(x, 0)).size).to.equal(0n);
    expect((await ex.getMarket(0)).oi).to.equal(0n);
    await expect(ex.settleDelisted(a, 0)).to.be.revertedWithCustomError(ex, "BadParam");
    await ex.connect(alice).withdraw(0, usd(100_000)); // frees fully, no oracle needed
  });
});

describe("per-market parameters", () => {
  it("bounded, admin-only", async () => {
    const { ex, alice } = await loadFixture(funded);
    await expect(ex.connect(alice).setMarketParams(0, 1, 1, 1, 60, 500, 100, 1)).to.be.reverted;
    await expect(ex.setMarketParams(0, btc(10), btc(100), usd(10), 60, 5000, 100, 1)).to.be.revertedWith("bounds");
    await ex.setMarketParams(0, btc(10), btc(100), usd(10), 60, 300, 100, 1_000_000);
    expect((await ex.getMarket(0)).maxOrderSize).to.equal(btc(10));
    await expect(ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(11) }))).to.be.revertedWithCustomError(ex, "BadParam");
    const MAX = (1n << 128n) - 1n;
    await expect(ex.setTiers(0, [{ upToNotional: 1000n, imrBps: 1000, mmrBps: 500 }])).to.be.revertedWith("last tier unbounded");
    await ex.setTiers(0, [{ upToNotional: MAX, imrBps: 2000, mmrBps: 1000 }]);
  });
});

describe("timelock governance", () => {
  it("admin held by a TimelockController: direct calls fail, scheduled calls execute only after the delay", async () => {
    const { ex, admin, alice } = await loadFixture(funded);
    const Timelock = await ethers.getContractFactory("TimelockController");
    const delay = 3600;
    const tl = await Timelock.deploy(delay, [alice.address], [alice.address], ethers.ZeroAddress); // alice = stand-in multisig
    await ex.grantRole(await ex.DEFAULT_ADMIN_ROLE(), await tl.getAddress());
    await ex.renounceRole(await ex.DEFAULT_ADMIN_ROLE(), admin.address);
    await expect(ex.setFees(5, 1, 50, 5000, 5000, usd(10_000))).to.be.reverted;
    const data = ex.interface.encodeFunctionData("setFees", [6, 1, 50, 5000, 5000, usd(10_000)]);
    const salt = ethers.id("fee-change-1");
    await tl.connect(alice).schedule(await ex.getAddress(), 0, data, ethers.ZeroHash, salt, delay);
    await expect(tl.connect(alice).execute(await ex.getAddress(), 0, data, ethers.ZeroHash, salt)).to.be.reverted; // too early
    await time.increase(delay + 1);
    await tl.connect(alice).execute(await ex.getAddress(), 0, data, ethers.ZeroHash, salt);
    expect(await ex.takerFeeBps()).to.equal(6n);
  });
});

describe("agent scopes", () => {
  it("scoped key is limited by market mask and order notional across order/conditional/twap paths", async () => {
    const { ex, alice, agent } = await loadFixture(funded);
    await ex.connect(alice).approveAgentScoped(0, agent.address, 2n ** 60n, 1n /* market 0 only */, usd(6000));
    await ex.connect(agent).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(0.1) })); // 4,900 ok
    await expect(ex.connect(agent).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(0.2) }))).to.be.revertedWithCustomError(ex, "NotAuthorized");
    await expect(ex.connect(agent).placeOrder(alice.address, 1, order({ market: 1, isBuy: true, price: px(2900), size: btc(0.1) }))).to.be.revertedWithCustomError(ex, "NotAuthorized");
    await expect(ex.connect(agent).placeConditional(alice.address, 0, 0, true, true, px(55000), px(55100), btc(0.2), false)).to.be.revertedWithCustomError(ex, "NotAuthorized");
    await expect(ex.connect(agent).placeTwap(alice.address, 0, 0, true, btc(0.2), 4, 60, 100, false)).to.be.revertedWithCustomError(ex, "NotAuthorized");
    await expect(ex.connect(agent).withdraw(0, 1n)).to.be.reverted; // never
    // owner re-approving unscoped clears the scope
    await ex.connect(alice).approveAgent(0, agent.address, 2n ** 60n);
    await ex.connect(agent).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(0.2) }));
  });
});

describe("signed cancel + EIP-1271", () => {
  it("owner and agent signatures cancel; replay and foreign orders rejected", async () => {
    const { ex, alice, bob, relayer, agent } = await loadFixture(funded);
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(0.1) })); // id1
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: true, price: px(48000), size: btc(0.1) })); // id2
    const dl = BigInt(await time.latest()) + 600n;
    const d = await domain(ex);
    const sig = await alice.signTypedData(d, { CancelAction: types.CancelAction }, { owner: alice.address, sub: 0, orderId: 1, nonce: 1, deadline: dl });
    await ex.connect(relayer).cancelSigned(alice.address, 0, 1, 1, dl, sig);
    expect(await ex.bestPrice(0, true)).to.equal(px(48000));
    await expect(ex.connect(relayer).cancelSigned(alice.address, 0, 1, 1, dl, sig)).to.be.reverted; // replay
    const sig2 = await alice.signTypedData(d, { CancelAction: types.CancelAction }, { owner: alice.address, sub: 0, orderId: 2, nonce: 2, deadline: dl });
    await expect(ex.connect(relayer).cancelSigned(alice.address, 0, 2, 2, dl, sig2)).to.be.revertedWithCustomError(ex, "BadParam"); // bob's order
    await ex.connect(alice).approveAgent(0, agent.address, 2n ** 60n);
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49500), size: btc(0.1) })); // id3
    const sig3 = await agent.signTypedData(d, { CancelAction: types.CancelAction }, { owner: alice.address, sub: 0, orderId: 3, nonce: 3, deadline: dl });
    await ex.connect(relayer).cancelSigned(alice.address, 0, 3, 3, dl, sig3);
  });

  it("smart-contract wallet (EIP-1271) owner can place orders via signature", async () => {
    const { ex, usdc, alice, bob, relayer } = await loadFixture(funded);
    const W = await (await ethers.getContractFactory("Mock1271Wallet")).deploy(alice.address);
    const wallet = await W.getAddress();
    await ex.connect(bob).deposit(wallet, 0, usd(50_000)); // anyone may fund an account
    const o = order({ isBuy: true, price: px(49000), size: btc(0.1) });
    const dl = BigInt(await time.latest()) + 600n;
    const d = await domain(ex);
    const v = { owner: wallet, sub: 0, market: 0, isBuy: true, price: o.price, size: o.size, tif: 0, reduceOnly: false, cloid: 0, expiry: 0, nonce: 1, deadline: dl };
    const good = await alice.signTypedData(d, { OrderAction: types.OrderAction }, v);
    const bad = await bob.signTypedData(d, { OrderAction: types.OrderAction }, v);
    await expect(ex.connect(relayer).placeSigned(wallet, 0, o, 1, dl, bad)).to.be.revertedWithCustomError(ex, "NotAuthorized");
    await ex.connect(relayer).placeSigned(wallet, 0, o, 1, dl, good);
    expect((await ex.openOrderIds(await ex.acctKey(wallet, 0))).length).to.equal(1);
  });
});
