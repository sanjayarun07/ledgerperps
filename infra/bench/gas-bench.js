// Real gas measurement harness (in-process Hardhat network). NOT a latency or throughput benchmark.
// Run:  cd contracts && npx hardhat run ../infra/bench/gas-bench.js     (or: make bench)
// Each scenario runs from a fresh evm_snapshot so numbers are independent of order. Gas = receipt.gasUsed.
const path = require("path");
const { createRequire } = require("module");
const contractsDir = process.env.PERPS_CONTRACTS_DIR || path.resolve(process.cwd());
const req = createRequire(path.join(contractsDir, "package.json"));
const hre = req("hardhat");
const { ethers } = hre;
const { deploy, usd, btc, TIF, order, FEED } = req(path.join(contractsDir, "test/helpers.js"));
const px = (x) => BigInt(Math.round(x * 1e6));
const fs = require("fs");

async function fresh() {
  // wider freshness window than the unit-test fixture so scenarios need no oracle refresh between steps
  const e = await deploy();
  const extra = (await ethers.getSigners()).slice(8);
  for (const s of extra) {
    await e.usdc.mint(s.address, usd(1_000_000));
    await e.usdc.connect(s).approve(await e.ex.getAddress(), ethers.MaxUint256);
  }
  e.extra = extra;
  return e;
}
const gas = async (txp) => (await (await txp).wait()).gasUsed;
const refresh = (e, p = 50000) => e.oracle.set(FEED, px(p));
const results = [];
const rec = (name, note, g) => { results.push({ name, note, gas: g.toString() }); console.log(name.padEnd(46), g.toString().padStart(10), " ", note); };

async function scenario(fn) {
  const snap = await hre.network.provider.send("evm_snapshot");
  try { await fn(); } finally { await hre.network.provider.send("evm_revert", [snap]); }
}

async function main() {
  const e = await fresh();
  const { ex, alice, bob, carol, keeper, oracle, key } = e;
  for (const s of [alice, bob, carol]) await ex.connect(s).deposit(s.address, 0, usd(100_000));
  for (const s of e.extra) await ex.connect(s).deposit(s.address, 0, usd(100_000));
  const sell = (price, size) => order({ isBuy: false, price: px(price), size: btc(size) });

  await scenario(async () => {
    await refresh(e);
    rec("resting order, new price level", "GTC sell, empty book", await gas(ex.connect(alice).placeOrder(alice.address, 0, sell(50000, 1))));
    await refresh(e);
    rec("resting order, existing price level", "second order same level", await gas(ex.connect(alice).placeOrder(alice.address, 0, sell(50000, 1))));
    await refresh(e);
    rec("cancel (single resting order)", "cancelOrder(id=1)", await gas(ex.connect(alice).cancelOrder(1)));
  });

  await scenario(async () => {
    await refresh(e);
    await ex.connect(alice).placeOrder(alice.address, 0, sell(50000, 1));
    await refresh(e);
    rec("single fill, taker opens first position", "IOC buy 0.1 vs 1 maker", await gas(ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.1), tif: TIF.IOC }))));
  });

  // N-fill: N distinct maker orders at one level, spread across makers (32 open orders / account cap)
  const makers = [alice, bob, carol, ...e.extra.slice(0, 4)].filter((s) => s !== keeper);
  for (const N of [1, 5, 10, 20, 40]) {
    await scenario(async () => {
      const taker = e.extra[e.extra.length - 1];
      await refresh(e);
      for (let i = 0; i < N; i++) {
        if (i % 10 === 0) await refresh(e);
        const m = makers[i % 4];
        await ex.connect(m).placeOrder(m.address, 0, sell(50000, 0.01));
      }
      await refresh(e);
      const tx = await ex.connect(taker).placeOrder(taker.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.01 * N), tif: TIF.IOC }));
      const r = await tx.wait();
      const fills = r.logs.filter((l) => { try { return ex.interface.parseLog(l)?.name === "Fill"; } catch { return false; } }).length;
      rec(`taker, N=${N} fills (distinct makers' orders)`, `${fills} Fill events; ${(Number(r.gasUsed) / Math.max(fills, 1)).toFixed(0)} gas/fill`, r.gasUsed);
    });
  }

  await scenario(async () => {
    // alice 1 BTC long at 6000 collateral (see test "liquidation"), price falls to 45.5k
    await ex.connect(alice).withdraw(0, usd(100_000 - 6000)).catch(() => {});
    await refresh(e);
    await ex.connect(bob).placeOrder(bob.address, 0, sell(50000, 1));
    await refresh(e);
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(1), tif: TIF.IOC }));
    await ex.connect(bob).cancelAll(bob.address, 0);
    await oracle.set(FEED, px(45500));
    const a = await key(alice);
    rec("liquidate (partial, to backstop)", "1 BTC long, 6000 collateral, mark 45.5k", await gas(ex.connect(keeper).liquidate(a, 0)));
  });

  await scenario(async () => {
    await hre.network.provider.send("evm_increaseTime", [3600]);
    await hre.network.provider.send("evm_mine");
    await refresh(e);
    rec("pokeFunding (one interval elapsed)", "no positions, empty book", await gas(ex.connect(keeper).pokeFunding(0)));
  });

  console.log("\nMeasured on", process.platform, process.arch, "node", process.version, "hardhat", hre.version, "(in-process EVM, cancun, optimizer runs=200, viaIR)");
  const out = process.env.BENCH_OUT || path.resolve(contractsDir, "../infra/bench/last-run.json");
  fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), hardhat: hre.version, node: process.version, results }, null, 2));
  console.log("wrote", out);
}
main().catch((err) => { console.error(err); process.exit(1); });
