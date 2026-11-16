// BACKSTOP PHASE 2 DEMO on the DEMO-USD market (admin-set price, NOT a real feed). DRY-RUN BY DEFAULT.
//   dry-run (read-only, no key): npx hardhat --config hardhat.testnet.config.js run scripts/testnet/demo-backstop.js --network arbitrumSepolia
//   BROADCAST:  CONFIRM_BACKSTOP_DEMO=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/demo-backstop.js --network arbitrumSepolia
// Needs: DEPLOYER_PRIVATE_KEY = the admin (it owns the demo ManualOracle and acts as the keeper/short side); optional TRADER2_PRIVATE_KEY (must hold a little
// ETH for gas) = the long side, otherwise the long is sub-account 1 of the deployer. enable-backstop.js must have enabled DEMO-USD first.
// Flow (every step prints chain state): fund 2 accounts -> short rests / long buys 0.5 at 100 -> price down so the long is liquidatable -> liquidate (the backstop
// takes the inventory, market becomes ELEVATED) -> syncBackstop -> wait for the dwell so the auction discount starts -> takeBackstop -> pokeBackstop ->
// restore price 100 -> withdraw what is free. Aborts cleanly on any revert (and puts the price back). Transcript: infra/testnet/backstop-demo-last-run.json.
const fs = require("fs"); const path = require("path");
const { ethers, ctx, mergedAbi, loadDeployment } = require("./common");
const L = require("./lib");
const OUT = path.join(__dirname, "..", "..", "..", "infra", "testnet", "backstop-demo-last-run.json");
const EXPLORER = "https://sepolia.arbiscan.io";
const TIF = { GTC: 0, IOC: 1 };

async function main() {
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  return run({ d: loadDeployment(), chainId, signers, gate: L.broadcastGate("CONFIRM_BACKSTOP_DEMO", chainId), out: OUT, checkDeployer: true });
}

const fmt6 = (v) => (Number(v) / 1e6).toFixed(4);
const fmtSz = (v) => (Number(v) / 1e8).toFixed(4);

// opts.local: in-process hardhat chain (time travel instead of sleeping). opts.sleep(ms) overridable for tests.
async function run({ d, chainId, signers, gate, out, checkDeployer, local = false, cfg = L.loadConfig(), env = process.env }) {
  const live = gate.ok;
  console.log(live ? "MODE: LIVE demo (sends real testnet transactions on the DEMO-USD market)" : `MODE: DRY-RUN (read-only; ${gate.reason})`);
  console.log("DEMO-USD IS AN ADMIN-SET PRICE, NOT A REAL FEED. This transcript says nothing about real market behaviour.");
  const demoMkt = cfg.markets.find((m) => m.oracleMode === "demo");
  if (!demoMkt || !d.demo) throw new Error("this deployment has no DEMO-USD market (deploy with the demo market enabled; DEMO_MARKET=no disables it)");
  const mid = Number(d.demo.marketId); const feed = d.demo.feed;
  const bs = cfg.backstop && cfg.backstop["DEMO-USD"];
  if (!bs) throw new Error("testnet.config.json has no backstop entry for DEMO-USD");
  const abi = await mergedAbi();
  const ex = new ethers.Contract(d.exchange, abi, ethers.provider);
  const oracle = new ethers.Contract(d.demo.manualOracle, ["function owner() view returns (address)", "function set(bytes32,uint256)", "function latest(bytes32) view returns (uint256,uint256)"], ethers.provider);
  const usdc = new ethers.Contract(d.usdc, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function mint(address,uint256)"], ethers.provider);
  const P0 = BigInt(cfg.demo.startPrice);                  // 100.00
  const P_DOWN = P0 * 90n / 100n;                          // 90.00: a 10x-ish long with ~12% margin is below maintenance
  const SIZE = 50_000_000n;                                // 0.5 units, ~50 USDC notional
  const DEPOSIT = BigInt(Math.round(Number(env.DEMO_DEPOSIT_USDC || 6) * 1e6));
  const stages = []; const txs = []; let aborted = null; let priceChanged = false;

  let k1 = null, t2 = null;
  if (live) {
    k1 = L.requireSigner(signers, "demo-backstop");
    if (checkDeployer) L.assertDeployerMatch(k1.address, L.expectedDeployer(cfg));
    const nk = L.normalizeKey(env.TRADER2_PRIVATE_KEY);
    if (env.TRADER2_PRIVATE_KEY && !nk.ok) throw new Error("TRADER2_PRIVATE_KEY malformed: " + nk.reason);
    t2 = nk.ok ? new ethers.Wallet(nk.key, ethers.provider) : null;
    if ((await oracle.owner()).toLowerCase() !== k1.address.toLowerCase()) throw new Error(`REFUSING: the demo oracle owner is ${await oracle.owner()}, not the loaded deployer`);
  }
  const keeper = k1 ? k1.address : L.expectedDeployer(cfg);
  const shortAddr = keeper, shortSub = 0;                  // short / taker side = deployer sub0
  const longAddr = t2 ? t2.address : keeper, longSub = t2 ? 0 : Number(env.DEMO_LONG_SUB ?? 1); // DEMO_LONG_SUB: use a fresh, empty sub-account (leftover collateral can keep the long above maintenance)
  const longSigner = t2 || k1;
  console.log(`keeper+short side: ${shortAddr} sub${shortSub} | long side: ${longAddr} sub${longSub}${t2 ? "" : " (same wallet, sub-account 1)"}`);
  const shortKey = await ex.acctKey(shortAddr, shortSub), longKey = await ex.acctKey(longAddr, longSub);
  const BACKSTOP = await ex.BACKSTOP();

  async function readState(label) {
    const [cfgNow, au, pos, eq, mark] = await Promise.all([ex.backstopCfg(mid), ex.backstopAuction(mid), ex.positions(BACKSTOP, mid), ex.backstopEquity(), ex.markPrice(mid).catch(() => 0n)]);
    const notional = (pos.size < 0n ? -pos.size : pos.size) * mark / 100_000_000n;
    const st = { label, mark: fmt6(mark), backstopSize: fmtSz(pos.size), inventoryNotionalUsdc: fmt6(notional), softNotionalUsdc: fmt6(cfgNow.softNotional), elevatedSince: Number(cfgNow.elevatedSince),
      backstopEquityUsdc: fmt6(eq), unresolvedBadDebtUsdc: fmt6(await ex.unresolvedBadDebt()), auction: { active: au[0], takerSells: au[1], price: fmt6(au[2]), discBps: au[3].toString(), size: fmtSz(au[4]) } };
    console.log(`    [chain] ${JSON.stringify(st)}`);
    return st;
  }
  // DEMO_RESUME=yes: continue an interrupted run (positions open, price already 90, backstop holds inventory): skips setup/open/liquidate/sync, still takes, pokes, restores price and withdraws.
  const RESUME = env.DEMO_RESUME === "yes"; if (RESUME) priceChanged = true;
  const EARLY = ["set demo price to 100", "approve USDC", "deposit ", "short side rests", "long side buys", "liquidate the long", "syncBackstop"];
  async function stage(name, fn) {
    if (RESUME && EARLY.some((e) => name.startsWith(e))) return null;
    if (aborted) { stages.push({ name, status: "skipped", reason: aborted }); return null; }
    const s = { name, status: "ok" };
    console.log(`\n> ${name}`);
    try { const r = await fn(s); stages.push(s); return r; }
    catch (e) {
      let msg = String(e.shortMessage || e.message);
      try { const pe = ex.interface.parseError(e.data || e.error?.data || e.info?.error?.data); if (pe) msg = `${pe.name}(${pe.args.join(",")})`; } catch { /* keep msg */ }
      s.status = "FAIL"; s.error = L.redact(msg.slice(0, 300), [env.DEPLOYER_PRIVATE_KEY, env.TRADER2_PRIVATE_KEY, env.ARB_SEPOLIA_RPC_URL]);
      stages.push(s); aborted = `earlier stage failed: ${name}`;
      console.error(`  ABORTING DEMO: ${s.error}`);
      return null;
    }
  }
  async function send(s, fn) {
    const tx = await fn(); const rc = await tx.wait(1);
    Object.assign(s, { hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), effGasPriceWei: rc.gasPrice?.toString() });
    if (chainId === L.ARB_SEPOLIA_CHAIN_ID) s.arbiscan = `${EXPLORER}/tx/${rc.hash}`;
    txs.push({ step: s.name, hash: rc.hash, gasUsed: rc.gasUsed.toString() });
    console.log(`    tx ${rc.hash} gas ${rc.gasUsed}${s.arbiscan ? "  " + s.arbiscan : ""}`);
    return rc;
  }
  const evs = (rc, name) => rc.logs.filter((l) => l.address.toLowerCase() === d.exchange.toLowerCase()).map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);
  const setPrice = async (s, p) => { await send(s, () => oracle.connect(k1).set(feed, p)); priceChanged = p !== P0; s.price = fmt6(p); };

  // ------------------------------------------------------------- read-only preflight (also the whole dry run)
  const pre = {};
  await stage("preflight (read-only)", async (s) => {
    const cfgNow = await ex.backstopCfg(mid);
    if (cfgNow.softNotional === 0n) throw new Error("DEMO-USD backstop is OFF (softNotional 0): run enable-backstop.js first");
    const [px, t] = await oracle.latest(feed);
    Object.assign(s, { demoPriceUsdc: fmt6(px), demoPriceAgeSecs: (await ethers.provider.getBlock("latest")).timestamp - Number(t), softNotionalUsdc: fmt6(cfgNow.softNotional), dwell: Number(cfgNow.dwell), ramp: Number(cfgNow.ramp), maxAge: Number(cfgNow.maxAge), maxDiscBps: Number(cfgNow.maxDiscBps) });
    pre.dwell = Number(cfgNow.dwell); pre.ramp = Number(cfgNow.ramp);
    pre.usdc = await usdc.balanceOf(keeper); pre.eth = await ethers.provider.getBalance(keeper);
    s.usdcBalanceKeeper = fmt6(pre.usdc); s.ethBalanceKeeper = ethers.formatEther(pre.eth);
    const need = DEPOSIT * (t2 ? 1n : 2n);
    s.usdcNeededFromKeeper = fmt6(need);
    if (live && pre.usdc < need) throw new Error(`keeper USDC ${fmt6(pre.usdc)} < ${fmt6(need)} needed (faucet: ${cfg.usdc.faucet})`);
    if (live && t2) { const b2 = await usdc.balanceOf(t2.address); if (b2 < DEPOSIT) throw new Error(`trader2 USDC ${fmt6(b2)} < ${fmt6(DEPOSIT)}`); }
    if (live) { // the long must start empty, or leftover collateral keeps it above maintenance after the price drop (seen on deploy #3 with sub 1)
      const lk = await ex.acctKey(longAddr, longSub); const lc = await ex.accountState(lk); const lp = await ex.positions(lk, mid);
      s.longAccountEquityUsdc = fmt6(lc[0]);
      if (lc[0] !== 0n || lp[0] !== 0n) throw new Error(`the long account (${longAddr} sub${longSub}) is not empty (equity ${fmt6(lc[0])}, position ${fmtSz(lp[0])}): set DEMO_LONG_SUB to an unused sub-account`);
    }
    s.state = await readState("before");
    if (!RESUME && (s.state.auction.active || s.state.backstopSize !== "0.0000")) throw new Error("the demo market already has backstop inventory; wait for it to clear or use a fresh deployment");
  });
  if (!live) {
    console.log("\nPlan (live, ~16 transactions): set price 100 -> approve + deposit x2 (" + fmt6(DEPOSIT) + " USDC each) -> short rests 0.5 @100, long buys it (IOC) -> set price 90 -> liquidate long ->");
    console.log("  syncBackstop -> wait dwell " + (pre.dwell ?? bs.dwell) + "s -> takeBackstop (short side buys the inventory at the discounted auction price) -> pokeBackstop -> price back to 100 -> withdraw free collateral.");
    console.log("DRY-RUN: nothing sent, backstop-demo-last-run.json not written.");
    console.log(JSON.stringify(stages, null, 1));
    return { live, stages };
  }

  // ------------------------------------------------------------- live flow
  let longSize = 0n;
  try {
    await stage("set demo price to 100", (s) => setPrice(s, P0));
    await stage("approve USDC (keeper/short side)", async (s) => { if ((await usdc.allowance(keeper, d.exchange)) >= DEPOSIT * 2n) { s.note = "allowance sufficient"; return; } await send(s, () => usdc.connect(k1).approve(d.exchange, ethers.MaxUint256)); });
    if (t2) await stage("approve USDC (trader2/long side)", async (s) => { if ((await usdc.allowance(longAddr, d.exchange)) >= DEPOSIT) { s.note = "allowance sufficient"; return; } await send(s, () => usdc.connect(t2).approve(d.exchange, ethers.MaxUint256)); });
    await stage("deposit short side", (s) => send(s, () => ex.connect(k1).deposit(shortAddr, shortSub, DEPOSIT)));
    await stage("deposit long side", (s) => send(s, () => ex.connect(longSigner).deposit(longAddr, longSub, DEPOSIT)));
    const OP = (isBuy, tif, price, size = SIZE) => ({ market: mid, isBuy, price, size, tif, reduceOnly: false, cloid: 0n, expiry: 0 });
    await stage("short side rests an ask 0.5 @ 100 (GTC)", (s) => send(s, () => ex.connect(k1).placeOrder(shortAddr, shortSub, OP(false, TIF.GTC, P0))));
    await stage("long side buys 0.5 @ 100 (IOC) -> Fill", async (s) => { const rc = await send(s, () => ex.connect(longSigner).placeOrder(longAddr, longSub, OP(true, TIF.IOC, P0))); const f = evs(rc, "Fill"); if (!f.length) throw new Error("no Fill event"); longSize = f.reduce((a, e) => a + e.args.size, 0n); s.filledSize = fmtSz(longSize); s.state = await readState("after open"); });
    await stage("set demo price to 90 (long is now below maintenance)", async (s) => { await setPrice(s, P_DOWN); const a = await ex.accountState(longKey); s.longEquityUsdc = fmt6(a[0]); s.longMaintenanceUsdc = fmt6(a[2]); });
    await stage("liquidate the long (keeper) -> backstop takes inventory", async (s) => {
      const rc = await send(s, () => ex.connect(k1).liquidate(longKey, mid));
      const l = evs(rc, "Liquidated")[0]; if (!l) throw new Error("no Liquidated event");
      s.liquidatedSize = fmtSz(l.args.size); s.liqPrice = fmt6(l.args.price); s.badDebtUsdc = fmt6(l.args.badDebt);
      s.elevatedEvents = evs(rc, "BackstopElevated").map((e) => ({ notionalUsdc: fmt6(e.args.notional) }));
      s.state = await readState("after liquidation");
      if (!s.elevatedEvents.length) console.log("    note: no BackstopElevated (inventory notional is not above the soft cap); the auction will not start");
    });
    await stage("syncBackstop", async (s) => { const rc = await send(s, () => ex.connect(k1).syncBackstop()); s.events = evs(rc, "BackstopSynced").length; s.state = await readState("after sync"); });
    const waitSecs = Math.max(0, Number(env.DEMO_WAIT_SECS ?? pre.dwell + 15)); // DEMO_WAIT_SECS=dwell+ramp shows the full discount (maxDiscBps)
    await stage(`wait ${waitSecs}s (dwell ${pre.dwell}s, then the discount ramps over ${pre.ramp}s)`, async (s) => {
      if (local) { await ethers.provider.send("evm_increaseTime", [waitSecs]); await ethers.provider.send("evm_mine", []); }
      else await new Promise((r) => setTimeout(r, waitSecs * 1000));
      s.state = await readState("auction after waiting");
      if (!s.state.auction.active) throw new Error("auction is not active (market not elevated?)");
    });
    await stage("takeBackstop (short side buys the whole inventory at the auction price)", async (s) => {
      const au = await ex.backstopAuction(mid);
      if (!au[0] || au[1]) throw new Error(`unexpected auction: active=${au[0]} takerSells=${au[1]} (expected the backstop to be LONG)`);
      const size = au[4], limit = au[2] + BigInt(cfg.markets.find((m) => m.oracleMode === "demo").params.tick) * 2n; // 2 ticks of slack: the discount shrinks the price as time passes only downwards for a buyer
      const rc = await send(s, () => ex.connect(k1).takeBackstop(shortAddr, shortSub, mid, size, limit));
      const t = evs(rc, "BackstopTaken")[0]; if (!t) throw new Error("no BackstopTaken event");
      Object.assign(s, { takenSize: fmtSz(t.args.size), price: fmt6(t.args.price), discBps: t.args.discBps.toString(), feeUsdc: fmt6(t.args.fee), relaxedEvents: evs(rc, "BackstopRelaxed").length });
      s.state = await readState("after take");
    });
    await stage("pokeBackstop (refresh the clock; relaxes if inventory is under the cap)", async (s) => { const rc = await send(s, () => ex.connect(k1).pokeBackstop(mid)); s.relaxedEvents = evs(rc, "BackstopRelaxed").length; s.state = await readState("after poke"); });
  } finally {
    // ALWAYS leave the demo price at 100 (also after an abort), then reclaim what is free.
    if (priceChanged || aborted) { aborted = null; await stage("restore demo price to 100", (s) => setPrice(s, P0)); }
  }
  for (const [label, key, who, sub, sg] of [["short side", shortKey, shortAddr, shortSub, k1], ["long side", longKey, longAddr, longSub, longSigner]]) {
    await stage(`withdraw free collateral (${label})`, async (s) => {
      const w = await ex.withdrawable(key); s.withdrawableUsdc = fmt6(w);
      if (w > 0n) await send(s, () => ex.connect(sg).withdraw(sub, w)); else s.note = "nothing withdrawable";
    });
  }
  const failed = stages.filter((s) => s.status === "FAIL").length;
  const rec = { ranAt: new Date().toISOString(), network: chainId === L.ARB_SEPOLIA_CHAIN_ID ? "arbitrumSepolia" : `chain ${chainId}`, chainId, exchange: d.exchange, demoMarketId: mid, demoPriceIsAdminSet: true,
    keeperAndShortSide: shortAddr, longSide: `${longAddr} sub${longSub}`, gitCommit: L.gitCommit(), configHash: L.configHash(cfg),
    summary: { ok: stages.filter((s) => s.status === "ok").length, failed, skipped: stages.filter((s) => s.status === "skipped").length, txCount: txs.length, totalGas: txs.reduce((a, t) => a + BigInt(t.gasUsed), 0n).toString() }, stages };
  fs.writeFileSync(out, JSON.stringify(rec, null, 2));
  console.log(L.table(stages.map((s) => ({ stage: s.name.slice(0, 60), status: s.status, gas: s.gasUsed || "-", err: (s.error || "").slice(0, 50) }))));
  console.log(`\n${rec.summary.ok} ok / ${failed} failed / ${rec.summary.skipped} skipped, ${rec.summary.txCount} txs, ${rec.summary.totalGas} gas -> ${out}`);
  process.exitCode = failed ? 1 : 0;
  return rec;
}
module.exports = { run };
if (!process.env.DEMO_NO_MAIN) main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY, process.env.TRADER2_PRIVATE_KEY, process.env.ARB_SEPOLIA_RPC_URL])); process.exit(1); });
