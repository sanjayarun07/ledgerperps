// E2E: reverted-transaction visibility via the opt-in tx tracker. Reverted txs emit NO contract events, so only the
// receipt tracker (POST /v1/tx/track) can show them. Needs API (indexer base url) and DEPLOYMENT in env.
const path = require("path");
const fs = require("fs");
const CONTRACTS = process.env.CONTRACTS_DIR || path.resolve(__dirname, "../../../contracts");
const hre = require(path.join(CONTRACTS, "node_modules/hardhat"));
const { ethers } = hre;
const API = process.env.API;
const usd = (n) => BigInt(Math.round(n * 1e6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, init) => { const r = await fetch(API + p, init); return { status: r.status, body: await r.json().catch(() => null) }; };
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  PASS", m); };

async function main() {
  const dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT, "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "abi/PerpExchange.merged.json"), "utf8"));
  const [, alice] = await ethers.getSigners();
  const ex = new ethers.Contract(dep.exchange, abi, alice);
  const acct = await ex.acctKey(alice.address, 0);
  const withdrawsBefore = (await j(`/v1/accounts/${acct}/transfers?kind=withdraw`)).body.data.length;

  // automine off => the node accepts the tx, mines it later with receipt.status = 0 (no exception at submit time)
  await ethers.provider.send("evm_setAutomine", [false]);
  const bad = await ex.withdraw(0, usd(10 ** 9), { gasLimit: 400000 });            // far more than alice's collateral => reverts
  const good = await ex.withdraw(0, usd(1), { gasLimit: 400000 });                  // succeeds (emits Withdraw)
  const ghost = "0x" + "ab".repeat(32);                                             // never submitted
  for (const h of [bad.hash, good.hash, ghost]) {
    const r = await j("/v1/tx/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hash: h }) });
    ok(r.status === 200 && r.body.data.status === "pending", `tracking ${h.slice(0, 10)} accepted as pending`);
  }
  await ethers.provider.send("evm_mine", []);
  await ethers.provider.send("evm_setAutomine", [true]);
  const rb = await ethers.provider.getTransactionReceipt(bad.hash), rg = await ethers.provider.getTransactionReceipt(good.hash);
  ok(rb.status === 0 && rg.status === 1, "chain receipts: first tx reverted, second succeeded");
  let st = {};
  for (let i = 0; i < 100; i++) {
    for (const [k, h] of [["bad", bad.hash], ["good", good.hash]]) st[k] = (await j(`/v1/tx/${h}`)).body.data;
    if (st.bad.status !== "pending" && st.good.status !== "pending") break;
    await sleep(200);
  }
  ok(st.bad.status === "reverted" && st.bad.block_number === rb.blockNumber && st.bad.gas_used === rb.gasUsed.toString(), `reverted tx visible via tracker (block ${st.bad.block_number}, gas ${st.bad.gas_used})`);
  ok(st.good.status === "success" && st.good.block_number === rg.blockNumber, "successful tx tracked as success");
  // the ghost is still pending (the timeout is 10 minutes by default) and an untracked hash is a clean 404
  ok((await j(`/v1/tx/${ghost}`)).body.data.status === "pending", "unknown tx stays pending until the timeout");
  ok((await j(`/v1/tx/0x${"cd".repeat(32)}`)).status === 404, "untracked tx => 404");
  ok((await j("/v1/tx/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hash: "0x12" }) })).status === 400, "malformed hash => 400");
  // the event-derived endpoints know nothing about the reverted tx: exactly one new withdraw (the successful one)
  for (let i = 0; i < 100; i++) { const s = (await j("/v1/status")).body.data; if (s.indexed_head && s.indexed_head.number === (await ethers.provider.getBlockNumber())) break; await sleep(100); }
  const withdrawsAfter = (await j(`/v1/accounts/${acct}/transfers?kind=withdraw`)).body.data.length;
  ok(withdrawsAfter === withdrawsBefore + 1, `reverted tx emitted no event: withdraws ${withdrawsBefore} -> ${withdrawsAfter} (+1 for the successful tx only)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
