// Self-audit proof tests (see docs/SELF_AUDIT.md). These document CURRENT behaviour, including findings that are not yet fixed.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers.js");

describe("self-audit proofs", () => {
  const tiers = [{ upToNotional: (1n << 128n) - 1n, imrBps: 1000, mmrBps: 500 }];
  const cfg = (o) => ({ feed: ethers.id("X-USD"), tick: 100_000n, lot: 10_000n, minNotional: 10_000_000n, maxOrderSize: 10n ** 10n, maxOI: 10n ** 11n,
    maxAge: 60, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n, ...o });

  it("SA-1: createMarket enforces the same bounds as setMarketParams", async () => {
    const ctx = await loadFixture(H.deploy);
    const ex = ctx.ex;
    const oracle = ctx.oracle;
    await oracle.set(ethers.id("X-USD"), 50_000_000_000n);
    const id = Number(await ex.marketCount());
    // FIXED: createMarket now applies the same bounds as setMarketParams (before the fix this call was accepted)
    for (const bad of [{ bandBps: 20000 }, { maxAge: 0 }, { maxSpreadBps: 5000 }, { fundingCap: 10n ** 12n }])
      await expect(ex.createMarket(cfg(bad), tiers)).to.be.revertedWith("bounds");
    await ex.createMarket(cfg({}), tiers); // sane config still works
    expect(Number(await ex.marketCount())).to.equal(id + 1);
  });
  it("SA-2: one funding sample stands for at most MAX_SAMPLE_HOLD seconds (no extrapolation over a long gap)", async () => {
    const { ex, carol, oracle } = await loadFixture(H.deploy);
    const px = (n) => BigInt(Math.round(n * 1e6));
    await ex.connect(carol).deposit(carol.address, 0, H.usd(100_000));
    // carol quotes a book whose mid (50,500) is +1% over the 50,000 index => a +1% premium sample
    await ex.connect(carol).placeOrder(carol.address, 0, H.order({ isBuy: true, price: px(50400), size: H.btc(0.1) }));
    await ex.connect(carol).placeOrder(carol.address, 0, H.order({ isBuy: false, price: px(50600), size: H.btc(0.1) }));
    await ex.pokeFunding(0);                       // records the skewed sample
    await ex.connect(carol).cancelAll(carol.address, 0);
    await H.time.increase(1000); await H.setPx(oracle, px(50000));
    await ex.pokeFunding(0);                       // a 1000 s gap: the +1% sample may only count for MAX_SAMPLE_HOLD
    const hold = await ex.MAX_SAMPLE_HOLD();
    expect(hold).to.equal(300n);
    expect((await ex.getMarket(0)).sampledTime).to.equal(hold); // before the fix this was 1000
    // the average premium is unchanged by the cap (1% / premiumDivisor 8 = 0.125% = 1_250_000 in 1e9 rate units)
    expect(await ex.estimatedFundingRate(0)).to.be.greaterThan(0n);
  });

  describe("SA-8: ChainlinkAdapter bounds and stale-round check", () => {
    const ID = ethers.id("BTC-USD");
    async function adapter() {
      const [admin, other] = await ethers.getSigners();
      const a = await (await ethers.getContractFactory("ChainlinkAdapter")).deploy();
      const agg = await (await ethers.getContractFactory("MockAggregator")).deploy();
      await a.setFeed(ID, await agg.getAddress());
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await agg.set(64_000n * 10n ** 8n, now);
      return { a, agg, admin, other, now };
    }
    it("unbounded by default (old behaviour), converts 8 decimals to 1e6", async () => {
      const { a } = await adapter();
      expect((await a.latest(ID))[0]).to.equal(64_000n * 10n ** 6n);
    });
    it("rejects a price outside the configured bounds, accepts one inside", async () => {
      const { a, agg, now } = await adapter();
      await a.setBounds(ID, 10_000n * 10n ** 6n, 200_000n * 10n ** 6n);
      expect((await a.latest(ID))[0]).to.equal(64_000n * 10n ** 6n);
      await agg.set(5_000n * 10n ** 8n, now);       // feed pinned at a circuit-breaker floor
      await expect(a.latest(ID)).to.be.revertedWith("out of bounds");
      await agg.set(900_000n * 10n ** 8n, now);
      await expect(a.latest(ID)).to.be.revertedWith("out of bounds");
    });
    it("only the admin sets bounds, and min must be below max", async () => {
      const { a, other } = await adapter();
      await expect(a.connect(other).setBounds(ID, 1n, 2n)).to.be.revertedWith("admin");
      await expect(a.setBounds(ID, 5n, 5n)).to.be.revertedWith("bounds");
      await expect(a.setBounds(ID, 1n, 2n)).to.emit(a, "BoundsSet").withArgs(ID, 1n, 2n);
    });
    it("rejects a stale round, but accepts answeredInRound == 0 (deprecated field)", async () => {
      const { a, agg } = await adapter();
      await agg.setAnsweredInRound(0);
      expect((await a.latest(ID))[0]).to.equal(64_000n * 10n ** 6n);
      await agg.set(64_000n * 10n ** 8n, (await ethers.provider.getBlock("latest")).timestamp);
      await agg.setAnsweredInRound(1);               // round id is now 2, answered in round 1
      await expect(a.latest(ID)).to.be.revertedWith("stale round");
    });
    it("emits FeedSet", async () => {
      const { a, agg } = await adapter();
      await expect(a.setFeed(ID, await agg.getAddress())).to.emit(a, "FeedSet");
    });
  });
});
