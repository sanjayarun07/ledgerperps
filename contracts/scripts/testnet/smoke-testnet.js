// Post-deploy smoke test. DRY-RUN (read-only checks + plan) unless CONFIRM_TESTNET_SMOKE=yes on chainId 421614.
// Keys: DEPLOYER_PRIVATE_KEY (trader 1) and optional TRADER2_PRIVATE_KEY. Without TRADER2 the counterparty is sub-account 1 of trader 1.
// Env: SMOKE_MARKET (default 0=BTC-USD), SMOKE_DEPOSIT_USDC (default 5), SMOKE_PUSH_PYTH=yes (push Hermes update first; needs CONFIRM_PYTH_PUSH semantics = same gate)
// Output: infra/testnet/smoke-last-run.json (no secrets). Steps are independent where possible; first failing precondition aborts the trading steps.
const fs = require("fs"); const path = require("path");
const { ethers, ctx, mergedAbi, loadDeployment } = require("./common");
const L = require("./lib");
const P = require("./pyth");
const OUT = path.join(__dirname, "..", "..", "..", "infra", "testnet", "smoke-last-run.json");
const TIF = { GTC: 0, IOC: 1 };

async function main() {
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  return run({ d: loadDeployment(), chainId, signers, gate: L.broadcastGate("CONFIRM_TESTNET_SMOKE", chainId), out: OUT, checkDeployer: true });
}
// Exported so tests/local-e2e.js can drive the same logic on the in-process chain (never used for real networks).
async function run({ d, chainId, signers, gate, out, checkDeployer }) {
  const cfg = L.loadConfig();
  const live = gate.ok;
  const stages = []; let aborted = null;
  const mid = Number(process.env.SMOKE_MARKET || 0); const mk = cfg.markets[mid]; const feed = mk.feedId;
  const depositUsdc = BigInt(Math.round(Number(process.env.SMOKE_DEPOSIT_USDC || 5) * 1e6));
  console.log(live ? "MODE: LIVE smoke (sends real testnet transactions)" : `MODE: DRY-RUN (read-only; ${gate.reason})`);

  let t1 = null, t2 = null;
  if (live) {
    t1 = L.requireSigner(signers, "smoke test"); if (checkDeployer) L.assertDeployerMatch(t1.address, L.expectedDeployer(cfg));
    const k2 = L.normalizeKey(process.env.TRADER2_PRIVATE_KEY);
    if (process.env.TRADER2_PRIVATE_KEY && !k2.ok) throw new Error("TRADER2_PRIVATE_KEY malformed: " + k2.reason);
    t2 = k2.ok ? new ethers.Wallet(k2.key, ethers.provider) : null;
  }
  const abi = await mergedAbi();
  const ex = new ethers.Contract(d.exchange, abi, ethers.provider);
  const usdc = new ethers.Contract(d.usdc, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function mint(address,uint256)"], ethers.provider);
  const oracleC = new ethers.Contract(await ex.oracle(), ["function latest(bytes32) view returns (uint256,uint256)"], ethers.provider);

  async function stage(name, fn) {
    if (aborted) { stages.push({ name, status: "skipped", reason: aborted }); return null; }
    const s = { name, status: "ok" }; const t0 = Date.now();
    try { const r = await fn(s); s.totalMs = Date.now() - t0; stages.push(s); return r; }
    catch (e) { s.status = "FAIL"; s.error = L.redact(String(e.shortMessage || e.message).slice(0, 300), [process.env.DEPLOYER_PRIVATE_KEY, process.env.TRADER2_PRIVATE_KEY, process.env.ARB_SEPOLIA_RPC_URL]); s.totalMs = Date.now() - t0; stages.push(s); aborted = `earlier stage failed: ${name}`; return null; }
  }
  // send a tx and record submit latency (signing->hash), mined latency (hash->receipt), gas
  async function send(s, txPromiseFn) {
    const a = Date.now(); const tx = await txPromiseFn(); const b = Date.now(); const rc = await tx.wait(1); const c = Date.now();
    Object.assign(s, { hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), effGasPriceWei: rc.gasPrice?.toString(), submitMs: b - a, minedMs: c - b, confirmations: 1 });
    return rc;
  }
  const evs = (rc, name) => rc.logs.filter((l) => l.address.toLowerCase() === d.exchange.toLowerCase()).map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);

  const who1 = t1 ? t1.address : L.expectedDeployer(cfg); const who2 = t2 ? t2.address : who1; const sub2 = t2 ? 0 : 1;
  console.log(`trader1=${who1} sub0 | trader2=${who2} sub${sub2}${t2 ? "" : " (same wallet, sub-account)"}`);

  // read-only preflight
  let px = 0n;
  await stage("preflight: modules unlocked/locked, markets, balances", async (s) => {
    s.modulesLocked = await ex.modulesLocked(); s.marketCount = Number(await ex.marketCount());
    s.usdcBalTrader1 = (await usdc.balanceOf(who1)).toString(); s.ethBalTrader1 = (await ethers.provider.getBalance(who1)).toString();
    if (BigInt(s.usdcBalTrader1) < depositUsdc && live) throw new Error(`trader1 USDC ${s.usdcBalTrader1} < ${depositUsdc}; faucet: ${cfg.usdc.faucet}`);
  });
  if (live && process.env.SMOKE_PUSH_PYTH === "yes") await stage("pyth: push Hermes update", async (s) => { const { updates } = await P.fetchUpdates(cfg); await send(s, async () => { const p = new ethers.Contract(cfg.pyth.address, ["function getUpdateFee(bytes[]) view returns (uint256)", "function updatePriceFeeds(bytes[]) payable"], t1); const fee = await p.getUpdateFee(updates); return p.updatePriceFeeds(updates, { value: fee }); }); });
  await stage("oracle read (router.oracle().latest(feed))", async (s) => {
    const [p, t] = await oracleC.latest(feed); px = p; const blk = await ethers.provider.getBlock("latest");
    s.price1e6 = p.toString(); s.updatedAt = Number(t); s.ageSecs = blk.timestamp - Number(t);
  });
  if (!px && !aborted) aborted = "oracle read failed (Pyth stale? run push-pyth.js with CONFIRM_PYTH_PUSH=yes or set SMOKE_PUSH_PYTH=yes)";
  if (live && !px) throw new Error("smoke cannot continue: " + (stages.find((x) => x.status === "FAIL")?.error || "price is 0") + " (not sending any transaction)");
  if (!live) {
    console.log("\nPlan (live): approve -> deposit x2 -> place+cancel resting bid -> cross (maker bid / taker IOC ask) -> close -> pokeFunding -> accountState -> withdraw 1 USDC");
    console.log(JSON.stringify(stages, null, 1)); console.log("\nDRY-RUN: nothing sent, smoke-last-run.json not overwritten."); return;
  }
  const p0 = BigInt(mk.params.tick); const lot = BigInt(mk.params.lot);
  const price = (px / p0) * p0;
  const minNot = BigInt(mk.params.minNotional);
  let size = ((minNot * 12n / 10n * 10n ** 8n) / price / lot + 1n) * lot; // ~1.2x min notional, lot-aligned
  console.log(`market ${mk.name} px=${Number(px) / 1e6} order px=${Number(price) / 1e6} size=${size} (1e8 units)`);
  const OP = (isBuy, tif, ro = false, pr = price, cloid = 0n) => ({ market: mid, isBuy, price: pr, size, tif, reduceOnly: ro, cloid, expiry: 0 });

  const signer1 = t1, signer2 = t2 || t1;
  await stage("approve USDC (trader1)", async (s) => { if ((await usdc.allowance(who1, d.exchange)) >= depositUsdc * 2n) { s.note = "allowance sufficient"; return; } await send(s, () => usdc.connect(t1).approve(d.exchange, ethers.MaxUint256)); });
  if (t2) await stage("approve USDC (trader2)", async (s) => { if ((await usdc.allowance(who2, d.exchange)) >= depositUsdc) { s.note = "allowance sufficient"; return; } await send(s, () => usdc.connect(t2).approve(d.exchange, ethers.MaxUint256)); });
  await stage("deposit trader1 sub0", (s) => send(s, () => ex.connect(t1).deposit(who1, 0, depositUsdc)));
  await stage(`deposit trader2 sub${sub2}`, (s) => send(s, () => ex.connect(signer2).deposit(who2, sub2, depositUsdc)));
  let oid = null;
  await stage("place resting bid (GTC, 50 ticks below mid)", async (s) => { const rc = await send(s, () => ex.connect(t1).placeOrder(who1, 0, OP(true, TIF.GTC, false, price - 50n * p0))); oid = evs(rc, "OrderRested")[0]?.args.id ?? evs(rc, "OrderAccepted")[0]?.args.id; s.orderId = oid?.toString(); if (oid === undefined || oid === null) throw new Error("no order id in events"); });
  await stage("cancel resting bid", (s) => send(s, () => ex.connect(t1).cancelOrder(oid)));
  await stage("maker bid (GTC) at price", async (s) => { const rc = await send(s, () => ex.connect(t1).placeOrder(who1, 0, OP(true, TIF.GTC))); s.orderId = evs(rc, "OrderRested")[0]?.args.id.toString(); });
  await stage("taker ask (IOC) crosses -> Fill", async (s) => { const rc = await send(s, () => ex.connect(signer2).placeOrder(who2, sub2, OP(false, TIF.IOC))); const f = evs(rc, "Fill"); s.fills = f.length; if (!f.length) throw new Error("no Fill event"); s.fillSize = f[0].args.size.toString(); s.takerFee = f[0].args.takerFee.toString(); });
  await stage("close: trader2 bid (GTC, reduce-only)", (s) => send(s, () => ex.connect(signer2).placeOrder(who2, sub2, OP(true, TIF.GTC, true))));
  await stage("close: trader1 ask (IOC, reduce-only) -> Fill", async (s) => { const rc = await send(s, () => ex.connect(t1).placeOrder(who1, 0, OP(false, TIF.IOC, true))); s.fills = evs(rc, "Fill").length; if (!s.fills) throw new Error("no Fill event"); });
  await stage("pokeFunding", (s) => send(s, () => ex.connect(t1).pokeFunding(mid)));
  await stage("accountState (read)", async (s) => { const a = await ex.accountState(await ex.acctKey(who1, 0)); s.equity = a[0].toString(); s.avail = a[4].toString(); });
  await stage("withdraw 1 USDC (trader1)", (s) => send(s, () => ex.connect(t1).withdraw(0, 1_000_000n)));

  const failed = stages.filter((s) => s.status === "FAIL").length;
  const rec = { ranAt: new Date().toISOString(), chainId, exchange: d.exchange, market: mk.name, trader1: who1, trader2: who2, gitCommit: L.gitCommit(), configHash: L.configHash(cfg),
    summary: { ok: stages.filter((s) => s.status === "ok").length, failed, skipped: stages.filter((s) => s.status === "skipped").length,
      totalGas: stages.reduce((a, s) => a + BigInt(s.gasUsed || 0), 0n).toString() }, stages };
  fs.writeFileSync(out, JSON.stringify(rec, null, 2));
  console.log(L.table(stages.map((s) => ({ stage: s.name.slice(0, 52), status: s.status, gas: s.gasUsed || "-", submitMs: s.submitMs ?? "-", minedMs: s.minedMs ?? "-", err: (s.error || "").slice(0, 50) }))));
  console.log(`\n${rec.summary.ok} ok / ${failed} failed / ${rec.summary.skipped} skipped -> ${out}`);
  process.exitCode = failed ? 1 : 0;
  return rec;
}
module.exports = { run };
if (!process.env.SMOKE_NO_MAIN) main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY, process.env.TRADER2_PRIVATE_KEY])); process.exit(1); });
