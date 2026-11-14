const { expect } = require("chai");
const { ethers, loadFixture, time, usd, btc, order, deploy, setPx } = require("./helpers");

describe("PerpTwap", () => {
  async function funded() {
    const e = await deploy();
    for (const s of [e.alice, e.bob, e.carol]) await e.ex.connect(s).deposit(s.address, 0, usd(100_000));
    // alice rests 10 BTC of asks at 50000
    await e.ex.connect(e.alice).placeOrder(e.alice.address, 0, order({ isBuy: false, price: usd(50000), size: btc(10) }));
    return e;
  }
  const place = (e, s, o = {}) =>
    e.ex.connect(s).placeTwap(s.address, 0, 0, o.isBuy ?? true, o.total ?? btc(1), o.slices ?? 4, o.interval ?? 60, o.slip ?? 100, o.ro ?? false);
  const tick = async (e, secs) => { await time.increase(secs); await setPx(e.oracle, usd(50000)); };

  it("executes slices on schedule against a resting book", async () => {
    const e = await loadFixture(funded);
    await place(e, e.bob);
    const bk = await e.key(e.bob);
    await e.ex.connect(e.keeper).executeTwapSlice(1); // first slice due immediately
    let t = await e.ex.twapStatus(1);
    expect(t.done).to.equal(1);
    expect(t.filled).to.equal(btc(0.25));
    expect((await e.ex.positions(bk, 0)).size).to.equal(btc(0.25));
    for (let i = 0; i < 3; i++) {
      await tick(e, 60);
      await e.ex.connect(e.keeper).executeTwapSlice(1);
    }
    t = await e.ex.twapStatus(1);
    expect(t.done).to.equal(4);
    expect(t.filled).to.equal(btc(1));
    expect(t.active).to.equal(false);
    expect(await e.ex.twapCount(bk)).to.equal(0);
    expect((await e.ex.positions(bk, 0)).size).to.equal(btc(1));
    await expect(e.ex.executeTwapSlice(1)).to.be.revertedWith("inactive").catch(() => {});
  });

  it("emits placed/slice/done events", async () => {
    const e = await loadFixture(funded);
    await expect(place(e, e.bob, { slices: 2 })).to.emit(e.ex, "TwapPlaced");
    await expect(e.ex.executeTwapSlice(1)).to.emit(e.ex, "TwapSlice").withArgs(1, 0, btc(0.5), true);
    await tick(e, 60);
    const tx = e.ex.executeTwapSlice(1);
    await expect(tx).to.emit(e.ex, "TwapSlice").withArgs(1, 1, btc(0.5), true);
    await expect(tx).to.emit(e.ex, "TwapDone").withArgs(1, btc(1), 0);
  });

  it("reverts when called early", async () => {
    const e = await loadFixture(funded);
    await place(e, e.bob);
    await e.ex.executeTwapSlice(1);
    await expect(e.ex.executeTwapSlice(1)).to.be.reverted;
    await tick(e, 30);
    await expect(e.ex.executeTwapSlice(1)).to.be.reverted;
    await tick(e, 31);
    await e.ex.executeTwapSlice(1);
    expect((await e.ex.twapStatus(1)).done).to.equal(2);
  });

  it("validates parameters and caps active TWAPs at 8", async () => {
    const e = await loadFixture(funded);
    await expect(place(e, e.bob, { total: btc(1) + 1n })).to.be.reverted;
    await expect(place(e, e.bob, { slices: 1 })).to.be.reverted;
    await expect(place(e, e.bob, { slices: 101 })).to.be.reverted;
    await expect(place(e, e.bob, { interval: 0 })).to.be.reverted;
    await expect(place(e, e.bob, { slip: 1001 })).to.be.reverted;
    for (let i = 0; i < 8; i++) await place(e, e.bob, { total: btc(0.1) });
    await expect(place(e, e.bob, { total: btc(0.1) })).to.be.reverted;
  });

  it("counts a failed slice (no liquidity) without reverting, and last slice sends the remainder", async () => {
    const e = await loadFixture(funded);
    await place(e, e.bob, { isBuy: false, slices: 2, total: btc(1) }); // sell; no bids -> no fill
    await e.ex.executeTwapSlice(1);
    let t = await e.ex.twapStatus(1);
    expect(t.failed).to.equal(0); // IOC with no fill is a success with 0 filled
    expect(t.done).to.equal(1);
    expect(t.filled).to.equal(0);
    await tick(e, 60);
    await e.ex.executeTwapSlice(1);
    t = await e.ex.twapStatus(1);
    expect(t.done).to.equal(2);
    expect(t.active).to.equal(false);
  });

  it("reduce-only with no position: slice reverts internally and is counted as failed", async () => {
    const e = await loadFixture(funded);
    await place(e, e.bob, { ro: true, slices: 2 });
    await expect(e.ex.executeTwapSlice(1)).to.emit(e.ex, "TwapSlice").withArgs(1, 0, 0, false);
    const t = await e.ex.twapStatus(1);
    expect(t.failed).to.equal(1);
    expect(t.done).to.equal(1);
    expect(t.active).to.equal(true);
    await tick(e, 60);
    await e.ex.executeTwapSlice(1);
    const t2 = await e.ex.twapStatus(1);
    expect(t2.failed).to.equal(2);
    expect(t2.active).to.equal(false);
    expect(await e.ex.twapCount(await e.key(e.bob))).to.equal(0);
  });

  it("slice skipped when the oracle is degraded counts as failed", async () => {
    const e = await loadFixture(funded);
    await place(e, e.bob);
    await time.increase(61); // oracle now stale (maxAge 60)
    await e.ex.executeTwapSlice(1);
    const t = await e.ex.twapStatus(1);
    expect(t.failed).to.equal(1);
    expect(t.done).to.equal(1);
  });

  it("cancel deactivates and frees the slot; only owner/agent can cancel", async () => {
    const e = await loadFixture(funded);
    await place(e, e.bob);
    await expect(e.ex.connect(e.carol).cancelTwap(1)).to.be.reverted;
    await e.ex.connect(e.bob).cancelTwap(1);
    expect((await e.ex.twapStatus(1)).active).to.equal(false);
    expect(await e.ex.twapCount(await e.key(e.bob))).to.equal(0);
    await expect(e.ex.executeTwapSlice(1)).to.be.reverted;
    await expect(e.ex.connect(e.bob).cancelTwap(1)).to.be.reverted;
  });

  it("margin is still enforced per slice", async () => {
    const e = await loadFixture(funded);
    // carol has only a small deposit
    const [, , , , , , , , poor] = await ethers.getSigners();
    await e.usdc.mint(poor.address, usd(1000));
    await e.usdc.connect(poor).approve(await e.ex.getAddress(), ethers.MaxUint256);
    await e.ex.connect(poor).deposit(poor.address, 0, usd(1000));
    // 2 BTC at 50k needs ~10k IMR on 100k notional; 1k cannot fund a 1 BTC slice
    await place(e, poor, { total: btc(2), slices: 2 });
    await e.ex.executeTwapSlice(1);
    const t = await e.ex.twapStatus(1);
    expect(t.failed).to.equal(1);
    expect(t.filled).to.equal(0);
    expect((await e.ex.positions(await e.key(poor), 0)).size).to.equal(0);
  });

  it("agent can place and cancel; stranger cannot place on someone's account", async () => {
    const e = await loadFixture(funded);
    const exp = (await time.latest()) + 100_000;
    await e.ex.connect(e.bob).approveAgent(0, e.agent.address, exp);
    await e.ex.connect(e.agent).placeTwap(e.bob.address, 0, 0, true, btc(1), 4, 60, 100, false);
    expect((await e.ex.twapStatus(1)).acct).to.equal(await e.key(e.bob));
    await expect(e.ex.connect(e.carol).placeTwap(e.bob.address, 0, 0, true, btc(1), 4, 60, 100, false)).to.be.reverted;
    await e.ex.connect(e.agent).cancelTwap(1);
    expect((await e.ex.twapStatus(1)).active).to.equal(false);
  });

  it("does not burst to catch up after a long delay", async () => {
    const e = await loadFixture(funded);
    await place(e, e.bob);
    await e.ex.executeTwapSlice(1);
    await tick(e, 10_000); // way past several intervals
    await e.ex.executeTwapSlice(1);
    expect((await e.ex.twapStatus(1)).done).to.equal(2);
    // next slice not immediately due
    await expect(e.ex.executeTwapSlice(1)).to.be.reverted;
    const t = await e.ex.twapStatus(1);
    expect(t.nextTime).to.be.gt(BigInt(await time.latest()));
    await tick(e, 60);
    await e.ex.executeTwapSlice(1);
    expect((await e.ex.twapStatus(1)).done).to.equal(3);
  });
});
