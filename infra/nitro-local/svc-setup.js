// Chain-side driver for running the keeper / indexer binaries against Nitro (their stock e2e.sh need hardhat-only RPCs: evm_snapshot,
// evm_increaseTime, hardhat_setCode). Phases: fund | trade | crash | truth.   Throwaway keys are derived from fixed labels (test only).
// Run: cd contracts && SVC_PHASE=trade npx hardhat --config hardhat.nitro.config.js run ../infra/nitro-local/svc-setup.js --network nitroLocal
const { ethers } = require("hardhat");
const fs = require("fs"), path = require("path");
const d = require("../../contracts/deployments/nitroLocal.json");
const abi = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../contracts/abi/PerpExchange.merged.json"), "utf8"));
const p = ethers.provider;
const key = (label) => ethers.keccak256(ethers.toUtf8Bytes("nitro-local-throwaway:" + label));
const W = (label) => new ethers.Wallet(key(label), p);
const usd = (n) => BigInt(Math.round(n * 1e6)), px = usd, sz = (x) => BigInt(Math.round(x * 1e8));
const ord = (o) => ({ market: 0, isBuy: o.isBuy, price: o.price, size: o.size, tif: o.tif ?? 0, reduceOnly: false, cloid: 0n, expiry: 0n });
async function main() {
  const phase = process.env.SVC_PHASE;
  const [admin] = await ethers.getSigners();
  const alice = W("alice"), bob = W("bob"), keeper = W("keeper");
  const ex = new ethers.Contract(d.exchange, abi, admin);
  const usdc = await ethers.getContractAt("MockUSDC", d.usdc), oracle = await ethers.getContractAt("ManualOracle", d.oracle);
  const g = { gasLimit: 3_000_000 }; // explicit limit: avoid estimate-vs-timestamp underestimation on Nitro
  if (phase === "fund") {
    for (const w of [alice, bob, keeper]) await (await admin.sendTransaction({ to: w.address, value: ethers.parseEther("1") })).wait();
    for (const w of [alice, bob]) { await (await usdc.mint(w.address, usd(1_000_000))).wait(); await (await usdc.connect(w).approve(d.exchange, ethers.MaxUint256)).wait(); }
    console.log("keeper address", keeper.address, "| keeper key (throwaway):", key("keeper"), "| head", await p.getBlockNumber());
  } else if (phase === "trade") {
    await (await oracle.set(d.feeds["BTC-USD"], px(50000), g)).wait();
    await (await ex.connect(alice).deposit(alice.address, 0, usd(6000), g)).wait();
    await (await ex.connect(bob).deposit(bob.address, 0, usd(100_000), g)).wait();
    await (await ex.connect(bob).placeOrder(bob.address, 0, ord({ isBuy: false, price: px(50000), size: sz(1) }), g)).wait();
    await (await ex.connect(alice).placeOrder(alice.address, 0, ord({ isBuy: true, price: px(50000), size: sz(1), tif: 1 }), g)).wait();
    await (await ex.connect(bob).cancelAll(bob.address, 0, g)).wait();
    const a = await ex.acctKey(alice.address, 0);
    console.log("alice position", (await ex.positions(a, 0)).toString(), "head", await p.getBlockNumber());
  } else if (phase === "crash") {
    await (await oracle.set(d.feeds["BTC-USD"], px(45500), g)).wait();
    console.log("BTC oracle -> 45500 at block", await p.getBlockNumber());
  } else if (phase === "truth") {
    const a = await ex.acctKey(alice.address, 0);
    console.log("alice position after:", (await ex.positions(a, 0)).toString());
    const liq = await ex.queryFilter(ex.filters.Liquidated(), 0, "latest");
    for (const l of liq) console.log("Liquidated: block", l.blockNumber, "keeper", l.args.keeper, "size", l.args.size.toString(), "price", l.args.price.toString(), "fee", l.args.fee.toString());
    const fills = await ex.queryFilter(ex.filters.Fill(), 0, "latest");
    console.log("Fill events on chain:", fills.length, "| head", await p.getBlockNumber(), "| alice acct", a);
    console.log("keeper expected address:", keeper.address, "(matches liquidator:", liq.length > 0 && liq[liq.length - 1].args.keeper === keeper.address, ")");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
