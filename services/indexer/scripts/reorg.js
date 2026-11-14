// E2E reorg scenario: snapshot -> branch A trades (indexer sees them) -> evm_revert (real chain reorg) -> branch B trades.
// Run with the same hardhat command as scenario.js. Needs API (indexer base url) in env.
const path = require("path");
const fs = require("fs");
const CONTRACTS = process.env.CONTRACTS_DIR || path.resolve(__dirname, "../../../contracts");
const hre = require(path.join(CONTRACTS, "node_modules/hardhat"));
const { ethers } = hre;
const usd = (n) => BigInt(Math.round(n * 1e6));
const btc = (x) => BigInt(Math.round(x * 1e8));
const ord = (o) => ({ market: 2, isBuy: o.isBuy, price: o.price, size: o.size, tif: o.tif ?? 0, reduceOnly: false, cloid: 0n, expiry: 0n });
const API = process.env.API;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p) { const r = await fetch(API + p); return r.json(); }
async function synced() {
  for (let i = 0; i < 200; i++) {
    const s = (await api("/v1/status")).data;
    const head = await ethers.provider.getBlockNumber();
    if (s.indexed_head && s.indexed_head.number === head) return head;
    await sleep(100);
  }
  throw new Error("indexer did not catch up");
}
async function main() {
  const dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT, "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "abi/PerpExchange.merged.json"), "utf8"));
  const [admin, alice, bob, carol, dave] = await ethers.getSigners();
  const ex = new ethers.Contract(dep.exchange, abi, admin);
  const place = (s, o) => ex.connect(s).placeOrder(s.address, 0, ord(o));
  await synced();
  const snap = await ethers.provider.send("evm_snapshot", []);
  const base = (await api("/v1/markets/2/trades")).data.length;
  // ---- branch A: bob sells 5 SOL, dave buys 3 SOL
  await place(bob, { isBuy: false, price: usd(150), size: btc(5) });
  await place(dave, { isBuy: true, price: usd(150), size: btc(3), tif: 1 });
  const headA = await synced();
  const a = (await api("/v1/markets/2/trades")).data;
  console.log(`branch A indexed: head=${headA} sol_trades=${a.length} (base ${base}) size=${a[0] && a[0].size}`);
  if (a.length !== base + 1 || a[0].size !== btc(3).toString()) throw new Error("branch A not indexed as expected");
  // ---- REORG: drop branch A, mine a different branch B (different sizes/timestamps => different block hashes)
  await ethers.provider.send("evm_revert", [snap]);
  await ethers.provider.send("evm_increaseTime", [7]);
  await place(bob, { isBuy: false, price: usd(150), size: btc(4) });
  await place(dave, { isBuy: true, price: usd(150), size: btc(2), tif: 1 });
  await place(carol, { isBuy: false, price: usd(151), size: btc(1) }).catch(() => {});
  const headB = await synced();
  const b = (await api("/v1/markets/2/trades")).data;
  console.log(`branch B indexed: head=${headB} sol_trades=${b.length} size=${b[0] && b[0].size}`);
  if (b.length !== base + 1 || b[0].size !== btc(2).toString()) throw new Error("reorg not applied: branch A still visible");
  const m = await (await fetch(API + "/metrics")).text();
  const re = /indexer_reorgs_total (\d+)/.exec(m);
  console.log(`indexer_reorgs_total=${re && re[1]}`);
  if (!re || Number(re[1]) < 1) throw new Error("reorg metric not incremented");
}
main().catch((e) => { console.error(e); process.exit(1); });
