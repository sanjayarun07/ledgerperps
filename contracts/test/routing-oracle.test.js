const { expect } = require("chai");
const { ethers, usd, btc, TIF, order } = require("./helpers");
const { deployExchange } = require("./helpers");

const REAL = ethers.id("REAL-USD");
const DEMO = ethers.id("DEMO-USD");

describe("RoutingOracle (testnet demo market)", () => {
  async function setup() {
    const [admin, alice, bob, keeper] = await ethers.getSigners();
    const real = await (await ethers.getContractFactory("ManualOracle")).deploy();
    const demo = await (await ethers.getContractFactory("ManualOracle")).deploy();
    const R = await (await ethers.getContractFactory("RoutingOracle")).deploy(await real.getAddress(), await demo.getAddress(), DEMO);
    return { admin, alice, bob, keeper, real, demo, R };
  }

  it("routes only the demo feed to the demo oracle and everything else to main; reverts propagate", async () => {
    const { real, demo, R } = await setup();
    await real.set(REAL, usd(100));
    await demo.set(DEMO, usd(7));
    expect((await R.latest(REAL))[0]).to.equal(usd(100));
    expect((await R.latest(DEMO))[0]).to.equal(usd(7));
    await real.set(DEMO, usd(999)); // a price for the demo id on the REAL oracle must be ignored
    expect((await R.latest(DEMO))[0]).to.equal(usd(7));
    await demo.set(REAL, usd(1)); // and the demo oracle can never feed a real id
    expect((await R.latest(REAL))[0]).to.equal(usd(100));
    await expect(R.latest(ethers.id("UNKNOWN"))).to.be.revertedWith("no price");
  });

  it("has no setters and rejects zero wiring", async () => {
    const { real, demo, R } = await setup();
    const names = R.interface.fragments.filter((f) => f.type === "function").map((f) => f.name).sort();
    expect(names).to.deep.equal(["demo", "demoFeed", "latest", "main"]);
    const F = await ethers.getContractFactory("RoutingOracle");
    await expect(F.deploy(ethers.ZeroAddress, await demo.getAddress(), DEMO)).to.be.revertedWith("zero");
    await expect(F.deploy(await real.getAddress(), await demo.getAddress(), ethers.ZeroHash)).to.be.revertedWith("zero");
  });

  it("an exchange on the router trades a real market and a demo market; the demo price is admin-set and cannot move the real one", async () => {
    const { admin, alice, bob, real, demo, R } = await setup();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const ex = await deployExchange(await usdc.getAddress(), await R.getAddress(), admin);
    const cfg = (feed) => ({ feed, tick: 10_000n, lot: 100_000n, minNotional: usd(1), maxOrderSize: btc(5), maxOI: btc(10), maxAge: 600, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n });
    const MAX = (1n << 128n) - 1n;
    const tiers = [{ upToNotional: usd(100_000), imrBps: 1000, mmrBps: 500 }, { upToNotional: usd(1_000_000), imrBps: 2000, mmrBps: 1000 }, { upToNotional: MAX, imrBps: 5000, mmrBps: 2500 }];
    await real.set(REAL, usd(100));
    await demo.set(DEMO, usd(100));
    await ex.createMarket(cfg(REAL), tiers);
    await ex.createMarket(cfg(DEMO), tiers);
    expect(await ex.markPrice(0)).to.equal(usd(100));
    expect(await ex.markPrice(1)).to.equal(usd(100));
    await demo.set(DEMO, usd(80));
    expect(await ex.markPrice(1)).to.equal(usd(80));
    expect(await ex.markPrice(0)).to.equal(usd(100), "the real market is unaffected by the demo feed");
    // stale demo feed degrades ONLY the demo market
    await demo.setAt(DEMO, usd(80), 1);
    await expect(ex.markPrice(1)).to.be.reverted;
    expect(await ex.markPrice(0)).to.equal(usd(100));
    void alice; void bob; void TIF; void order;
  });
});
