// E2E: a reorg DEEPER than --reorg-window (the e2e runs the indexer with a small window). The indexer must walk the
// stored hash chain past the window, re-anchor, raise the operator alert and end up identical to a fresh re-index.
const path = require("path");
const fs = require("fs");
const CONTRACTS = process.env.CONTRACTS_DIR || path.resolve(__dirname, "../../../contracts");
const hre = require(path.join(CONTRACTS, "node_modules/hardhat"));
const { ethers } = hre;
const usd = (n) => BigInt(Math.round(n * 1e6));
const btc = (x) => BigInt(Math.round(x * 1e8));
const API = process.env.API;
const DEPTH = Number(process.env.DEEP_DEPTH || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p) => (await fetch(API + p)).json();
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  PASS", m); };
async function synced() {
  for (let i = 0; i < 300; i++) {
    const s = (await api("/v1/status")).data, head = await ethers.provider.getBlockNumber();
    if (s.indexed_head && s.indexed_head.number === head) return head;
    await sleep(100);
  }
  throw new Error("indexer did not catch up");
}
async function main() {
  const dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT, "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "abi/PerpExchange.merged.json"), "utf8"));
  const [admin, , bob] = await ethers.getSigners();
  const ex = new ethers.Contract(dep.exchange, abi, admin);
  const sell = (size) => ex.connect(bob).placeOrder(bob.address, 0, { market: 2, isBuy: false, price: usd(160), size, tif: 0, reduceOnly: false, cloid: 0n, expiry: 0n });
  const bobKey = await ex.acctKey(bob.address, 0);
  const open = async () => (await api(`/v1/accounts/${bobKey}/orders?status=open&market=2`)).data.map((o) => o.size);
  await synced();
  const before = await open();
  const snap = await ethers.provider.send("evm_snapshot", []);
  // ---- branch A: one order, then DEPTH empty blocks on top of it
  await sell(btc(1));
  // NB: not hardhat_mine - hardhat writes a zero parentHash into bulk-mined blocks, which no hash-linked indexer can follow
  for (let i = 0; i < DEPTH; i++) await ethers.provider.send("evm_mine", []);
  const headA = await synced();
  const a = await open();
  ok(a.length === before.length + 1 && a.includes(btc(1).toString()), `branch A indexed (head ${headA}, +1 open order of 1 SOL)`);
  // ---- REORG of DEPTH+1 blocks (> window): different order, different timestamps, fewer blocks
  await ethers.provider.send("evm_revert", [snap]);
  await ethers.provider.send("evm_increaseTime", [13]);
  await sell(btc(2));
  for (let i = 0; i < 3; i++) await ethers.provider.send("evm_mine", []);
  const headB = await synced();
  const b = await open();
  ok(b.length === before.length + 1 && b.includes(btc(2).toString()) && !b.includes(btc(1).toString()), `branch B visible, branch A gone (head ${headB} < ${headA})`);
  const m = await (await fetch(API + "/metrics")).text();
  const deep = Number(/indexer_deep_reorgs_total (\d+)/.exec(m)[1]);
  ok(deep >= 1, `indexer_deep_reorgs_total=${deep} (reorg of ${DEPTH + 1} blocks exceeded the window)`);
  ok(/indexer_alert_active 1/.test(m) && /indexer_halted 0/.test(m), "operator alert metric set, indexing NOT halted");
  const st = (await api("/v1/status")).data;
  ok(typeof st.alert === "string" && st.alert.includes("deep reorg") && st.halted === null, `/v1/status.alert: ${st.alert}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
