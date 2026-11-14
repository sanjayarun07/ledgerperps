// Chain-side driver for the keeper e2e. Run with:  E2E_PHASE=<phase> npx hardhat --config hardhat.e2e.config.js run --no-compile e2e-chain.js --network localhost
// Phases: deploy | stale | crash | assert-liquidated | assert-idle | extras | pump | assert-extras | reorg-deposit | reorg-replace | adl-setup | assert-adl
// Uses only the public ABI of the contracts (reads test/helpers.js for the module deployment helper; does not edit it).
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const contracts = path.resolve(__dirname, "../../../contracts");
const { deployExchange } = require(path.join(contracts, "test/helpers.js"));

const OUT = process.env.E2E_OUT;
const usd = (n) => BigInt(Math.round(n * 1e6));
const px = (n) => BigInt(Math.round(n * 1e6));
const sz = (x) => BigInt(Math.round(x * 1e8));
const TIF = { GTC: 0, IOC: 1, FOK: 2, PostOnly: 3 };
const ord = (o) => ({ market: o.market ?? 0, isBuy: o.isBuy, price: o.price, size: o.size, tif: o.tif ?? TIF.GTC, reduceOnly: o.reduceOnly ?? false, cloid: 0n, expiry: 0n });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log("ASSERT OK:", m);
function fail(m) { console.error("ASSERT FAIL:", m); process.exit(1); }
function assert(c, m) { if (!c) fail(m); ok(m); }

async function load() {
  const d = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const s = await ethers.getSigners();
  const exAbi = JSON.parse(fs.readFileSync(path.join(contracts, "abi/PerpExchange.merged.json"), "utf8"));
  const ex = new ethers.Contract(d.exchange, exAbi, s[0]);
  const oracle = await ethers.getContractAt("ManualOracle", d.oracle);
  return { d, s, ex, oracle };
}

async function waitFor(label, fn, secs = 30) {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) { if (await fn()) return ok(label); await sleep(500); }
  fail(`timeout waiting for: ${label}`);
}

const phases = {
  async deploy() {
    const [admin, alice, bob, carol, keeper, , , , dave] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const oracle = await (await ethers.getContractFactory("ManualOracle")).deploy();
    const ex = await deployExchange(await usdc.getAddress(), await oracle.getAddress(), admin);
    const markets = [["BTC-USD", 50000, 100000, 10000], ["ETH-USD", 3000, 10000, 100000]];
    const MAX = (1n << 128n) - 1n;
    for (const [name, p, tick, lot] of markets) {
      const feed = ethers.id(name);
      await oracle.set(feed, px(p));
      await ex.createMarket({ feed, tick, lot, minNotional: 10_000_000n, maxOrderSize: 10n ** 12n, maxOI: 10n ** 13n, maxAge: 3600, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n },
        [{ upToNotional: 100_000_000_000n, imrBps: 1000, mmrBps: 500 }, { upToNotional: 1_000_000_000_000n, imrBps: 2000, mmrBps: 1000 }, { upToNotional: MAX, imrBps: 5000, mmrBps: 2500 }]);
    }
    for (const s of [alice, bob, carol, dave]) {
      await usdc.mint(s.address, usd(1_000_000));
      await usdc.connect(s).approve(await ex.getAddress(), ethers.MaxUint256);
    }
    // alice: 1 BTC long with 6000 collateral (~8x) against bob's ask
    await ex.connect(alice).deposit(alice.address, 0, usd(6000));
    await ex.connect(bob).deposit(bob.address, 0, usd(100_000));
    await ex.connect(bob).placeOrder(bob.address, 0, ord({ isBuy: false, price: px(50000), size: sz(1) }));
    await ex.connect(alice).placeOrder(alice.address, 0, ord({ isBuy: true, price: px(50000), size: sz(1), tif: TIF.IOC }));
    await ex.connect(bob).cancelAll(bob.address, 0);
    const head = await ethers.provider.getBlockNumber();
    const out = {
      chainId: Number((await ethers.provider.getNetwork()).chainId), exchange: await ex.getAddress(), oracle: await oracle.getAddress(), usdc: await usdc.getAddress(),
      feeds: { btc: ethers.id("BTC-USD"), eth: ethers.id("ETH-USD") }, startBlock: 0, headAtDeploy: head,
      alice: alice.address, bob: bob.address, carol: carol.address, dave: dave.address, keeper: keeper.address,
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log("deployed exchange", out.exchange, "alice key", await ex.acctKey(alice.address, 0));
  },

  async stale() { // fresh-looking price but with an old timestamp => oracle reads as stale (maxAge 3600s)
    const { d, oracle } = await load();
    const blk = await ethers.provider.getBlock("latest");
    await oracle.setAt(d.feeds.btc, px(45500), blk.timestamp - 7200);
    console.log("BTC oracle now 45500 but STALE (timestamp 2h old)");
  },

  async crash() {
    const { d, oracle } = await load();
    await oracle.set(d.feeds.btc, px(45500));
    console.log("BTC oracle now 45500 and fresh: alice is underwater");
  },

  async "assert-idle"() {
    const { d, ex } = await load();
    const a = await ex.acctKey(d.alice, 0);
    const p = await ex.positions(a, 0);
    assert(p.size === sz(1), `alice position untouched (${p.size})`);
  },

  async "assert-liquidated"() {
    const { d, ex, s } = await load();
    const a = await ex.acctKey(d.alice, 0);
    await waitFor("alice liquidated to 0.5 BTC", async () => (await ex.positions(a, 0)).size === sz(0.5), 40);
    const back = await ex.BACKSTOP();
    assert((await ex.positions(back, 0)).size === sz(0.5), "backstop took 0.5 BTC");
    const kcol = await ex.collateral(await ex.acctKey(d.keeper, 0));
    assert(kcol > 0n, `keeper earned its liquidation fee share (${kcol} = ${Number(kcol) / 1e6} USDC)`);
    const ev = await ex.queryFilter(ex.filters.Liquidated(a));
    assert(ev.length === 1 && ev[0].args.keeper === d.keeper, `exactly one Liquidated event, by the keeper address`);
  },

  async extras() { // bob (short 1 BTC): conditional buy-to-close above 46000, plus a 2-slice TWAP (due immediately)
    const { d, ex, s } = await load();
    const bob = s[2];
    await ex.connect(bob).placeConditional(bob.address, 0, 0, true, true, px(46000), px(60000), sz(0.1), true);
    await ex.connect(bob).placeTwap(bob.address, 0, 0, true, sz(0.02), 2, 2, 100, true);
    console.log("placed conditional (above 46000) and TWAP (2 slices / 2s) for bob");
  },

  async pump() {
    const { d, oracle } = await load();
    await oracle.set(d.feeds.btc, px(46500));
    console.log("BTC oracle now 46500 -> conditional trigger crossed");
  },

  async "assert-extras"() {
    const { ex } = await load();
    await waitFor("CondTriggered emitted by keeper execution", async () => (await ex.queryFilter(ex.filters.CondTriggered())).length >= 1, 30);
    await waitFor("both TWAP slices executed", async () => (await ex.queryFilter(ex.filters.TwapSlice())).length >= 2, 30);
    await waitFor("TwapDone emitted", async () => (await ex.queryFilter(ex.filters.TwapDone())).length >= 1, 30);
  },

  async "reorg-deposit"() { // a brand-new account (eve) deposits: the keeper must discover it ...
    const { d, s, ex } = await load();
    const eve = s[5];
    const usdc = await ethers.getContractAt("MockUSDC", d.usdc);
    await usdc.mint(eve.address, usd(1000));
    await usdc.connect(eve).approve(d.exchange, ethers.MaxUint256);
    await ex.connect(eve).deposit(eve.address, 0, usd(1000));
    console.log("eve deposited (this block range is about to be reorged out)");
  },

  async "reorg-replace"() { // ... and after evm_revert the replacement chain gets different blocks (different txs => different hashes)
    const { s } = await load();
    for (let i = 0; i < 4; i++) await s[0].sendTransaction({ to: s[6].address, value: 1n + BigInt(i) });
    console.log("mined 4 replacement blocks with different contents");
  },

  async "adl-setup"() { // gap move that creates unresolved bad debt, so adlDebt > 0 after the keeper's liquidation
    const { d, ex, s, oracle } = await load();
    const [admin, , , carol, , , , , dave] = s;
    await ex.setFees(5, 1, 50, 5000, 10000, 1n); // close factor 100%: liquidation closes the whole position
    await ex.connect(carol).deposit(carol.address, 0, usd(4000));
    await ex.connect(dave).deposit(dave.address, 0, usd(100_000));
    await ex.connect(dave).placeOrder(dave.address, 0, ord({ market: 1, isBuy: false, price: px(3000), size: sz(10) }));
    await ex.connect(carol).placeOrder(carol.address, 0, ord({ market: 1, isBuy: true, price: px(3000), size: sz(10), tif: TIF.IOC }));
    await ex.connect(dave).cancelAll(dave.address, 0);
    await oracle.set(d.feeds.eth, px(1500)); // carol: -15,000 on 4,000 margin
    console.log("ETH oracle gapped 3000 -> 1500: carol insolvent");
  },

  async "assert-adl"() {
    const { d, ex } = await load();
    const c = await ex.acctKey(d.carol, 0), dv = await ex.acctKey(d.dave, 0);
    await waitFor("carol liquidated with bad debt", async () => (await ex.adlDebt(1)) > 0n || (await ex.positions(c, 1)).size === 0n, 40);
    await waitFor("keeper ADL'd dave (short 10 ETH, in profit) against the backstop", async () => (await ex.queryFilter("AdlExecuted")).length >= 1, 40);
    const ev = await ex.queryFilter("AdlExecuted");
    assert(ev[0].args.target === dv, "ADL target is dave's account");
    assert((await ex.positions(dv, 1)).size > -sz(10), `dave's short reduced (${await ex.positions(dv, 1).then((p) => p.size)})`);
  },
};

(async () => {
  const f = phases[process.env.E2E_PHASE];
  if (!f) fail("unknown E2E_PHASE " + process.env.E2E_PHASE);
  await f();
})().catch((e) => { console.error(e); process.exit(1); });
