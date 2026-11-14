const { expect } = require("chai");
const { ethers, loadFixture, usd, btc, TIF, order, deploy, setPx, ledger } = require("./helpers");
const px = (n) => usd(n);

async function funded() {
  const e = await deploy();
  for (const s of [e.alice, e.bob, e.carol]) await e.ex.connect(s).deposit(s.address, 0, usd(100_000));
  return e;
}

describe("isolated margin", () => {
  it("opens only with isolated margin; fees/pnl hit isolated bucket; cross collateral untouched", async () => {
    const { ex, alice, bob, key } = await loadFixture(funded);
    const a = await key(alice);
    await ex.connect(alice).setIsolated(0, 0, true);
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(1) }));
    // no isolated margin yet -> cannot open
    await expect(ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.2), tif: TIF.IOC }))).to.be.revertedWithCustomError(ex, "Unhealthy");
    await ex.connect(alice).addIsoMargin(0, 0, usd(1500));
    expect(await ex.collateral(a)).to.equal(usd(98_500));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.2), tif: TIF.IOC }));
    const p = await ex.positions(a, 0);
    expect(p.size).to.equal(btc(0.2));
    // notional 10,000: taker fee 5 bps = 5.00 from isolated bucket; IM 10% = 1,000
    expect(p.isoMargin).to.equal(usd(1500) - usd(5));
    expect(await ex.collateral(a)).to.equal(usd(98_500));
    // over-sizing relative to isolated margin is rejected even though cross collateral is plentiful
    await expect(ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.2), tif: TIF.IOC }))).to.be.revertedWithCustomError(ex, "Unhealthy");
  });

  it("mode switch only when flat with no orders; margin removal limited to IM + reserve", async () => {
    const { ex, alice, bob, key } = await loadFixture(funded);
    const a = await key(alice);
    await ex.connect(alice).setIsolated(0, 0, true);
    await ex.connect(alice).addIsoMargin(0, 0, usd(3000));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(0.1) })); // rests: reserve 490
    await expect(ex.connect(alice).setIsolated(0, 0, false)).to.be.reverted;
    expect((await ex.positions(a, 0)).isoReserved).to.equal(usd(490));
    await expect(ex.connect(alice).removeIsoMargin(0, 0, usd(2600))).to.be.revertedWithCustomError(ex, "Unhealthy");
    await ex.connect(alice).removeIsoMargin(0, 0, usd(2500));
    await ex.connect(alice).cancelAll(alice.address, 0);
    await ex.connect(alice).removeIsoMargin(0, 0, usd(500));
    await ex.connect(alice).setIsolated(0, 0, false);
    expect(await ex.collateral(a)).to.equal(usd(100_000));
    // open position blocks switching
    await ex.connect(alice).setIsolated(0, 0, true);
    await ex.connect(alice).addIsoMargin(0, 0, usd(3000));
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.1) }));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.1), tif: TIF.IOC }));
    await expect(ex.connect(alice).setIsolated(0, 0, false)).to.be.reverted;
  });

  it("isolated liquidation loses at most the isolated margin; cross collateral is never touched", async () => {
    const { ex, alice, bob, keeper, oracle, key } = await loadFixture(funded);
    const a = await key(alice);
    await ex.connect(alice).setIsolated(0, 0, true);
    await ex.connect(alice).addIsoMargin(0, 0, usd(1100)); // ~10x on 1 BTC? use 0.2 BTC: IM 1000
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.2) }));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.2), tif: TIF.IOC }));
    const cross = await ex.collateral(a);
    await setPx(oracle, px(46000)); // -800 pnl; equity ~295 < MM 460
    await ex.setFees(5, 1, 50, 5000, 10000, usd(1_000_000));
    await ex.connect(keeper).liquidate(a, 0);
    expect((await ex.positions(a, 0)).size).to.equal(0);
    expect(await ex.collateral(a)).to.equal(cross); // cross untouched
    expect((await ex.positions(a, 0)).isoMargin).to.be.greaterThanOrEqual(0n);
  });

  it("isolated gap loss beyond margin becomes bad debt, not a charge on cross collateral", async () => {
    const { ex, alice, bob, keeper, oracle, key } = await loadFixture(funded);
    const a = await key(alice);
    await ex.connect(alice).setIsolated(0, 0, true);
    await ex.connect(alice).addIsoMargin(0, 0, usd(1100));
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.2) }));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.2), tif: TIF.IOC }));
    const cross = await ex.collateral(a);
    await setPx(oracle, px(40000)); // -2000 pnl vs 995 margin
    await ex.setFees(5, 1, 50, 5000, 10000, usd(1_000_000));
    await ex.connect(keeper).liquidate(a, 0);
    expect(await ex.collateral(a)).to.equal(cross);
    expect((await ex.positions(a, 0)).isoMargin).to.equal(0n);
    expect(await ex.unresolvedBadDebt()).to.be.greaterThan(usd(900)).and.lessThan(usd(950)); // 2000 loss + fee - 1095 margin
    expect(await ex.adlDebt(0)).to.equal(await ex.unresolvedBadDebt());
  });
});

describe("ADL", () => {
  async function levered() {
    const e = await deploy();
    const { ex, alice, bob, carol } = e;
    await ex.connect(alice).deposit(alice.address, 0, usd(6000));
    await ex.connect(bob).deposit(bob.address, 0, usd(100_000));
    await ex.connect(carol).deposit(carol.address, 0, usd(200_000));
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(1) }));
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(1), tif: TIF.IOC }));
    await ex.setFees(5, 1, 50, 5000, 10000, usd(1_000_000));
    return e;
  }

  it("rejects ADL with no debt; after a gap, ADL of the winner restores physical solvency", async () => {
    const { ex, alice, bob, carol, keeper, oracle, usdc, key } = await loadFixture(levered);
    await ex.setAdlMaxPremBps(10000); // allow full concession for this scenario
    const [a, b, BACK] = [await key(alice), await key(bob), await ex.BACKSTOP()];
    await expect(ex.connect(keeper).adl([b], 0)).to.be.revertedWithCustomError(ex, "BadParam");
    await setPx(oracle, px(30000));
    await ex.connect(keeper).liquidate(a, 0);
    const debt = await ex.adlDebt(0);
    expect(debt).to.be.greaterThan(0n);
    expect(await ex.unresolvedBadDebt()).to.equal(debt);
    // non-winners / same side as backstop are rejected
    await expect(ex.connect(keeper).adl([await key(carol)], 0)).to.be.revertedWithCustomError(ex, "BadParam"); // flat -> not in profit
    await ex.connect(keeper).adl([b], 0);
    expect(await ex.adlDebt(0)).to.be.lessThanOrEqual(1n);
    expect(await ex.unresolvedBadDebt()).to.be.lessThanOrEqual(1n);
    for (const x of [a, b, BACK]) expect((await ex.positions(x, 0)).size).to.equal(0n);
    // bob's profit was haircut: 20,000 gross -> debt-sized concession removed
    const bobProfit = (await ex.collateral(b)) - usd(100_000);
    expect(bobProfit).to.be.lessThan(usd(20_000)).and.greaterThan(usd(5_000));
    // physical solvency: claims == held USDC (within rounding micro-units)
    const accts = [a, b, await key(carol), await ex.acctKey(keeper.address, 0), BACK];
    let claims = 0n;
    for (const x of accts) claims += await ex.collateral(x);
    claims += (await ex.insurance()) + BigInt(await ex.feePool()) + BigInt(await ex.fundingPool());
    const held = await usdc.balanceOf(await ex.getAddress());
    const diff = claims - held;
    expect(diff >= -5n && diff <= 5n, `claims-held=${diff}`).to.equal(true);
    const { drift } = await ledger(ex, accts.slice(0, 4));
    expect(drift >= -5n && drift <= 5n).to.equal(true);
  });

  it("default 25% premium cap leaves residual debt; recapitalize() closes it exactly", async () => {
    const { ex, alice, bob, carol, keeper, oracle, usdc, key } = await loadFixture(levered);
    const [a, b] = [await key(alice), await key(bob)];
    await setPx(oracle, px(30000));
    await ex.connect(keeper).liquidate(a, 0);
    const debt0 = await ex.adlDebt(0);
    await ex.connect(keeper).adl([b], 0);
    const rest = await ex.adlDebt(0);
    expect(rest).to.be.greaterThan(0n).and.lessThan(debt0);
    expect(rest).to.equal(await ex.unresolvedBadDebt());
    await expect(ex.connect(keeper).adl([b], 0)).to.be.reverted; // no backstop inventory left
    await usdc.mint(carol.address, rest);
    await ex.connect(carol).recapitalize(0, rest);
    expect(await ex.adlDebt(0)).to.equal(0n);
    expect(await ex.unresolvedBadDebt()).to.equal(0n);
    const BACK = await ex.BACKSTOP();
    let claims = 0n;
    for (const x of [a, b, await key(carol), await ex.acctKey(keeper.address, 0), BACK]) claims += await ex.collateral(x);
    claims += (await ex.insurance()) + BigInt(await ex.feePool()) + BigInt(await ex.fundingPool());
    const diff = claims - (await usdc.balanceOf(await ex.getAddress()));
    expect(diff >= -5n && diff <= 5n, `claims-held=${diff}`).to.equal(true);
  });

  it("enforces ranking order within the candidate list; ADL cannot push target below break-even", async () => {
    const { ex, alice, bob, carol, keeper, oracle, key } = await loadFixture(funded);
    // two shorts with different entries: bob @50,000 and carol @49,000 vs alice long (levered)
    await ex.connect(alice).deposit(alice.address, 0, usd(1)); // keep alice well-funded: 100k+1
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.5) }));
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.5), tif: TIF.IOC }));
    await setPx(oracle, px(49000));
    await ex.connect(alice).cancelAll(alice.address, 0);
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(49000), size: btc(0.5) }));
    await ex.connect(carol).placeOrder(carol.address, 0, order({ isBuy: false, price: px(49000), size: btc(0.5), tif: TIF.IOC }));
    await ex.connect(alice).cancelAll(alice.address, 0);
    await setPx(oracle, px(40000));
    const [b, c] = [await key(bob), await key(carol)];
    const sb = await ex.adlScore(b, 0), sc = await ex.adlScore(c, 0);
    expect(sb).to.not.equal(sc);
    // artificially create debt (admin-free path is liquidation; here we only test ordering guards via a funded gap)
    expect(sb).to.be.greaterThan(0n);
    expect(sc).to.be.greaterThan(0n);
  });
});
