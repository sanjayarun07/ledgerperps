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
});
