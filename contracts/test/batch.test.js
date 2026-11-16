const { expect } = require("chai");
const { ethers, loadFixture, usd, btc, TIF, order, deploy, ledger } = require("./helpers");

const px = (n) => usd(n);

describe("Batch place / cancel / requote", () => {
  async function funded() {
    const e = await deploy();
    for (const s of [e.alice, e.bob, e.carol]) await e.ex.connect(s).deposit(s.address, 0, usd(100_000));
    return e;
  }
  const bids = (prices, size = 0.1, extra = {}) => prices.map((p) => order({ isBuy: true, price: px(p), size: btc(size), ...extra }));
  const idsOf = async (ex, a) => (await ex.openOrderIds(a)).map(Number);

  it("batchPlace rests several orders and returns their ids", async () => {
    const { ex, alice, key } = await loadFixture(funded);
    const ps = [...bids([49900, 49890, 49880]), order({ isBuy: false, price: px(50100), size: btc(0.1) })];
    const [ids] = await ex.connect(alice).batchPlace.staticCall(alice.address, 0, ps, true);
    await ex.connect(alice).batchPlace(alice.address, 0, ps, true);
    expect(ids.map(Number)).to.deep.equal([1, 2, 3, 4]);
    expect(await idsOf(ex, await key(alice))).to.have.members([1, 2, 3, 4]);
    expect((await ex.getLevel(0, true, px(49900))).total).to.equal(btc(0.1));
  });

  it("atomic batch reverts everything if one order is bad", async () => {
    const { ex, alice, key } = await loadFixture(funded);
    const ps = [...bids([49900]), order({ isBuy: true, price: 123_456n, size: btc(0.1) })]; // second off-tick
    await expect(ex.connect(alice).batchPlace(alice.address, 0, ps, true)).to.be.reverted;
    expect(await idsOf(ex, await key(alice))).to.deep.equal([]);
  });

  it("non-atomic batch skips the bad order, runs the rest and reports the rejection", async () => {
    const { ex, alice, key } = await loadFixture(funded);
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: false, price: px(50000), size: btc(1) }));
    const bob = (await ethers.getSigners())[2];
    // bob: first order is post-only and would cross alice's ask; the other two are fine
    const ps = [
      order({ isBuy: true, price: px(50000), size: btc(0.1), tif: TIF.PostOnly }),
      ...bids([49900, 49890]),
    ];
    const tx = await ex.connect(bob).batchPlace(bob.address, 0, ps, false);
    const rc = await tx.wait();
    const rej = rc.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === "BatchItemRejected");
    expect(rej.length).to.equal(1);
    expect(rej[0].args.index).to.equal(0n);
    expect(rej[0].args.reason).to.equal(ex.interface.getError("PostOnlyCross").selector);
    expect((await idsOf(ex, await key(bob))).length).to.equal(2);
  });

  it("a failed non-atomic item rolls back its own side effects (client id stays free)", async () => {
    const { ex, alice, key } = await loadFixture(funded);
    const a = await key(alice);
    const bad = order({ isBuy: true, price: px(50000), size: btc(0.1), tif: TIF.FOK, cloid: 77n }); // nothing to fill: FOK reverts
    const good = order({ isBuy: true, price: px(49900), size: btc(0.1), cloid: 77n });
    await ex.connect(alice).batchPlace(alice.address, 0, [bad, good], false);
    expect(await ex.cloidUsed(a, 77n)).to.equal(true); // used by the good one, so the bad one's rollback freed it first
    expect((await idsOf(ex, a)).length).to.equal(1);
  });

  it("enforces the batch size cap and the open-order cap", async () => {
    const { ex, alice } = await loadFixture(funded);
    const many = bids(Array.from({ length: 33 }, (_, i) => 49000 + i * 10), 0.01);
    await expect(ex.connect(alice).batchPlace(alice.address, 0, many, true)).to.be.revertedWithCustomError(ex, "BadParam");
    const ok = bids(Array.from({ length: 32 }, (_, i) => 49000 + i * 10), 0.01);
    await ex.connect(alice).batchPlace(alice.address, 0, ok, true);
    await expect(ex.connect(alice).batchPlace(alice.address, 0, bids([48000]), true)).to.be.revertedWithCustomError(ex, "TooManyOrders");
  });

  it("only the owner or an agent can batch for an account", async () => {
    const { ex, alice, bob } = await loadFixture(funded);
    await expect(ex.connect(bob).batchPlace(alice.address, 0, bids([49900]), true)).to.be.revertedWithCustomError(ex, "NotAuthorized");
  });

  it("batchCancel cancels many, skips ids that are already gone, and releases reserved margin", async () => {
    const { ex, alice, key } = await loadFixture(funded);
    const a = await key(alice);
    await ex.connect(alice).batchPlace(alice.address, 0, bids([49900, 49890, 49880]), true);
    expect(await ex.reserved(a)).to.be.gt(0n);
    await ex.connect(alice).cancelOrder(2); // already gone by the time the batch runs
    await ex.connect(alice).batchCancel([1, 2, 3, 999]);
    expect(await idsOf(ex, a)).to.deep.equal([]);
    expect(await ex.reserved(a)).to.equal(0n);
  });

  it("batchCancel refuses someone else's order", async () => {
    const { ex, alice, bob } = await loadFixture(funded);
    await ex.connect(alice).batchPlace(alice.address, 0, bids([49900]), true);
    await expect(ex.connect(bob).batchCancel([1])).to.be.revertedWithCustomError(ex, "NotAuthorized");
  });

  it("requote cancels the old ladder and places the new one in one transaction", async () => {
    const { ex, alice, key } = await loadFixture(funded);
    const a = await key(alice);
    await ex.connect(alice).batchPlace(alice.address, 0, bids([49900, 49890]), true);
    const res = await ex.connect(alice).requote.staticCall(alice.address, 0, [1, 2], bids([49950, 49940, 49930]), true);
    await ex.connect(alice).requote(alice.address, 0, [1, 2], bids([49950, 49940, 49930]), true);
    expect(res[0].map(Number)).to.deep.equal([3, 4, 5]);
    expect(await idsOf(ex, a)).to.have.members([3, 4, 5]);
    expect((await ex.getLevel(0, true, px(49900))).total).to.equal(0n);
  });

  it("requote refuses to cancel another account's order", async () => {
    const { ex, alice, bob } = await loadFixture(funded);
    await ex.connect(alice).batchPlace(alice.address, 0, bids([49900]), true);
    await expect(ex.connect(bob).requote(bob.address, 0, [1], bids([49800]), true)).to.be.revertedWithCustomError(ex, "NotAuthorized");
  });

  it("batch orders that cross fill like ordinary orders and keep the ledger balanced", async () => {
    const { ex, alice, bob, carol, key } = await loadFixture(funded);
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.5) }));
    const ps = [order({ isBuy: true, price: px(50000), size: btc(0.3), tif: TIF.IOC }), ...bids([49900])];
    const [, filled] = await ex.connect(bob).batchPlace.staticCall(bob.address, 0, ps, true);
    await ex.connect(bob).batchPlace(bob.address, 0, ps, true);
    expect(filled[0]).to.equal(btc(0.3));
    expect((await ex.positions(await key(bob), 0)).size).to.equal(btc(0.3));
    const L = await ledger(ex, [await key(alice), await key(bob), await key(carol)]);
    expect(L.drift).to.equal(0n);
  });

  it("batching five orders costs less gas per order than five separate transactions", async () => {
    const { ex, alice, bob } = await loadFixture(funded);
    const prices = [49900, 49890, 49880, 49870, 49860];
    let single = 0n;
    for (const p of prices) single += (await (await ex.connect(alice).placeOrder(alice.address, 0, bids([p])[0])).wait()).gasUsed;
    const batched = (await (await ex.connect(bob).batchPlace(bob.address, 0, bids(prices), true)).wait()).gasUsed;
    console.log(`      5 separate places: ${single} gas, one batchPlace: ${batched} gas (${(100 - Number(batched * 100n / single))}% less; excludes the 21k base fee saved per tx and L1 data effects on Arbitrum)`);
    expect(batched).to.be.lt(single);
  });
});
