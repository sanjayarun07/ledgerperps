// Reduced e2e on a live Nitro chain: deposit, rest, partial fill, funding poke, liquidation, withdraw. Reports gas per op,
// split into L2 execution vs L1-data component (receipt.gasUsedForL1), next to docs/BENCHMARKS.md hardhat numbers.
// Run: cd contracts && npx hardhat --config hardhat.nitro.config.js run ../infra/nitro-local/smoke.js --network nitroLocal
// Uses a FRESH deployment each run (own mock USDC/oracle/exchange), random throw-away wallets funded from the PUBLIC testnode dev key.
const { ethers } = require("hardhat");
const fs = require("fs"), path = require("path");
const { deployExchange, usd, btc, TIF, order } = require("../../contracts/test/helpers.js");
const px = (x) => BigInt(Math.round(x * 1e6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HH = { "deposit": null, "resting order, new price level": 303300, "resting order, existing price level": 234404, "cancel (single resting order)": 80720,
  "single fill (taker opens first position)": 291275, "liquidate (partial, to backstop)": 215453, "pokeFunding (one interval elapsed, no positions)": 104900 };
const rows = [];
const p = ethers.provider;

async function send(name, txp) {
  const t0 = Date.now(); const tx = await txp; const t1 = Date.now(); const r = await tx.wait(); const t2 = Date.now();
  const raw = await p.send("eth_getTransactionReceipt", [tx.hash]);
  const blk = await p.getBlock(r.blockNumber);
  const total = Number(r.gasUsed), l1 = Number(BigInt(raw.gasUsedForL1 || "0x0"));
  rows.push({ name, gasUsedTotal: total, gasUsedForL1: l1, l2Execution: total - l1, hardhat: HH[name] ?? null, hash: tx.hash, calldataBytes: (tx.data.length - 2) / 2, block: r.blockNumber,
    blockTs: blk.timestamp, wallMs: t2 - t0, submitMs: t1 - t0, effectiveGasPrice: r.gasPrice?.toString(), status: r.status });
  console.log(name.padEnd(48), String(total).padStart(9), "L1:", String(l1).padStart(8), "L2exec:", String(total - l1).padStart(9), "hardhat:", HH[name] ?? "-", `| ${t2 - t0}ms`);
  return r;
}

async function main() {
  const [admin] = await ethers.getSigners();
  const mk = () => ethers.Wallet.createRandom().connect(p);
  const [alice, bob, keeper] = [mk(), mk(), mk()];
  for (const w of [alice, bob, keeper]) await (await admin.sendTransaction({ to: w.address, value: ethers.parseEther("1") })).wait();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const oracle = await (await ethers.getContractFactory("ManualOracle")).deploy();
  const ex = await deployExchange(await usdc.getAddress(), await oracle.getAddress(), admin);
  const FEED0 = ethers.id("SMOKE-BTC-0"), FEED1 = ethers.id("SMOKE-BTC-1-emptyfunding");
  await oracle.set(FEED0, px(50000)); await oracle.set(FEED1, px(50000));
  const MAX = (1n << 128n) - 1n;
  const tiers = [{ upToNotional: usd(100_000), imrBps: 1000, mmrBps: 500 }, { upToNotional: usd(1_000_000), imrBps: 2000, mmrBps: 1000 }, { upToNotional: MAX, imrBps: 5000, mmrBps: 2500 }];
  const cfg = (feed, fundingInterval) => ({ feed, tick: 100_000n, lot: 10_000n, minNotional: usd(10), maxOrderSize: btc(100), maxOI: btc(1000),
    maxAge: 60, bandBps: 500, maxSpreadBps: 100, fundingInterval, premiumDivisor: 8, fundingCap: 400_000_000n });
  await ex.createMarket(cfg(FEED0, 3600), tiers);  // market 0: same as the hardhat fixture
  await ex.createMarket(cfg(FEED1, 20), tiers);    // market 1: 20 s funding interval so pokeFunding can be measured in real time (cannot time-travel on Nitro)
  for (const w of [alice, bob, keeper]) {
    await (await usdc.mint(w.address, usd(1_000_000))).wait();
    await (await usdc.connect(w).approve(await ex.getAddress(), ethers.MaxUint256)).wait();
  }
  const refresh = async (f = FEED0, price = 50000) => (await oracle.set(f, px(price), { gasLimit: 150_000 })).wait(); // explicit gasLimit: eth_estimateGas under-estimates a same-price refresh (see README)
  const E = (w) => ex.connect(w);
  const sell = (price, size) => order({ isBuy: false, price: px(price), size: btc(size) });

  await send("deposit", E(alice).deposit(alice.address, 0, usd(6000)));
  await send("deposit (bob)", E(bob).deposit(bob.address, 0, usd(100_000)));
  await send("deposit (keeper)", E(keeper).deposit(keeper.address, 0, usd(1000)));

  await refresh();
  await send("resting order, new price level", E(bob).placeOrder(bob.address, 0, sell(50000, 1)));
  await refresh();
  await send("resting order, existing price level", E(bob).placeOrder(bob.address, 0, sell(50000, 1)));
  await refresh();
  const r3 = await send("resting order (3rd, to cancel)", E(bob).placeOrder(bob.address, 0, sell(50000, 0.5)));
  const accepted = r3.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "OrderAccepted");
  await send("cancel (single resting order)", E(bob).cancelOrder(accepted.args.id));
  await refresh();
  const fillR = await send("single fill (taker opens first position)", E(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.1), tif: TIF.IOC })));
  const fills = (rc) => rc.logs.filter((l) => { try { return ex.interface.parseLog(l)?.name === "Fill"; } catch { return false; } }).length;
  console.log("  partial fill: Fill events =", fills(fillR), "(maker order 1 now partially filled: 0.9 of 1.0 BTC remaining)");
  await refresh();
  await send("second fill (taker adds 0.9 BTC -> 1 BTC long)", E(alice).placeOrder(alice.address, 0, order({ isBuy: true, price: px(50000), size: btc(0.9), tif: TIF.IOC })));

  // funding poke on the empty 20 s market (comparable to hardhat), after real waiting
  console.log("waiting 22 s of real time for market 1 funding interval...");
  await sleep(22000);
  await refresh(FEED1);
  await send("pokeFunding (one interval elapsed, no positions)", E(keeper).pokeFunding(1));
  await refresh(FEED0);
  let fundingNote = "pokeFunding on market 0 (3600 s interval) with open interest: not measured (cannot advance time on Nitro)";
  // (a pokeFunding before the interval elapses is a no-op, so it is not a meaningful measurement either)
  console.log(fundingNote);

  await E(bob).cancelAll(bob.address, 0).then((t) => t.wait());
  await oracle.set(FEED0, px(45500), { gasLimit: 150_000 }).then((t) => t.wait());
  const a = await ex.acctKey(alice.address, 0);
  const liq = await send("liquidate (partial, to backstop)", E(keeper).liquidate(a, 0));
  const lg = liq.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Liquidated");
  console.log("  Liquidated event:", lg ? { size: lg.args.size.toString(), price: lg.args.price.toString(), fee: lg.args.fee.toString(), badDebt: lg.args.badDebt.toString() } : "MISSING");

  const before = await usdc.balanceOf(keeper.address);
  await send("withdraw (keeper, no position)", E(keeper).withdraw(0, usd(500)));
  const after = await usdc.balanceOf(keeper.address);
  console.log("  withdraw balance delta (6dp):", (after - before).toString());


  // --- backstop PHASE 2 (round 3): cfg, poke, auction view, take, forced unwind. Real-time waits (no time travel on Nitro). ---
  console.log("backstop phase 2: cfg soft 1 USDC, maxDisc 300 bps, dwell 0, ramp 60, maxAge 60");
  await send("setBackstopCfg", ex.setBackstopCfg(0, usd(1), 300, 0, 60, 60));
  await refresh(FEED0, 45500);
  await send("pokeBackstop (starts the elevation clock)", E(keeper).pokeBackstop(0));
  await send("pokeBackstop (no-op, already elevated)", E(keeper).pokeBackstop(0));
  const auctionGas = await ex.backstopAuction.estimateGas(0);
  console.log("backstopAuction(0) view estimateGas".padEnd(48), String(auctionGas), "| result", (await ex.backstopAuction(0)).map(String).join(","));
  rows.push({ name: "backstopAuction (view, estimateGas)", gasUsedTotal: Number(auctionGas), gasUsedForL1: 0, l2Execution: Number(auctionGas), hardhat: null });
  console.log("waiting 62 s of real time for maxAge...");
  await sleep(62000);
  await refresh(FEED0, 45500);
  await send("takeBackstop (partial, keeper takes 0.01)", E(keeper).takeBackstop(keeper.address, 0, 0, btc(0.01), px(60000)));
  const bobKey = await ex.acctKey(bob.address, 0);
  await send("unwindBackstop (1 target)", E(keeper).unwindBackstop([bobKey], 0));
  await send("setBackstopCfg (off)", ex.setBackstopCfg(0, 0, 0, 0, 60, 60));
  const p2 = true;

  const out = { date: new Date().toISOString(), chainId: Number((await p.getNetwork()).chainId), exchange: await ex.getAddress(), rows, notes: [fundingNote] };
  fs.writeFileSync(path.resolve(__dirname, "smoke-last-run.json"), JSON.stringify(out, null, 2));
  console.log("wrote infra/nitro-local/smoke-last-run.json");
  if (!lg || fills(fillR) < 1) { console.error("SMOKE FAILED: expected fill + liquidation"); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
