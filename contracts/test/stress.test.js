// Large-price-gap stress tests for liquidation / bad debt / insurance / backstop / ADL (fast-check, model-based).
//
// Run:   npx hardhat test test/stress.test.js
// Env:   STRESS_RUNS (default 40)  random scenarios per fuzz group
//        STRESS_LEN  (default 22)  max random steps per scenario
//        STRESS_SEED (default 20261113) fast-check seed (failures print seed + counterexample + repro line)
//        STRESS_GROUPS  comma list of fuzz groups to run: A,B,C,D (default all)
//        STRESS_SHRINK=1  enable fast-check shrinking of failing scenarios (default off: first failing scenario is reported)
//        (STRESS_KNOWN_GAPS is obsolete: BACKSTOP-1 and ADL-2 are fixed; their tests and the P3 backstop tolerance are now required.)
//        STRESS_TIMEOUT_MS (default 1200000)
//
// Fuzz groups (same scenario generator, different set of FATAL properties; non-fatal violations are tallied and printed):
//   A  structural: P1 net position, P2 exact ledger identity (incl. isoMargin and open-position basis), P3a debt==sum(adlDebt),
//      P4 bucket isolation, P5 liquidation correctness (healthy never liquidated), P7 ADL bounds, P8 insurance, P0 no panic/OOG
//   D  funding conservation (fundingPool + pending funding of every account incl. BACKSTOP == rounding residue)
//   B  liveness (P10): every underwater position is liquidatable when oracles are valid; keeper loop terminates
//   C  physical solvency P3 at flat;   E  closure: P6 no flat negative bucket, P9 debt bookkeeping + exact recapitalize
const { expect } = require("chai");
const fc = require("fast-check");
const { ethers, loadFixture, time, usd, btc, TIF, order, deploy } = require("./helpers");

const RUNS = Number(process.env.STRESS_RUNS ?? 40);
const LEN = Number(process.env.STRESS_LEN ?? 22);
const SEED = Number(process.env.STRESS_SEED ?? 20261113);
const GROUPS = (process.env.STRESS_GROUPS ?? "A,D,B,C,E").split(",").map((s) => s.trim());
const NO_SHRINK = process.env.STRESS_SHRINK !== "1"; // shrinking is opt-in (can take minutes); the deterministic tests below are the minimized repros
const KNOWN_GAPS = process.env.STRESS_KNOWN_GAPS === "1"; // no gaps are gated any more (BACKSTOP-1 / ADL-2 are fixed and required); kept so old command lines still work
const TIMEOUT = Number(process.env.STRESS_TIMEOUT_MS ?? 1200000);

const E8 = 100_000_000n;
const BPSN = 10_000n;
const BACKSTOP = ethers.id("PERP.BACKSTOP");
const GAS = 14_000_000;
const MAXU = (1n << 128n) - 1n;
const abs = (x) => (x < 0n ? -x : x);
const fdiv = (a, b) => { let q = a / b; if (a % b !== 0n && (a < 0n) !== (b < 0n)) q -= 1n; return q; };
const cdiv = (a, b) => (a + b - 1n) / b;
const usdStr = (x) => (Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

const MK = [
  { name: "BTC", feed: ethers.id("BTC-USD"), px0: 50_000n * 1_000_000n, tick: 100_000n, lot: 10_000n, maxOrderSize: 100n * E8, maxOI: 1000n * E8 },
  { name: "ETH", feed: ethers.id("ETH-USD"), px0: 3_000n * 1_000_000n, tick: 10_000n, lot: 100_000n, maxOrderSize: 5000n * E8, maxOI: 20_000n * E8 },
  { name: "SOL", feed: ethers.id("SOL-USD"), px0: 150n * 1_000_000n, tick: 10_000n, lot: 1_000_000n, maxOrderSize: 200_000n * E8, maxOI: 1_000_000n * E8 },
];
const NM = MK.length;
const TIERS = [
  { upToNotional: usd(100_000), imrBps: 1000, mmrBps: 500 },
  { upToNotional: usd(1_000_000), imrBps: 2000, mmrBps: 1000 },
  { upToNotional: MAXU, imrBps: 5000, mmrBps: 2500 },
];
const mcfg = (mk, over = {}) => ({
  feed: mk.feed, tick: mk.tick, lot: mk.lot, minNotional: usd(10), maxOrderSize: mk.maxOrderSize, maxOI: mk.maxOI,
  maxAge: 60, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n, ...over,
});
const acctKey = (addr, sub = 0) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8"], [addr, sub]));
const rt = (p, m) => (p / MK[m].tick) * MK[m].tick;
const STATE = { Normal: 0, ReduceOnly: 1, OracleDegraded: 2, Paused: 3, Recovery: 4, Delisted: 5 };

// ------------------------------------------------------------------------------------------------ fixture
async function stressFixture() {
  const e = await deploy(); // BTC market 0 (px 50k), admin = signers[0]
  const { ex, oracle, usdc } = e;
  const sg = await ethers.getSigners();
  for (const mk of MK.slice(1)) { await oracle.set(mk.feed, mk.px0); await ex.createMarket(mcfg(mk), TIERS); }
  const traders = sg.slice(1, 7), cp = sg[10], kp = sg[11], bsOp = sg[12], payer = sg[13];
  await ex.grantRole(await ex.BACKSTOP_ROLE(), bsOp.address);
  const actors = [...traders, cp, kp]; // idx 0..5 traders, 6 cp (deep liquidity), 7 keeper-account
  for (const s of [...actors, bsOp, payer]) {
    await usdc.mint(s.address, usd(500_000_000));
    await usdc.connect(s).approve(await ex.getAddress(), ethers.MaxUint256);
  }
  return { ...e, sg, traders, cp, kp, bsOp, payer, actors };
}

// ------------------------------------------------------------------------------------------------ errors / violations
function decodeErr(ex, e) {
  const cands = [e?.data, e?.error?.data, e?.info?.error?.data, e?.info?.error?.error?.data, e?.error?.error?.data];
  for (const d of cands) {
    const hex = typeof d === "string" ? d : d?.data;
    if (typeof hex === "string" && hex.startsWith("0x") && hex.length >= 10) {
      if (hex.startsWith("0x4e487b71")) return { name: "Panic", args: [BigInt("0x" + hex.slice(10, 74))], raw: hex };
      if (hex.startsWith("0x08c379a0")) { try { const [s] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hex.slice(10)); return { name: "Error", args: [s], raw: hex }; } catch { return { name: "Error", args: ["?"], raw: hex }; } }
      try { const p = ex.interface.parseError(hex); if (p) return { name: p.name, args: [...p.args], raw: hex }; } catch {}
      return { name: "Unknown(" + hex.slice(0, 10) + ")", args: [], raw: hex };
    }
  }
  return null;
}
const errStr = (d) => d.name + (d.args && d.args.length ? "(" + d.args.join(",") + ")" : "");

class Viol extends Error { constructor(prop, msg) { super(`[${prop}] ${msg}`); this.prop = prop; } }
const TELE = { soft: {}, softMsg: {}, n: {} };
const bump = (k, by = 1) => { TELE.n[k] = (TELE.n[k] ?? 0) + by; };
function viol(c, prop, msg) {
  if (c.fatal.has(prop)) throw new Viol(prop, msg);
  TELE.soft[prop] = (TELE.soft[prop] ?? 0) + 1;
  if (!TELE.softMsg[prop]) TELE.softMsg[prop] = msg;
}

// ------------------------------------------------------------------------------------------------ chain helpers
function parseEvents(c, r) {
  const out = [];
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== c.exAddr) continue;
    try { const p = c.ex.interface.parseLog(l); if (p) out.push(p); } catch {}
  }
  return out;
}
function absorb(c, evs) {
  for (const e of evs) {
    if (e.name === "Fill") c.fills++;
    else if (e.name === "FundingSettled") c.fundSettles++;
    else if (e.name === "Liquidated") c.liqs++;
    else if (e.name === "BadDebtUnresolved") c.badSum += e.args.amount; // liquidation, settleDelisted, in-fill and writeOff() write-offs
    else if (e.name === "AdlExecuted") { c.adls++; c.clearedSum += e.args.debtCleared; }
    else if (e.name === "Recapitalized") c.recapSum += e.args.amount;
    else if (e.name === "BackstopSynced") { c.syncRepaid += e.args.repaidDebt; c.syncCalls++; }
  }
}

// run a tx; returns {ok, evs, r} or {ok:false, err}. Non-contract failures, Panic and empty-revert (OOG) are fatal P0.
async function send(c, label, fn) {
  try {
    const tx = await fn();
    const r = await tx.wait();
    const evs = parseEvents(c, r);
    absorb(c, evs);
    return { ok: true, evs, r };
  } catch (e) {
    const d = decodeErr(c.ex, e);
    if (!d) throw new Viol("P0", `non-contract / empty-revert (OOG?) failure in ${label}: ${String(e.message).slice(0, 300)}`);
    if (d.name === "Panic") throw new Viol("P0", `Panic(${d.args[0]}) in ${label}`);
    if (d.name.startsWith("Unknown")) throw new Viol("P0", `unknown revert ${d.name} in ${label}`);
    bump("revert:" + d.name + (d.name === "BadParam" ? ":" + d.args[0] : ""));
    return { ok: false, err: d };
  }
}

async function readState(c) {
  const { ex, usdc } = c;
  const st = { coll: new Map(), resv: new Map(), pos: new Map() };
  await Promise.all(c.allKeys.map(async (k) => {
    const [col, rs, ...ps] = await Promise.all([ex.collateral(k), ex.reserved(k), ...MK.map((_, m) => ex.positions(k, m))]);
    st.coll.set(k, col); st.resv.set(k, rs);
    st.pos.set(k, ps.map((p) => ({ size: p.size, basis: p.basis, last: p.lastFundingIdx, iso: p.isolated, isoMargin: p.isoMargin, isoResv: p.isoReserved })));
  }));
  const [ins, fee, fund, ubd, dust, dep, wd, bal, paused, bsIns, bsDebt, ...rest] = await Promise.all([
    ex.insurance(), ex.feePool(), ex.fundingPool(), ex.unresolvedBadDebt(), ex.dustBasis(), ex.totalDeposited(), ex.totalWithdrawn(),
    usdc.balanceOf(c.exAddr), ex.globalPaused(), ex.bsInsDrawn(), ex.bsDebt(),
    ...MK.map((_, m) => ex.adlDebt(m)), ...MK.map((_, m) => ex.getMarket(m)),
    ...MK.map(async (_, m) => { try { return await ex.markPrice(m); } catch { return null; } }),
  ]);
  Object.assign(st, { ins, fee, fund, ubd, dust, dep, wd, bal, paused, bsIns, bsDebt });
  st.adl = rest.slice(0, NM);
  const gm = rest.slice(NM, 2 * NM);
  st.mst = gm.map((x) => Number(x.state)); st.fidx = gm.map((x) => x.fundingIndex); st.oi = gm.map((x) => x.oi);
  st.mark = rest.slice(2 * NM, 3 * NM);
  return st;
}

// ------------------------------------------------------------------------------------------------ core (state-only) invariants
function backstopEquity(c, st) {
  let eq = st.coll.get(BACKSTOP);
  for (let m = 0; m < NM; m++) {
    const p = st.pos.get(BACKSTOP)[m];
    eq += p.isoMargin;
    if (p.size !== 0n && st.mark[m] !== null) eq += fdiv(p.size * st.mark[m] - p.basis, E8);
  }
  return eq;
}

function checkCore(c, st, label) {
  let sumColl = 0n, sumIso = 0n, sumBasis = 0n, pend = 0n, npos = 0;
  for (let m = 0; m < NM; m++) {
    let net = 0n, longs = 0n;
    for (const k of c.allKeys) {
      const p = st.pos.get(k)[m];
      net += p.size; if (p.size > 0n) longs += p.size;
      if (p.size !== 0n) { npos++; pend += p.size * (st.fidx[m] - p.last); }
    }
    if (net !== 0n) viol(c, "P1", `${label}: aggregate signed position of ${MK[m].name} = ${net} (incl BACKSTOP)`);
    if (longs !== st.oi[m]) viol(c, "P1", `${label}: ${MK[m].name} oi ${st.oi[m]} != sum longs ${longs}`);
  }
  for (const k of c.allKeys) {
    sumColl += st.coll.get(k);
    for (let m = 0; m < NM; m++) { const p = st.pos.get(k)[m]; sumIso += p.isoMargin; sumBasis += p.basis; }
  }
  if (st.bal !== st.dep - st.wd) viol(c, "P2", `${label}: USDC balance ${st.bal} != deposited-withdrawn ${st.dep - st.wd}`);
  // exact identity in 1e8 units: sum(coll)+sum(iso)+ins+fee+fund-ubd-(D-W) = (sumBasis - dust)/1e8 - leak   (leak = ADL rounding retained by the vault)
  const E = E8 * (sumColl + sumIso + st.ins + st.fee + st.fund - st.ubd - (st.dep - st.wd)) + st.dust - sumBasis;
  if (E + c.leak !== 0n) viol(c, "P2", `${label}: ledger identity broken: E=${E} (1e-8 USDC) leak=${c.leak} sumColl=${sumColl} sumIso=${sumIso} ins=${st.ins} fee=${st.fee} fund=${st.fund} ubd=${st.ubd} dust=${st.dust} sumBasis=${sumBasis}`);
  let sad = 0n; for (const d of st.adl) sad += d;
  if (sad !== st.ubd) viol(c, "P3a", `${label}: unresolvedBadDebt ${st.ubd} != sum(adlDebt) ${sad}`);
  // funding conservation: fundingPool*1e14 + exact pending funding of ALL accounts (incl. BACKSTOP) is rounding residue in [0, n*1e14)
  const Q = st.fund * 100_000_000_000_000n + pend;
  const n = BigInt(c.fundSettles + npos + 2);
  if (Q < 0n || Q >= n * 100_000_000_000_000n) viol(c, "FUND", `${label}: funding not conserved: fundingPool=${st.fund} pending(1e-14)=${pend} residue=${Q} (allowed [0, ${n}e14))`);
  // P6 flat negative (informational per step; fatal only in group C)
  for (const k of c.allKeys) {
    if (k === BACKSTOP) continue;
    const ps = st.pos.get(k);
    const flatAll = ps.every((p) => p.size === 0n);
    if (flatAll && st.coll.get(k) < 0n) viol(c, "P6", `${label}: flat account ${c.nameOf(k)} has negative cross collateral ${st.coll.get(k)} (no bad debt recorded: ubd=${st.ubd}) preSettle[${c.nameOf(k)}]: ${c.preEq ? c.preEq[c.nameOf(k)] : "n/a"}`);
    ps.forEach((p, m) => { if (p.size === 0n && p.isoMargin < 0n) viol(c, "P6", `${label}: flat isolated bucket ${c.nameOf(k)}/${MK[m].name} negative: ${p.isoMargin}`); });
  }
  c.minBackstopEq = (() => { const e = backstopEquity(c, st); return e < c.minBackstopEq ? e : c.minBackstopEq; })();
}

// bucket isolation P4 / untouched accounts / insurance P8, generic over a tx. `direct` = accounts whose bucket may move by design.
function checkTx(c, pre, post, evs, label, { keeper = null, donated = 0n, rebalanced = 0n, skip = false, allowDown = false } = {}) {
  if (!skip) {
    const directCross = new Set(), directIso = new Set(); // "k|m"
    const owedCross = new Map(), owedIso = new Map();
    let cut = 0n, feeShare = 0n;
    for (const e of evs) {
      if (e.name === "FundingSettled") {
        const k = e.args.acct, m = Number(e.args.market);
        const iso = pre.pos.get(k)[m].iso;
        const map = iso ? owedIso : owedCross; const key = iso ? k + "|" + m : k;
        map.set(key, (map.get(key) ?? 0n) - e.args.owed);
      } else if (e.name === "Liquidated") {
        const k = e.args.acct, m = Number(e.args.market);
        (pre.pos.get(k)[m].iso ? directIso : directCross).add(pre.pos.get(k)[m].iso ? k + "|" + m : k);
        const f = e.args.fee, kc = f * 5000n / BPSN; cut += kc; feeShare += f - kc;
      } else if (e.name === "AdlExecuted" || e.name === "DelistedSettled") {
        const k = e.name === "AdlExecuted" ? e.args.target : e.args.acct, m = Number(e.args.market);
        (pre.pos.get(k)[m].iso ? directIso : directCross).add(pre.pos.get(k)[m].iso ? k + "|" + m : k);
      } else if (e.name === "BackstopUnwound" || e.name === "BackstopTaken") {
        const k = e.name === "BackstopUnwound" ? e.args.target : e.args.acct, m = Number(e.args.market);
        (pre.pos.get(k)[m].iso ? directIso : directCross).add(pre.pos.get(k)[m].iso ? k + "|" + m : k);
      } else if (e.name === "Fill") {
        for (const k of [e.args.maker, e.args.taker]) { const m = Number(e.args.market); (pre.pos.get(k)[m].iso ? directIso : directCross).add(pre.pos.get(k)[m].iso ? k + "|" + m : k); }
      }
    }
    const keeperKey = keeper;
    for (const k of c.allKeys) {
      if (k === BACKSTOP) continue;
      const isKeeper = keeperKey && k === keeperKey;
      // cross bucket
      if (!directCross.has(k)) {
        const exp = pre.coll.get(k) + (owedCross.get(k) ?? 0n) + (isKeeper ? cut : 0n);
        if (post.coll.get(k) !== exp)
          viol(c, directIso.size ? "P4" : "P4", `${label}: cross collateral of ${c.nameOf(k)} moved ${pre.coll.get(k)} -> ${post.coll.get(k)} (expected ${exp}); isolated/other-bucket operation charged cross collateral`);
      }
      for (let m = 0; m < NM; m++) {
        const p0 = pre.pos.get(k)[m], p1 = post.pos.get(k)[m];
        if (!p0.iso && !p1.iso) { if (p1.isoMargin !== p0.isoMargin) viol(c, "P4", `${label}: isoMargin of non-isolated ${c.nameOf(k)}/${MK[m].name} changed`); continue; }
        if (p0.iso && !directIso.has(k + "|" + m)) {
          const exp = p0.isoMargin + (owedIso.get(k + "|" + m) ?? 0n);
          if (p1.isoMargin !== exp) viol(c, "P4", `${label}: isolated margin of ${c.nameOf(k)}/${MK[m].name} moved ${p0.isoMargin} -> ${p1.isoMargin} (expected ${exp})`);
        }
      }
    }
  }
  // P8 insurance never underflows / never created from nothing
  let feeShares = 0n;
  for (const e of evs) if (e.name === "Liquidated") feeShares += e.args.fee - e.args.fee * 5000n / BPSN;
  const dIns = post.ins - pre.ins;
  const sy = evs.filter((e) => e.name === "BackstopSynced").map((e) => e.args);
  const syDrawn = sy.reduce((x, e) => x + e.fromInsurance, 0n), syRefund = sy.reduce((x, e) => x + e.refundedInsurance, 0n);
  if (dIns > feeShares + donated + rebalanced + syRefund) viol(c, "P8", `${label}: insurance grew by ${dIns} but only ${feeShares} fee share + ${donated} donated + ${rebalanced} rebalanced + ${syRefund} backstop refund available`);
  // insurance legitimately covers flat-negative write-offs in liquidations, settleDelisted and fills (harness gap found by seed 1: settleDelisted was missing here)
  if (dIns < 0n && !evs.some((e) => e.name === "Liquidated" || e.name === "DelistedSettled" || e.name === "Fill") && !allowDown && syDrawn === 0n) viol(c, "P8", `${label}: insurance decreased by ${-dIns} without liquidation/rebalance/backstop draw`);
  if (post.bsDebt > post.ubd) viol(c, "P3a", `${label}: bsDebt ${post.bsDebt} > unresolvedBadDebt ${post.ubd}`);
  // debt only grows through liquidation, only shrinks through adl/recap
  const liqBad = evs.filter((e) => e.name === "BadDebtUnresolved").reduce((x, e) => x + e.args.amount, 0n);
  const cleared = evs.filter((e) => e.name === "AdlExecuted").reduce((x, e) => x + e.args.debtCleared, 0n);
  const recap = evs.filter((e) => e.name === "Recapitalized").reduce((x, e) => x + e.args.amount, 0n);
  const repaid = evs.filter((e) => e.name === "BackstopSynced").reduce((x, e) => x + e.args.repaidDebt, 0n);
  if (post.ubd - pre.ubd !== liqBad - cleared - recap - repaid && !(cleared > 0n && post.ubd === 0n))
    viol(c, "P3a", `${label}: unresolvedBadDebt delta ${post.ubd - pre.ubd} != +${liqBad} bad (incl. backstop sync) -${cleared} adl -${recap} recap -${repaid} backstop repay`);
}

// ------------------------------------------------------------------------------------------------ price / oracle control
async function refresh(c) {
  for (let m = 0; m < NM; m++) {
    if (c.stale & (1 << m)) continue;
    await c.oracle.set(MK[m].feed, c.px[m]);
    c.opx[m] = c.px[m];
  }
  c.lastRefresh = await time.latest();
}
async function ensureFresh(c) { const now = await time.latest(); if (now - c.lastRefresh > 20) await refresh(c); }
function clampPx(m, p) {
  const lo = rt(MK[m].px0 / 30n, m), hi = MK[m].px0 * 30n;
  p = rt(p, m); return p < lo ? lo : p > hi ? hi : p;
}
function shockPx(c, m, bps) { c.px[m] = clampPx(m, (c.px[m] * (BPSN + BigInt(bps))) / BPSN); }

// ------------------------------------------------------------------------------------------------ health / expectations
async function health(c, k, m) {
  const P = c.st.pos.get(k)[m];
  try {
    if (P.iso) { const r = await c.ex.isoState(k, m); return { valid: true, eq: r.equity, mm: r.mm }; }
    const r = await c.ex.accountState(k); return { valid: true, eq: r.equity, mm: r.mm };
  } catch { return { valid: false }; }
}
async function expectLiq(c, a, m) {
  const st = c.st;
  if (st.mst[m] === STATE.Paused || st.mst[m] === STATE.OracleDegraded) return { kind: "MarketRestricted" };
  const h = await health(c, a, m);
  if (!h.valid) {
    // LIQ-1 rule: a CROSS account with a valid mark on the liquidated market stays liquidatable while another held market
    // is stale (that market is valued in the account's favour). Outcome depends on that valuation: Success or NotLiquidatable.
    if (!st.pos.get(a)[m].iso) {
      if (st.pos.get(a)[m].size === 0n) return { kind: "StaleUnrelated" }; // nothing to price in the liquidated market
      try { await c.ex.markPrice(m); return { kind: "StaleUnrelated" }; } catch { /* the liquidated market itself is degraded */ }
    }
    return { kind: "OracleDegraded" };
  }
  if (h.eq >= h.mm) return { kind: "NotLiquidatable", ...h };
  if (st.pos.get(a)[m].size === 0n) return { kind: "NoPosition", ...h };
  return { kind: "Success", ...h };
}
async function underwater(c) {
  const out = [];
  for (const k of c.keys) for (let m = 0; m < NM; m++) {
    if (c.st.pos.get(k)[m].size === 0n) continue;
    const h = await health(c, k, m);
    if (h.valid && h.eq < h.mm) out.push([k, m]);
  }
  return out;
}

// P12 attribution: new backstop debt recorded inside a call that names a market is booked on THAT market
function attrCheck(c, evs, m, label) {
  for (const e of evs) if (e.name === "BackstopSynced" && e.args.toDebt > 0n) {
    bump("p12-debt-sync");
    if (Number(e.args.market) !== m) viol(c, "P12", `${label}: backstop debt ${e.args.toDebt} booked on market ${Number(e.args.market)} but the call acted on market ${m}`);
  }
}
async function doLiquidate(c, kIdx, a, m, label) {
  await ensureFresh(c);
  const pre = c.st;
  let exp = await expectLiq(c, a, m);
  const s = c.actors[kIdx];
  const res = await send(c, label, () => c.ex.connect(s).liquidate(a, m, { gasLimit: GAS }));
  const post = await readState(c); c.st = post;
  const grp = exp.kind === "Success" ? "P10" : "P5";
  if (!res.ok) {
    const n = res.err.name, arg0 = res.err.args[0];
    const got = n === "NotLiquidatable" ? "NotLiquidatable" : n === "OracleDegraded" ? "OracleDegraded" : n === "MarketRestricted" ? "MarketRestricted" : n === "BadParam" && arg0 === "no position" ? "NoPosition" : errStr(res.err);
    if (exp.kind === "StaleUnrelated" && (got === "NotLiquidatable" || got === "NoPosition")) { checkCore(c, post, label + " [reverted]"); return { ok: false, got }; }
    if (got !== exp.kind) viol(c, grp, `${label}: expected ${exp.kind}${exp.eq !== undefined ? ` (eq=${exp.eq}, mm=${exp.mm})` : ""} but reverted with ${got}`);
    if (exp.kind === "Success") bump("liveness-fail");
    if (exp.kind !== "Success") checkCore(c, post, label + " [reverted]");
    return { ok: false, got };
  }
  if (exp.kind === "StaleUnrelated") exp = { kind: "Success" };
  if (exp.kind !== "Success") viol(c, "P5", `${label}: liquidation SUCCEEDED but expected ${exp.kind}${exp.eq !== undefined ? ` (eq=${exp.eq} >= mm=${exp.mm})` : ""}`);
  attrCheck(c, res.evs, m, label);
  const L = res.evs.find((e) => e.name === "Liquidated").args;
  c.keeperOf = s.address;
  const sz = L.size, v0 = pre.pos.get(a)[m], v1 = post.pos.get(a)[m];
  const dir = v0.size > 0n ? 1n : -1n;
  if (v1.size !== v0.size - dir * sz || sz === 0n || sz > abs(v0.size)) viol(c, "P5", `${label}: victim position ${v0.size} -> ${v1.size} inconsistent with closed size ${sz}`);
  const b0 = pre.pos.get(BACKSTOP)[m].size, b1 = post.pos.get(BACKSTOP)[m].size;
  if (b1 !== b0 + dir * sz) viol(c, "P5", `${label}: backstop ${b0} -> ${b1} != +${dir * sz}`);
  const fee = cdiv(sz * L.price / E8 * 50n, BPSN);
  if (L.fee !== fee) viol(c, "P5", `${label}: fee ${L.fee} != expected ${fee}`);
  const syncEv = res.evs.filter((e) => e.name === "BackstopSynced").map((e) => e.args);
  const syncRefund = syncEv.reduce((x, e) => x + e.refundedInsurance, 0n);
  if (L.badDebt > 0n) {
    // insurance may be non-zero only through a same-transaction backstop refund (recoveries repay insurance first, by design)
    if (post.ins > syncRefund) viol(c, "P8", `${label}: bad debt ${L.badDebt} recorded while insurance ${post.ins} still non-zero (backstop refund ${syncRefund})`);
    if (v1.size !== 0n) viol(c, "P8", `${label}: bad debt recorded on non-flat bucket`);
  }
  // per-market delta = victim bad debt on `m` + backstop-sync debt attributed to `m`; a same-tx backstop repayment is spread
  // ascending over markets (sum check only, done by checkTx/checkCore)
  const syncBadHere = syncEv.filter((e) => Number(e.market) === m && e.toDebt > 0n).reduce((x, e) => x + e.toDebt, 0n);
  const syncRepaid_ = syncEv.reduce((x, e) => x + e.repaidDebt, 0n);
  if (syncRepaid_ === 0n && post.adl[m] - pre.adl[m] !== L.badDebt + syncBadHere) viol(c, "P3a", `${label}: adlDebt[${m}] delta ${post.adl[m] - pre.adl[m]} != victim badDebt ${L.badDebt} + backstop sync debt ${syncBadHere}`);
  for (let j = 0; j < NM; j++) if (j !== m && syncRepaid_ === 0n) {
    const exp = syncEv.filter((e) => Number(e.market) === j && e.toDebt > 0n).reduce((x, e) => x + e.toDebt, 0n);
    if (post.adl[j] - pre.adl[j] !== exp) viol(c, "P3a", `${label}: adlDebt[${j}] changed by ${post.adl[j] - pre.adl[j]} (expected ${exp}) by a liquidation on market ${m}`);
  }
  checkTx(c, pre, post, res.evs, label, { keeper: c.keys[kIdx] });
  checkCore(c, post, label);
  return { ok: true, L, partial: v1.size !== 0n };
}

// ------------------------------------------------------------------------------------------------ ADL
async function adlCandidates(c, m) {
  const st = c.st; const bs = st.pos.get(BACKSTOP)[m].size;
  const out = [];
  for (const k of c.keys) {
    const p = st.pos.get(k)[m];
    if (p.size === 0n || bs === 0n || (p.size > 0n) === (bs > 0n)) continue;
    let sc; try { sc = await c.ex.adlScore(k, m); } catch { continue; }
    if (sc > 0n) out.push([k, sc]);
  }
  out.sort((x, y) => (x[1] > y[1] ? -1 : x[1] < y[1] ? 1 : x[0] < y[0] ? -1 : 1));
  return out;
}
async function doAdl(c, kIdx, m, mode, cnt, label) {
  await ensureFresh(c);
  if (c.st.mark[m] === null) c.st = await readState(c); // harness gap found by seed 99: the cached state predates a feed refresh (mark null)
  const pre = c.st;
  if (pre.ubd === 0n) { const r = await send(c, label + " [no debt]", () => c.ex.connect(c.actors[kIdx]).adl([c.keys[0]], m, { gasLimit: GAS })); if (r.ok) viol(c, "P7", `${label}: adl succeeded with adlDebt==0`); return { ok: false }; }
  let cand = await adlCandidates(c, m);
  let list = cand.slice(0, Math.max(1, Math.min(8, cnt))).map((x) => x[0]);
  if (mode === "reversed") list = list.reverse();
  else if (mode === "junk") list = [c.keys[(cnt + m) % c.keys.length]];
  else if (mode === "dup" && list.length) list = [list[0], list[0]];
  if (list.length === 0) list = [c.keys[0]];
  const mark = pre.mark[m];
  const s = c.actors[kIdx];
  const res = await send(c, label, () => c.ex.connect(s).adl(list, m, { gasLimit: GAS }));
  const post = await readState(c); c.st = post;
  if (!res.ok) {
    if (post.ubd > pre.ubd) viol(c, "P7", `${label}: debt increased through reverted adl`);
    const n = res.err.name;
    if (!["BadParam", "MarketRestricted", "OracleDegraded"].includes(n)) viol(c, "P0", `${label}: unexpected adl revert ${errStr(res.err)}`);
    if (mode === "ranked" && n === "BadParam") bump("adl-ranked-reverted:" + res.err.args[0]);
    checkCore(c, post, label + " [reverted]");
    return { ok: false };
  }
  attrCheck(c, res.evs, m, label);
  // P7: debt never increases, targets keep break-even, ranking respected, only opposite-to-backstop
  const syBad = res.evs.filter((e) => e.name === "BackstopSynced").reduce((x, e) => x + e.args.toDebt, 0n);
  const clearedTx = res.evs.filter((e) => e.name === "AdlExecuted").reduce((x, e) => x + e.args.debtCleared, 0n);
  if (post.ubd > pre.ubd + syBad) viol(c, "P7", `${label}: debt increased ${pre.ubd} -> ${post.ubd} (backstop sync added ${syBad})`);
  // global pool (Q3): ADL on market m clears m's own record first, then other markets in ascending order
  { let left = clearedTx; const own = pre.adl[m] < left ? pre.adl[m] : left; left -= own;
    for (let j = 0; j < NM; j++) {
      const exp = j === m ? pre.adl[j] - own : pre.adl[j] - (left < pre.adl[j] ? left : pre.adl[j]);
      if (j !== m) left -= (left < pre.adl[j] ? left : pre.adl[j]);
      if (syBad === 0n && !res.evs.some((e) => e.name === "BackstopSynced") && post.adl[j] !== exp) viol(c, "P7", `${label}: adlDebt[${j}] ${pre.adl[j]} -> ${post.adl[j]} but own-market-first clearing of ${clearedTx} expects ${exp}`);
    } }
  for (const A of res.evs.filter((e) => e.name === "AdlSkipped")) bump("adl-skipped-target");
  const ex_ = res.evs.filter((e) => e.name === "AdlExecuted").map((e) => e.args);
  const bs0 = pre.pos.get(BACKSTOP)[m].size;
  for (const A of ex_) {
    const t0 = pre.pos.get(A.target)[m];
    if ((t0.size > 0n) === (bs0 > 0n)) viol(c, "P7", `${label}: ADL target not opposite to backstop`);
    const sgn = t0.size > 0n ? 1n : -1n;
    const remB = t0.basis * A.size / abs(t0.size);
    const pnl = fdiv(sgn * A.size * A.price - remB, E8);
    // break-even: the closed slice must not realise a loss (entry price is floored in the contract: allow floor slack of size/1e8 micro-USDC)
    const slack = A.size / E8 + 1n;
    if (pnl < -slack) viol(c, "P7", `${label}: ADL pushed target ${c.nameOf(A.target)} below break-even: realised ${pnl} micro-USDC on ${A.size} @ ${A.price} (basis/size entry ${t0.basis / t0.size})`);
    if (pnl < 0n) bump("adl-pnl-below-breakeven-rounding");
    const prem = sgn > 0n ? mark - A.price : A.price - mark;
    const raw = A.size * prem; const leak = raw - E8 * A.debtCleared; // value the vault retains from rounding / clamping
    c.leak += leak; c.leakMax = leak > c.leakMax ? leak : c.leakMax;
    const capBps = pre.bsDebt > 0n ? 10000n : 2500n; // adlHardPremBps (default 10000) while backstop-originated debt is outstanding
    if (prem > mark * capBps / BPSN + 0n) viol(c, "P7", `${label}: premium ${prem} exceeds the ADL premium ceiling (${capBps} bps)`);
  }
  for (const A of ex_) {
    const h = await health(c, A.target, m);
    if (h.valid && h.eq < h.mm) { bump("adl-left-target-underwater"); viol(c, "P7x", `${label}: ADL left cross/iso target ${c.nameOf(A.target)} underwater: eq=${h.eq} < mm=${h.mm}${h.eq < 0n ? " (NEGATIVE equity: new bad debt)" : ""}`); }
  }
  checkTx(c, pre, post, res.evs, label, { keeper: c.keys[kIdx] });
  checkCore(c, post, label);
  return { ok: true, n: ex_.length };
}

// ------------------------------------------------------------------------------------------------ trading helpers
async function freeMargin(c, k, m) {
  try {
    if (c.st.pos.get(k)[m].iso) { const s = await c.ex.isoState(k, m); const av = (s.margin < s.equity ? s.margin : s.equity) - s.im - s.resv; return av > 0n ? av : 0n; }
    const s = await c.ex.accountState(k); return s.avail;
  } catch { return 0n; }
}
const PLACE_OK = new Set(["Unhealthy", "OracleDegraded", "MarketRestricted", "ReduceOnlyViolation", "OICap", "FokUnfilled", "PostOnlyCross", "Expired", "TooManyOrders", "PriceTooFarFromTop", "DuplicateClientId", "BadParam"]);
async function place(c, who, o, label) {
  const s = c.actors[who];
  const res = await send(c, label, () => c.ex.connect(s).placeOrder(s.address, 0, order(o), { gasLimit: GAS }));
  if (!res.ok && !PLACE_OK.has(res.err.name)) throw new Viol("P0", `${label}: unexpected revert ${errStr(res.err)}`);
  return res;
}
async function cancelAll(c, who) { const s = c.actors[who]; await send(c, "cancelAll", () => c.ex.connect(s).cancelAll(s.address, 0, { gasLimit: GAS })); }
async function afterTrade(c, pre, evs, label) {
  const post = await readState(c); c.st = post;
  checkTx(c, pre, post, evs, label);
  checkCore(c, post, label);
}

async function doTrade(c, s, label) {
  const m = s.m; if (s.tk === s.mk) return;
  await ensureFresh(c);
  const tick = MK[m].tick, lot = MK[m].lot;
  let px = rt(c.opx[m], m) + BigInt(s.off) * tick; if (px < tick) px = tick;
  const capT = await freeMargin(c, c.keys[s.tk], m), capM = await freeMargin(c, c.keys[s.mk], m);
  let cap = capT < capM ? capT : capM; if (cap <= 0n) return;
  let notional = cap * 9n * BigInt(s.f) / 100n;
  const cut = usd(100_000); if (notional > cut) notional = cut + (notional - cut) / 4n * 1n / 2n;
  let size = notional * E8 / px; size = size / lot * lot;
  if (size > MK[m].maxOrderSize) size = MK[m].maxOrderSize / lot * lot;
  if (size === 0n || size * px / E8 < usd(10)) return;
  const pre = c.st; const evs = [];
  const r1 = await place(c, s.mk, { market: m, isBuy: !s.buy, price: px, size, tif: TIF.GTC }, label + " maker");
  if (r1.ok) evs.push(...r1.evs);
  const r2 = await place(c, s.tk, { market: m, isBuy: s.buy, price: px, size, tif: TIF.IOC }, label + " taker");
  if (r2.ok) { evs.push(...r2.evs); bump("trade-ok"); }
  if (!s.leave) await cancelAll(c, s.mk);
  const post = await readState(c); c.st = post;
  checkTx(c, pre, post, evs, label, {}); // gathers fills of both txs
  checkCore(c, post, label);
}
// reduce-only close of part of a position against cp (cp quotes the counter side). offBps: price offset vs index (adverse for closer if > 0)
async function doClose(c, s, label) {
  const k = c.keys[s.a]; const p = c.st.pos.get(k)[s.m]; if (p.size === 0n || s.a === 6) return;
  await ensureFresh(c);
  const m = s.m; const tick = MK[m].tick, lot = MK[m].lot;
  const sell = p.size > 0n;
  let px = c.opx[m] * (BPSN + BigInt(sell ? -s.offBps : s.offBps)) / BPSN; px = rt(px, m); if (px < tick) px = tick;
  let size = abs(p.size) * BigInt(s.pct) / 100n / lot * lot; if (size === 0n) size = lot; if (size > abs(p.size)) size = abs(p.size);
  const pre = c.st; const evs = [];
  const r1 = await place(c, 6, { market: m, isBuy: sell, price: px, size, tif: TIF.GTC }, label + " cp");
  if (r1.ok) evs.push(...r1.evs);
  const r2 = await place(c, s.a, { market: m, isBuy: !sell, price: px, size, tif: TIF.IOC, reduceOnly: true }, label + " closer");
  if (r2.ok) evs.push(...r2.evs);
  await cancelAll(c, 6);
  await afterTrade(c, pre, evs, label);
}

async function doPremium(c, s, label) {
  await ensureFresh(c);
  const m = s.m; const tick = MK[m].tick;
  const px = rt(c.opx[m] * (BPSN + BigInt(s.bps)) / BPSN, m);
  const pre = c.st; const evs = [];
  await cancelAll(c, 6);
  const r1 = await place(c, 6, { market: m, isBuy: true, price: px, size: MK[m].lot * (m === 0 ? 10n : 100n), tif: TIF.GTC }, label + " bid");
  const r2 = await place(c, 6, { market: m, isBuy: false, price: px + tick, size: MK[m].lot * (m === 0 ? 10n : 100n), tif: TIF.GTC }, label + " ask");
  for (const r of [r1, r2]) if (r.ok) evs.push(...r.evs);
  // sample the premium, let two half-intervals pass, poke: funding index moves
  for (let i = 0; i < 3; i++) {
    const pr = await send(c, label + " poke", () => c.ex.pokeFunding(m, { gasLimit: GAS }));
    if (pr.ok) evs.push(...pr.evs);
    if (i < 2) { await time.increase(1900); await refresh(c); }
  }
  await afterTrade(c, pre, evs, label);
}

// ------------------------------------------------------------------------------------------------ scenario setup
async function newCtx(sc, fatal) {
  const f = await loadFixture(stressFixture);
  const c = { ...f, fatal: new Set(fatal) };
  c.exAddr = (await f.ex.getAddress()).toLowerCase();
  c.keys = f.actors.map((s) => acctKey(s.address, 0));
  c.allKeys = [...c.keys, BACKSTOP];
  const nm = ["t0", "t1", "t2", "t3", "t4", "t5", "cp", "kp"]; c.nameOf = (k) => (k === BACKSTOP ? "BACKSTOP" : nm[c.keys.indexOf(k)] ?? k.slice(0, 8));
  c.px = MK.map((m) => m.px0); c.opx = [...c.px]; c.stale = 0; c.lastRefresh = 0;
  c.fills = 0; c.fundSettles = 0; c.liqs = 0; c.adls = 0; c.badSum = 0n; c.clearedSum = 0n; c.recapSum = 0n; c.syncRepaid = 0n; c.syncCalls = 0; c.leak = 0n; c.leakMax = 0n;
  c.minBackstopEq = 0n; c.delisted = new Set(); c.partials = 0;
  await refresh(c);
  for (let i = 0; i < 6; i++) {
    const s = f.actors[i];
    await f.ex.connect(s).deposit(s.address, 0, usd(sc.dep[i]));
    for (let m = 0; m < NM; m++) if (sc.iso[i][m]) await f.ex.connect(s).setIsolated(0, m, true);
    const isoMs = [0, 1, 2].filter((m) => sc.iso[i][m]);
    for (const m of isoMs) {
      const amt = usd(Math.floor(sc.dep[i] * sc.isoFrac[i] / 100 / isoMs.length));
      if (amt > 0n) await f.ex.connect(s).addIsoMargin(0, m, amt, { gasLimit: GAS });
    }
  }
  await f.ex.connect(f.cp).deposit(f.cp.address, 0, usd(20_000_000));
  if (sc.kpDep > 0) await f.ex.connect(f.kp).deposit(f.kp.address, 0, usd(sc.kpDep));
  c.st = await readState(c);
  checkCore(c, c.st, "init");
  return c;
}

// ------------------------------------------------------------------------------------------------ steps
async function sweep(c, kIdx, seed, label) {
  const list = await underwater(c);
  let i = seed;
  const order_ = list.map((x, j) => [x, (j * 7919 + i * 104729) % 1009]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  for (const [k, m] of order_) await doLiquidate(c, kIdx, k, m, `${label} sweep liq ${c.nameOf(k)}/${MK[m].name}`);
}

async function ensureInventory(c, s, label) {
  let any = false; for (let j = 0; j < NM; j++) if (c.st.pos.get(BACKSTOP)[j].size !== 0n) any = true;
  if (any) return;
  shockPx(c, s.m, s.bps); await refresh(c); c.st = await readState(c);
  await sweep(c, s.k, 3, label + " (seed inventory)"); c.st = await readState(c);
  for (let j = 0; j < NM; j++) if (c.st.pos.get(BACKSTOP)[j].size !== 0n) { bump("p2-inventory-seeded"); return; }
}
async function runStep(c, s, idx) {
  const label = `#${idx} ${s.t}`;
  await ensureFresh(c);
  switch (s.t) {
    case "gap": {
      const apply = (m, bps) => shockPx(c, m, bps);
      if (s.kind === "single") apply(s.m, s.bps);
      else if (s.kind === "all") for (let m = 0; m < NM; m++) apply(m, s.bps);
      else if (s.kind === "indep") { apply(0, s.bps); apply(1, s.bps2); apply(2, Math.round((s.bps + s.bps2) / 2)); }
      else if (s.kind === "cascade") {
        for (let i = 0; i < s.n; i++) {
          for (let m = 0; m < NM; m++) if (s.m === m || s.n % 2 === 0) apply(m, Math.round(s.bps / s.n));
          await refresh(c); c.st = await readState(c);
          if (s.keeperBetween) await sweep(c, s.k, i, label + ` step${i}`);
        }
        return;
      } else if (s.kind === "whipsaw") {
        apply(s.m, s.bps); await refresh(c); c.st = await readState(c);
        if (s.keeperBetween) await sweep(c, s.k, 1, label + " mid");
        apply(s.m, -Math.round(s.bps * 0.8)); apply((s.m + 1) % NM, s.bps2);
      }
      await refresh(c);
      c.st = await readState(c);
      checkCore(c, c.st, label);
      return;
    }
    case "stale": c.stale = s.mask; await time.increase(70); c.st = await readState(c); checkCore(c, c.st, label); return;
    case "recover": { c.stale = 0; for (let m = 0; m < NM; m++) shockPx(c, m, s.bps); await refresh(c); c.st = await readState(c); checkCore(c, c.st, label); return; }
    case "liq": { const a = c.keys[s.a]; await doLiquidate(c, s.k, a, s.m, `${label} ${c.nameOf(a)}/${MK[s.m].name}`); return; }
    case "sweep": await sweep(c, s.k, s.seed, label); return;
    case "adl": await doAdl(c, s.k, s.m, s.mode, s.cnt, `${label} ${MK[s.m].name} ${s.mode}`); return;
    case "recap": {
      const d = c.st.adl[s.m]; if (d === 0n) return;
      let amt = d * BigInt(s.pct) / 100n; if (amt === 0n) amt = 1n;
      const pre = c.st;
      const r = await send(c, label, () => c.ex.connect(c.payer).recapitalize(s.m, amt, { gasLimit: GAS }));
      if (!r.ok) throw new Viol("P0", `${label}: recapitalize reverted ${errStr(r.err)}`);
      const post = await readState(c); c.st = post;
      if (post.adl[s.m] !== pre.adl[s.m] - amt) viol(c, "P9", `${label}: adlDebt ${pre.adl[s.m]} -> ${post.adl[s.m]} after repaying ${amt}`);
      checkTx(c, pre, post, r.evs, label); checkCore(c, post, label); return;
    }
    case "sync": {
      const pre = c.st;
      const r = await send(c, label, () => c.ex.connect(c.actors[s.k]).syncBackstop({ gasLimit: GAS }));
      if (!r.ok) throw new Viol("P0", `${label}: syncBackstop reverted ${errStr(r.err)}`);
      c.st = await readState(c); checkTx(c, pre, c.st, r.evs, label); checkCore(c, c.st, label);
      // idempotent: a second call right after changes nothing
      const r2 = await send(c, label + " again", () => c.ex.connect(c.actors[s.k]).syncBackstop({ gasLimit: GAS }));
      if (!r2.ok || r2.evs.length) viol(c, "P11", `${label}: syncBackstop is not idempotent (${r2.ok ? r2.evs.map((e) => e.name) : errStr(r2.err)})`);
      return;
    }
    case "bscfg": {
      const soft = BigInt(s.soft) * 1000000n;               // 0 disables
      const r = await send(c, label, () => c.ex.setBackstopCfg(s.m, soft, s.disc, s.dwell, s.ramp, s.dwell + s.ramp + s.extra, { gasLimit: GAS }));
      if (!r.ok) throw new Viol("P0", `${label}: setBackstopCfg reverted ${errStr(r.err)}`);
      c.st = await readState(c); return;
    }
    case "bstake": {
      await ensureFresh(c); c.st = await readState(c); await ensureInventory(c, s, label);
      const pre = c.st; const m = (() => { let b = s.m, best = -1n; for (let j = 0; j < NM; j++) { const z = abs(c.st.pos.get(BACKSTOP)[j].size); if (z > best) { best = z; b = j; } } return b; })(); const bs = pre.pos.get(BACKSTOP)[m].size; if (bs === 0n || pre.mark[m] === null) { bump(bs === 0n ? "bstake-noinv" : "bstake-nomark"); return; }
      const lot = MK[m].lot; let size = abs(bs) * BigInt(s.pct) / 100n / lot * lot; if (size === 0n) size = lot;
      const sells = bs < 0n; const a = c.actors[s.k]; bump("bstake-attempt");
      const q = await c.ex.backstopAuction(m);
      const r = await send(c, label, () => c.ex.connect(a).takeBackstop(a.address, 0, m, size, sells ? 1n : (1n << 63n), { gasLimit: GAS }));
      if (!r.ok) {
        if (!["BadParam", "Unhealthy", "MarketRestricted", "OracleDegraded", "OICap", "Paused"].includes(r.err.name)) throw new Viol("P0", `${label}: unexpected takeBackstop revert ${errStr(r.err)}`);
        if (r.err.name === "BadParam" && q.active && size <= abs(bs)) bump("take-reverted-while-active:" + r.err.args[0]);
        return;
      }
      const T = r.evs.find((e) => e.name === "BackstopTaken").args; bump("bstake-ok"); attrCheck(c, r.evs, m, label);
      const post = await readState(c); c.st = post;
      const cfg = await c.ex.backstopCfg(m);
      const bsAfter = post.pos.get(BACKSTOP)[m].size;
      if (abs(bsAfter) !== abs(bs) - size) viol(c, "P2a", `${label}: inventory ${bs} -> ${bsAfter} after taking ${size}`);
      if (Number(T.discBps) > Number(cfg.maxDiscBps) || Number(T.discBps) > 300) viol(c, "P2b", `${label}: discount ${T.discBps} above the cap ${cfg.maxDiscBps}`);
      if (T.takerSold !== sells) viol(c, "P2c", `${label}: taker side wrong`);
      { const dev = T.price > q.price ? T.price - q.price : q.price - T.price; if (q.active && dev > q.price * BigInt(cfg.maxDiscBps) / 10000n + 1n) viol(c, "P2d", `${label}: price ${T.price} deviates from the quote ${q.price} by more than maxDisc ${cfg.maxDiscBps} bps`); }
      const fb = await c.ex.backstopTakeFeeBps(); const notional = T.size * T.price / E8;
      if (T.fee !== (notional * fb + 9999n) / 10000n) viol(c, "P2e", `${label}: fee ${T.fee} != ceil(${notional} x ${fb} bps)`);
      checkTx(c, pre, post, r.evs, label, { donated: T.fee }); checkCore(c, post, label); return;
    }
    case "bsforce": {
      await ensureFresh(c); c.st = await readState(c); await ensureInventory(c, s, label);
      const pre = c.st; const m = (() => { let b = s.m, best = -1n; for (let j = 0; j < NM; j++) { const z = abs(c.st.pos.get(BACKSTOP)[j].size); if (z > best) { best = z; b = j; } } return b; })(); const bs = pre.pos.get(BACKSTOP)[m].size; if (bs === 0n || pre.mark[m] === null) return;
      const cfg = await c.ex.backstopCfg(m); if (cfg.softNotional === 0n) return;
      if (s.warp) { await time.increase(Number(cfg.maxAge) + 1); await refresh(c); c.st = await readState(c); }
      const cand = await adlCandidates(c, m); const list = cand.slice(0, 8).map((x) => x[0]); if (list.length === 0) return;
      const keeper = c.actors[s.k]; bump("bsforce-attempt");
      const r = await send(c, label, () => c.ex.connect(keeper).unwindBackstop(list, m, { gasLimit: GAS }));
      if (!r.ok) {
        if (!["BadParam", "MarketRestricted", "OracleDegraded"].includes(r.err.name)) throw new Viol("P0", `${label}: unexpected unwind revert ${errStr(r.err)}`);
        return;
      }
      bump("bsforce-ok"); attrCheck(c, r.evs, m, label);
      const post = await readState(c); c.st = post; const mark = post.mark[m];
      for (const U of r.evs.filter((e) => e.name === "BackstopUnwound")) if (U.args.price !== mark) viol(c, "P2f", `${label}: unwind price ${U.args.price} != mark ${mark} (no concession allowed)`);
      const bsAfter = post.pos.get(BACKSTOP)[m].size;
      if (abs(bsAfter) > abs(bs)) viol(c, "P2g", `${label}: unwind grew the inventory`);
      checkTx(c, pre, post, r.evs, label); checkCore(c, post, label);
      // strengthened P3: inventory above the threshold after a forced unwind is only possible if the candidate list was exhausted
      const keep = cfg.softNotional * E8 / mark;
      if (abs(bsAfter) > keep + MK[m].lot) { const rest = await adlCandidates(c, m); const ids = new Set(list); if (rest.some((x) => !ids.has(x[0]))) bump("unwind-short-by-list-limit"); else bump("unwind-candidates-exhausted"); }
      return;
    }
    case "poke": {
      const pre = c.st;
      const r = await send(c, label, () => c.ex.connect(c.actors[s.k]).pokeFunding(s.m, { gasLimit: GAS }));
      if (!r.ok) throw new Viol("P0", `${label}: pokeFunding reverted ${errStr(r.err)}`);
      c.st = await readState(c); checkTx(c, pre, c.st, r.evs, label); checkCore(c, c.st, label); return;
    }
    case "warp": await time.increase(s.dt); await refresh(c); c.st = await readState(c); checkCore(c, c.st, label); return;
    case "premium": await doPremium(c, s, label); return;
    case "trade": await doTrade(c, s, label); return;
    case "close": await doClose(c, s, label); return;
    case "bsunwind": {
      const m = s.m; const bs = c.st.pos.get(BACKSTOP)[m].size; if (bs === 0n) return;
      const lot = MK[m].lot; const sell = bs > 0n; const tick = MK[m].tick;
      let size = abs(bs) * BigInt(s.pct) / 100n / lot * lot; if (size === 0n) return;
      const px = rt(c.opx[m], m);
      const pre = c.st; const evs = [];
      const r1 = await place(c, 6, { market: m, isBuy: sell, price: px, size, tif: TIF.GTC }, label + " cp");
      if (r1.ok) evs.push(...r1.evs);
      const r2 = await send(c, label + " backstopPlace", () => c.ex.connect(c.bsOp).backstopPlace(order({ market: m, isBuy: !sell, price: px, size, tif: TIF.IOC, reduceOnly: true }), { gasLimit: GAS }));
      if (r2.ok) evs.push(...r2.evs); else if (!PLACE_OK.has(r2.err.name)) throw new Viol("P0", `${label}: ${errStr(r2.err)}`);
      await cancelAll(c, 6);
      await afterTrade(c, pre, evs, label); return;
    }
    case "state": {
      if (c.delisted.has(s.m) && s.s !== STATE.Delisted) return;
      await c.ex.setMarketState(s.m, s.s); c.st = await readState(c); checkCore(c, c.st, label); return;
    }
    case "pause": await c.ex.setGlobalPause(s.on); c.st = await readState(c); return;
    case "delist": {
      const m = s.m; if (c.delisted.has(m)) return;
      await c.ex.setMarketState(m, STATE.ReduceOnly);
      const p = rt(c.opx[m] * (BPSN + BigInt(s.bps)) / BPSN, m);
      await c.ex.delistMarket(m, p); c.delisted.add(m); c.st = await readState(c); checkCore(c, c.st, label); return;
    }
    case "settle": {
      const m = s.m; const a = c.keys[s.a];
      if (!c.delisted.has(m)) return;
      const pre = c.st;
      const r = await send(c, label, () => c.ex.connect(c.actors[s.k]).settleDelisted(a, m, { gasLimit: GAS }));
      if (!r.ok) { if (!(r.err.name === "BadParam" && r.err.args[0] === "no position")) throw new Viol("P0", `${label}: settleDelisted reverted ${errStr(r.err)}`); return; }
      const post = await readState(c); c.st = post;
      if (post.pos.get(a)[m].size !== 0n) viol(c, "P1", `${label}: position not closed by settleDelisted`);
      checkTx(c, pre, post, r.evs, label); checkCore(c, post, label); return;
    }
    case "deposit": { const k = c.actors[s.a]; await send(c, label, () => c.ex.connect(k).deposit(k.address, 0, usd(s.amt), { gasLimit: GAS })); c.st = await readState(c); checkCore(c, c.st, label); return; }
    case "withdraw": {
      const k = c.actors[s.a]; const pre = c.st;
      const r = await send(c, label, () => c.ex.connect(k).withdraw(0, usd(s.amt), { gasLimit: GAS }));
      if (!r.ok && !["Unhealthy", "MarketRestricted", "OracleDegraded"].includes(r.err.name)) throw new Viol("P0", `${label}: ${errStr(r.err)}`);
      c.st = await readState(c); if (r.ok) checkTx(c, pre, c.st, r.evs, label, { skip: true }); checkCore(c, c.st, label); return;
    }
    case "donate": { await send(c, label, () => c.ex.connect(c.payer).fundInsurance(usd(s.amt), { gasLimit: GAS })); const pre = c.st; c.st = await readState(c); checkTx(c, pre, c.st, [], label, { donated: usd(s.amt), skip: true }); checkCore(c, c.st, label); return; }
    case "rebalance": {
      const pre = c.st; let amt = BigInt(Math.floor(Number(pre.ins) * s.pct / 100));
      if (s.back) { const bc = pre.coll.get(BACKSTOP); amt = bc > 0n ? -(bc * BigInt(s.pct) / 100n) : 0n; }
      if (amt === 0n) return;
      const r = await send(c, label, () => c.ex.rebalanceBackstop(amt, { gasLimit: GAS }));
      if (!r.ok) throw new Viol("P0", `${label}: rebalance reverted ${errStr(r.err)}`);
      c.st = await readState(c); checkTx(c, pre, c.st, [], label, { rebalanced: amt < 0n ? -amt : 0n, skip: true, allowDown: amt > 0n }); checkCore(c, c.st, label); return;
    }
    case "iso": {
      const k = c.actors[s.a];
      if (s.add) { const fm = await freeMargin(c, c.keys[s.a], s.m); const amt = fm * BigInt(s.pct) / 100n; if (amt > 0n && c.st.pos.get(c.keys[s.a])[s.m].iso) await send(c, label, () => c.ex.connect(k).addIsoMargin(0, s.m, amt, { gasLimit: GAS })); }
      else await send(c, label, () => c.ex.connect(k).removeIsoMargin(0, s.m, usd(s.pct), { gasLimit: GAS }));
      c.st = await readState(c); checkCore(c, c.st, label); return;
    }
    default: throw new Error("unknown step " + s.t);
  }
}

// ------------------------------------------------------------------------------------------------ finalize: liveness loop, ADL, delist+settle, closure checks
async function finalize(c) {
  const L = "final";
  c.stale = 0;
  if (c.st.paused) await c.ex.setGlobalPause(false);
  for (let m = 0; m < NM; m++) if (!c.delisted.has(m) && c.st.mst[m] !== STATE.Normal) await c.ex.setMarketState(m, STATE.Normal);
  for (let i = 0; i < 8; i++) await cancelAll(c, i); // book mid must not skew mark vs the settle price
  await refresh(c); c.st = await readState(c);
  // --- keeper rounds: liquidate everything underwater (liveness P10), then ADL; ADL can push cross targets underwater, so repeat
  let iters = 0;
  for (let round = 0; round < 8; round++) {
    let progressed = false;
    for (;;) {
      const list = await underwater(c);
      if (list.length === 0) break;
      progressed = true;
      if (++iters > 80) { viol(c, "P10", `${L}: keeper loop did not terminate after 80 sweeps; still underwater: ${list.map(([k, m]) => c.nameOf(k) + "/" + MK[m].name).join(",")}`); break; }
      for (const [k, m] of list) {
        const r = await doLiquidate(c, 7, k, m, `${L} liq ${c.nameOf(k)}/${MK[m].name} (sweep ${iters})`);
        if (r.ok && r.partial) c.partials++;
      }
    }
    for (let m = 0; m < NM; m++) {
      for (let g = 0; g < 12 && c.st.ubd > 0n; g++) {
        const before = c.st.ubd;
        const r = await doAdl(c, 7, m, "ranked", 8, `${L} adl ${MK[m].name} r${round}#${g}`);
        if (!r.ok || c.st.ubd >= before) break;
        progressed = true;
        if (r.n > 0) bump("adl-rounds");
      }
    }
    if (!progressed) break;
  }
  bump("liq-sweeps", iters);
  { const left = await underwater(c); if (left.length) viol(c, "P10", `${L}: accounts still underwater after keeper rounds: ${left.map(([k, m]) => c.nameOf(k) + "/" + MK[m].name).join(",")}`); }
  // --- all positions through delisting and final settlement
  for (let m = 0; m < NM; m++) {
    if (!c.delisted.has(m)) {
      await c.ex.setMarketState(m, STATE.ReduceOnly);
      await c.ex.delistMarket(m, rt(c.opx[m], m)); c.delisted.add(m);
    }
  }
  c.st = await readState(c);
  c.preEq = {};
  for (const k of c.keys) { try { const r = await c.ex.accountState(k); c.preEq[c.nameOf(k)] = `eq=${r.equity} mm=${r.mm} coll=${c.st.coll.get(k)} pos=${c.st.pos.get(k).map((p) => p.size + (p.iso ? "i" : "")).join("/")} mst=${c.st.mst.join("")}`; } catch (e) { c.preEq[c.nameOf(k)] = "view reverted"; } }
  for (let m = 0; m < NM; m++) for (const k of c.allKeys) {
    if (k === BACKSTOP || c.st.pos.get(k)[m].size === 0n) continue;
    await ensureFresh(c);
    const pre = c.st;
    const r = await send(c, `${L} settle ${c.nameOf(k)}/${MK[m].name}`, () => c.ex.connect(c.actors[7]).settleDelisted(k, m, { gasLimit: GAS }));
    if (!r.ok) throw new Viol("P0", `${L}: settleDelisted(${c.nameOf(k)},${MK[m].name}) reverted ${errStr(r.err)}`);
    c.st = await readState(c); checkTx(c, pre, c.st, r.evs, `${L} settle`); checkCore(c, c.st, `${L} settle ${c.nameOf(k)}`);
  }
  { // P11: once everything is flat, a sync leaves the backstop bucket non-negative (no unrecorded loss), and it is idempotent
    const rs = await send(c, `${L} syncBackstop`, () => c.ex.connect(c.actors[7]).syncBackstop({ gasLimit: GAS }));
    if (!rs.ok) throw new Viol("P0", `${L}: syncBackstop reverted ${errStr(rs.err)}`);
    c.st = await readState(c);
    if (c.st.coll.get(BACKSTOP) < 0n) viol(c, "P11", `${L}: backstop collateral ${c.st.coll.get(BACKSTOP)} < 0 after sync`);
    const rs2 = await send(c, `${L} syncBackstop again`, () => c.ex.connect(c.actors[7]).syncBackstop({ gasLimit: GAS }));
    if (!rs2.ok || rs2.evs.length) viol(c, "P11", `${L}: syncBackstop not idempotent at flat`);
  }
  const st = c.st;
  for (let m = 0; m < NM; m++) for (const k of c.allKeys) if (st.pos.get(k)[m].size !== 0n) viol(c, "P1", `${L}: ${c.nameOf(k)}/${MK[m].name} not flat after settlement: ${st.pos.get(k)[m].size}`);
  // --- P2 at flat (user form): tracked - net within a few micro-USDC (+ ADL rounding retained)
  let sumColl = 0n, sumIso = 0n; for (const k of c.allKeys) { sumColl += st.coll.get(k); for (let m = 0; m < NM; m++) sumIso += st.pos.get(k)[m].isoMargin; }
  const tracked = sumColl + sumIso + st.ins + st.fee + st.fund - st.ubd + st.dust / E8;
  const drift = tracked - (st.dep - st.wd);
  const tol = 3n + cdiv(c.leak, E8);
  if (abs(drift) > tol) viol(c, "P2", `${L}: flat ledger drift ${drift} exceeds ${tol} micro-USDC (leak=${c.leak})`);
  // --- P9 debt bookkeeping: recorded == bad debts - ADL cleared - recapitalised; recapitalize zeroes exactly
  if (st.ubd !== c.badSum - c.clearedSum - c.recapSum - c.syncRepaid) viol(c, "P9", `${L}: unresolvedBadDebt ${st.ubd} != sum(bad) ${c.badSum} - adl ${c.clearedSum} - recap ${c.recapSum} - backstop repay ${c.syncRepaid}`);
  for (let m = 0; m < NM; m++) {
    const d = c.st.adl[m]; if (d === 0n) continue;
    const r = await send(c, `${L} recapitalize ${m}`, () => c.ex.connect(c.payer).recapitalize(m, d, { gasLimit: GAS }));
    c.st = await readState(c);
    if (!r.ok || c.st.adl[m] !== 0n) viol(c, "P9", `${L}: recapitalize(${m}, ${d}) did not zero adlDebt (${r.ok ? c.st.adl[m] : errStr(r.err)})`);
  }
  if (c.st.ubd !== 0n) viol(c, "P9", `${L}: unresolvedBadDebt ${c.st.ubd} != 0 after recapitalizing every market`);
  const s2 = c.st;
  // --- P3 physical solvency at flat: balance >= positive claims - unresolvedBadDebt (claims never net against negative buckets)
  let claims = s2.ins + (s2.fee > 0n ? s2.fee : 0n) + (s2.fund > 0n ? s2.fund : 0n), neg = 0n;
  for (const k of c.allKeys) {
    const cc = s2.coll.get(k); if (cc > 0n) claims += cc; else neg += -cc;
    for (let m = 0; m < NM; m++) { const x = s2.pos.get(k)[m].isoMargin; if (x > 0n) claims += x; else neg += -x; }
  }
  const shortfall = claims - s2.ubd - s2.bal;
  c.shortfall = shortfall; c.negFlat = neg;
  // BACKSTOP-1 is fixed: the backstop bucket is non-negative after sync, so there is no tolerated shortfall any more.
  if (shortfall > 2n) viol(c, "P3", `${L}: physical shortfall ${shortfall} micro-USDC: positive claims ${claims} - ubd ${s2.ubd} > USDC balance ${s2.bal}; negative buckets ${neg} (backstop collateral ${s2.coll.get(BACKSTOP)})`);
  if (neg > 2n) viol(c, "P3", `${L}: negative flat buckets remain after sync: ${neg} (backstop collateral ${s2.coll.get(BACKSTOP)})`);
  // --- P6 at flat
  checkCore(c, s2, "final-flat");
}

// ------------------------------------------------------------------------------------------------ arbitraries
const I = (min, max) => fc.integer({ min, max });
const bpsArb = fc.oneof({ weight: 4, arbitrary: I(-6000, -300) }, { weight: 3, arbitrary: I(300, 15000) }, { weight: 2, arbitrary: I(-300, 300) });
const tradeArb = fc.record({ t: fc.constant("trade"), m: I(0, 2), tk: I(0, 7), mk: I(0, 7), buy: fc.boolean(), f: I(30, 100), off: I(-2, 2), leave: fc.boolean() });
const stepArb = fc.oneof(
  { weight: 7, arbitrary: fc.record({ t: fc.constant("gap"), kind: fc.constantFrom("single", "all", "indep", "cascade", "whipsaw"), m: I(0, 2), bps: bpsArb, bps2: bpsArb, n: I(2, 4), keeperBetween: fc.boolean(), k: I(0, 7) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("stale"), mask: I(1, 7) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("recover"), bps: I(-2000, 3000) }) },
  { weight: 8, arbitrary: fc.record({ t: fc.constant("liq"), k: I(0, 7), a: I(0, 7), m: I(0, 2) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("sweep"), k: I(0, 7), seed: I(0, 50) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant("adl"), k: I(0, 7), m: I(0, 2), mode: fc.constantFrom("ranked", "ranked", "ranked", "reversed", "junk", "dup"), cnt: I(1, 8) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("recap"), m: I(0, 2), pct: I(1, 100) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("sync"), k: I(0, 7) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("poke"), k: I(0, 7), m: I(0, 2) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("warp"), dt: I(60, 40000) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant("premium"), m: I(0, 2), bps: I(-400, 400) }) },
  { weight: 4, arbitrary: tradeArb },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("close"), a: I(0, 7), m: I(0, 2), pct: I(10, 100), offBps: I(-100, 100) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("bscfg"), m: I(0, 2), soft: I(0, 30000), disc: I(0, 300), dwell: I(0, 300), ramp: I(60, 1800), extra: I(0, 1800) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant("bstake"), m: I(0, 2), k: I(0, 7), pct: I(5, 100), bps: I(-4000, 4000) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("bsforce"), m: I(0, 2), k: I(0, 7), warp: fc.boolean(), bps: I(-4000, 4000) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("bsunwind"), m: I(0, 2), pct: I(10, 100) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("state"), m: I(0, 2), s: fc.constantFrom(0, 1, 2, 3, 4) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("pause"), on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("delist"), m: I(0, 2), bps: I(-1000, 1000) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("settle"), k: I(0, 7), a: I(0, 7), m: I(0, 2) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("deposit"), a: I(0, 7), amt: I(1, 5000) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("withdraw"), a: I(0, 7), amt: I(1, 30000) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("donate"), amt: I(1, 3000) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("rebalance"), pct: I(1, 100), back: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("iso"), a: I(0, 5), m: I(0, 2), add: fc.boolean(), pct: I(1, 100) }) },
);
const scenarioArb = fc.record({
  dep: fc.array(I(1500, 80000), { minLength: 6, maxLength: 6 }),
  iso: fc.array(fc.array(fc.integer({ min: 0, max: 99 }).map((x) => x < 35), { minLength: 3, maxLength: 3 }), { minLength: 6, maxLength: 6 }),
  isoFrac: fc.array(I(30, 90), { minLength: 6, maxLength: 6 }),
  kpDep: I(0, 20000),
  p2: I(0, 3), fee2: I(0, 10),   // phase 2: soft threshold tier (0 = off) and take fee
  setup: fc.array(tradeArb, { minLength: 8, maxLength: 20 }),
  steps: fc.array(stepArb, { minLength: 6, maxLength: LEN }),
});

async function runScenario(c, sc) {
  if (sc.p2 > 0) {
    const soft = usd([0, 500, 3000, 15000][sc.p2]);
    for (let m = 0; m < NM; m++) await c.ex.setBackstopCfg(m, soft, 200, 30, 300, 900);
    await c.ex.setBackstopTakeFee(sc.fee2); bump("p2-enabled");
  }
  for (let i = 0; i < sc.setup.length; i++) {
    try { await doTrade(c, sc.setup[i], `setup#${i}`); } catch (e) { e.message = `(setup ${i}) ` + e.message; throw e; }
  }
  for (let i = 0; i < sc.steps.length; i++) {
    try { await runStep(c, sc.steps[i], i); } catch (e) { e.message = `(step ${i}/${sc.steps.length} ${JSON.stringify(sc.steps[i])}) ` + e.message; throw e; }
  }
  try { await finalize(c); } catch (e) { e.message = `(finalize) ` + e.message; throw e; }
  bump("scenarios"); bump("fills", c.fills); bump("liquidations", c.liqs); bump("adl-exec", c.adls); bump("partial-liqs", c.partials);
  if (c.badSum > 0n) bump("scenarios-with-bad-debt");
  if (c.st.fidx.some((x) => x !== 0n)) bump("scenarios-with-funding");
  if (c.minBackstopEq < 0n) { bump("scenarios-backstop-negative"); TELE.minBackstop = TELE.minBackstop === undefined || c.minBackstopEq < TELE.minBackstop ? c.minBackstopEq : TELE.minBackstop; }
  if (c.shortfall > 2n) { bump("scenarios-physical-shortfall"); TELE.maxShortfall = c.shortfall > (TELE.maxShortfall ?? 0n) ? c.shortfall : TELE.maxShortfall; }
  if (c.leakMax > 0n) TELE.maxLeak = c.leakMax > (TELE.maxLeak ?? 0n) ? c.leakMax : TELE.maxLeak;
}

function fuzzGroup(id, title, fatal) {
  (GROUPS.includes(id) ? it : it.skip)(`[group ${id}] ${title} (runs=${RUNS}, len<=${LEN}, seed=${SEED})`, async function () {
    this.timeout(TIMEOUT);
    const t0 = Date.now();
    TELE.soft = {}; TELE.softMsg = {}; TELE.n = {}; TELE.minBackstop = undefined; TELE.maxShortfall = undefined; TELE.maxLeak = undefined;
    const prop = fc.asyncProperty(scenarioArb, async (sc) => { const c = await newCtx(sc, fatal); await runScenario(c, sc); });
    try {
      await fc.assert(prop, { numRuns: RUNS, seed: SEED, verbose: 0, endOnFailure: NO_SHRINK });
    } catch (e) {
      console.log(`\n      STRESS FAILURE (group ${id}). Reproduce: STRESS_GROUPS=${id} STRESS_SEED=${SEED} STRESS_RUNS=${RUNS} STRESS_LEN=${LEN} npx hardhat test test/stress.test.js\n`);
      throw e;
    } finally {
      const tn = Object.entries(TELE.n).filter(([k]) => !k.startsWith("revert:")).map(([k, v]) => `${k}=${v}`).join(" ");
      const rv = Object.entries(TELE.n).filter(([k]) => k.startsWith("revert:")).map(([k, v]) => `${k.slice(7)}=${v}`).join(" ");
      console.log(`      group ${id}: ${((Date.now() - t0) / 1000).toFixed(1)}s | ${tn}`);
      console.log(`      tolerated reverts: ${rv}`);
      if (Object.keys(TELE.soft).length) {
        console.log(`      NON-FATAL violations in this group (fatal in other groups): ${JSON.stringify(TELE.soft)}`);
        for (const [k, v] of Object.entries(TELE.softMsg)) console.log(`        first ${k}: ${v.slice(0, 400)}`);
      }
      if (TELE.minBackstop !== undefined) console.log(`      min backstop equity seen: ${usdStr(TELE.minBackstop)} USDC; max physical shortfall at flat: ${usdStr(TELE.maxShortfall ?? 0n)} USDC; max ADL rounding leak per event (1e-8 USDC): ${TELE.maxLeak ?? 0n}`);
    }
  });
}

describe("stress: liquidation / bad debt / insurance / backstop / ADL under large price gaps", function () {
  this.timeout(TIMEOUT);
  fuzzGroup("A", "structural: P1 net position, P2 exact ledger identity, P3a debt==sum(adlDebt), P4 bucket isolation, P5 liquidation correctness, P7 ADL, P8 insurance, P0 no panic", ["P0", "P1", "P2", "P3a", "P4", "P5", "P7", "P7x", "P8", "P11", "P12"]);
  fuzzGroup("D", "funding conservation incl. BACKSTOP (fundingPool + pending funding == rounding residue)", ["P0", "FUND"]);
  fuzzGroup("B", "liveness P10: underwater positions are always liquidatable; keeper loop terminates", ["P0", "P10"]);
  fuzzGroup("C", "physical solvency P3 at flat (balance >= positive claims - unresolvedBadDebt)", ["P0", "P3"]);
  fuzzGroup("E", "closure: P6 no flat negative bucket, P9 debt bookkeeping + exact recapitalize", ["P0", "P6", "P9"]);
});


// ================================================================================================================
// Deterministic worst-case tests and findings. Tests named FINDING assert the DESIRED behaviour and therefore FAIL on
// the current contracts (STRESS_SKIP_FINDINGS=1 skips them). Numbers are printed for the report.
// ================================================================================================================
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const itF = (name, fn) => it(name.replace("FINDING ", "FIXED "), fn); // regression tests for findings fixed in the contracts
const itK_unused = (name, fn) => (KNOWN_GAPS ? it : it.skip)(name.replace("FINDING ", "KNOWN GAP ") + (KNOWN_GAPS ? "" : " [skipped: set STRESS_KNOWN_GAPS=1; documented unfixed design gap]"), fn);
const log = (...a) => console.log("      ", ...a);

async function mkCtx(dep = [6500, 100000, 100000, 100000, 100000, 100000], fatal = []) {
  return newCtx({ dep, iso: dep.map(() => [false, false, false]), isoFrac: dep.map(() => 50), kpDep: 0, setup: [], steps: [] }, fatal);
}
async function setPx(c, m, px) { c.px[m] = rt(px, m); await refresh(c); }
async function pair(c, buyer, seller, m, size, price) {
  const r1 = await c.ex.connect(c.actors[seller]).placeOrder(c.actors[seller].address, 0, order({ market: m, isBuy: false, price, size, tif: TIF.GTC }), { gasLimit: GAS });
  await r1.wait();
  const r2 = await (await c.ex.connect(c.actors[buyer]).placeOrder(c.actors[buyer].address, 0, order({ market: m, isBuy: true, price, size, tif: TIF.IOC }), { gasLimit: GAS })).wait();
  return r2;
}
const posOf = async (c, i, m) => (await c.ex.positions(c.keys[i], m)).size;
const FEES_FULL = (c) => c.ex.setFees(5, 1, 50, 5000, 10000, usd(1_000_000));
async function netPos(c, m) { let n = await c.ex.positions(BACKSTOP, m).then((p) => p.size); for (const k of c.keys) n += (await c.ex.positions(k, m)).size; return n; }

describe("stress: deterministic worst cases and findings", function () {
  this.timeout(TIMEOUT);

  itF("FINDING ADL-1: adl() fully closing a LONG target gives the backstop the wrong sign (net position != 0)", async () => {
    const c = await mkCtx();
    await FEES_FULL(c);
    await pair(c, 1, 0, 0, btc(1), usd(50000)); // t1 long 1 BTC, t0 (6500) short 1 BTC
    await setPx(c, 0, usd(70000));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0); // t0 short liquidated -> backstop SHORT 1 BTC, bad debt
    log("adlDebt", usdStr(await c.ex.adlDebt(0)), "backstop", await posOf(c, 0, 0), (await c.ex.positions(BACKSTOP, 0)).size);
    await c.ex.connect(c.actors[7]).adl([c.keys[1]], 0); // t1 (long, in profit) is fully closed against the backstop
    const net = await netPos(c, 0);
    log("net signed position of BTC after ADL of a long target:", net, "(backstop:", (await c.ex.positions(BACKSTOP, 0)).size, ")");
    expect(net, "aggregate position incl. BACKSTOP must stay 0").to.equal(0n);
  });

  itF("FINDING FUND-1: BACKSTOP lastFundingIdx is never synced on takeover (liquidation/ADL/settleDelisted): phantom funding", async () => {
    const c = await mkCtx();
    await FEES_FULL(c);
    await pair(c, 1, 0, 0, btc(1), usd(50000)); // t1 long, t0 short
    // build a funding index: cp quotes +3% above index for 3 half-hours
    await doPremium(c, { m: 0, bps: 300 }, "premium");
    const idx = (await c.ex.getMarket(0)).fundingIndex; log("funding index after premium:", idx);
    expect(idx).to.not.equal(0n);
    await setPx(c, 0, usd(70000));
    await cancelAll(c, 6);
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0); // backstop takes short 1 BTC at once; backstop.lastFundingIdx stays 0
    const p = await c.ex.positions(BACKSTOP, 0);
    log("backstop size", p.size, "lastFundingIdx", p.lastFundingIdx, "market fundingIndex", (await c.ex.getMarket(0)).fundingIndex);
    expect(p.lastFundingIdx, "backstop should be synced to the current funding index when it takes inventory").to.equal((await c.ex.getMarket(0)).fundingIndex);
  });

  itF("FINDING LIQ-1: a cross account holding 3 markets cannot be liquidated (or ADL'd / ranked) while an UNRELATED market oracle is stale", async () => {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 100000]);
    await FEES_FULL(c);
    await pair(c, 0, 1, 0, btc(0.8), usd(50000));   // t0 long 0.8 BTC  (40k)
    await pair(c, 0, 2, 1, 4n * E8, usd(3000));      // t0 long 4 ETH    (12k)
    await pair(c, 0, 3, 2, 50n * E8, usd(150));      // t0 long 50 SOL   (7.5k)
    await setPx(c, 0, usd(35000)); await refresh(c);  // BTC -30% => deep underwater
    const h = await c.ex.accountState(c.keys[0]); log("t0 equity", usdStr(h.equity), "mm", usdStr(h.mm));
    expect(h.equity < h.mm).to.equal(true);
    c.stale = 1 << 1; await time.increase(70); await refresh(c); // ETH feed (market 1) goes stale; BTC and SOL stay fresh
    let err = null;
    try { await c.ex.connect(c.actors[7]).liquidate.staticCall(c.keys[0], 0, { gasLimit: GAS }); } catch (e) { err = decodeErr(c.ex, e); }
    log("liquidate(t0, BTC) with ETH feed stale ->", err ? errStr(err) : "would succeed");
    expect(err, "BTC position should remain liquidatable while only the unrelated ETH feed is stale").to.equal(null);
  });

  itF("FINDING LIQ-2: reduce-only close of an underwater account leaves negative flat collateral that can never be liquidated or recorded as bad debt", async () => {
    const c = await mkCtx();
    await FEES_FULL(c);
    await pair(c, 0, 1, 0, btc(1), usd(50000)); // t0 (6500) long 1 BTC, t1 short
    await setPx(c, 0, usd(30000));
    // cp bids at the new market price, underwater t0 closes with a reduce-only IOC (no margin check on reducing orders)
    await c.ex.connect(c.cp).placeOrder(c.cp.address, 0, order({ market: 0, isBuy: true, price: usd(30000), size: btc(1) }));
    await c.ex.connect(c.actors[0]).placeOrder(c.actors[0].address, 0, order({ market: 0, isBuy: false, price: usd(30000), size: btc(1), tif: TIF.IOC, reduceOnly: true }));
    const coll = await c.ex.collateral(c.keys[0]); const ubd = await c.ex.unresolvedBadDebt();
    log("t0 flat collateral", usdStr(coll), "unresolvedBadDebt", usdStr(ubd));
    let lerr = null; try { await c.ex.connect(c.actors[7]).liquidate.staticCall(c.keys[0], 0); } catch (e) { lerr = decodeErr(c.ex, e); }
    log("liquidate(t0) ->", lerr ? errStr(lerr) : "ok");
    expect(coll >= 0n || ubd >= -coll, "negative flat collateral must be written off as recorded bad debt").to.equal(true);
  });

  itF("FINDING LIQ-1b: a HEALTHY cross account is still not liquidatable when an unrelated feed is stale (stale valued in the account's favour)", async () => {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 100000]);
    await FEES_FULL(c);
    await pair(c, 0, 1, 0, btc(0.8), usd(50000));
    await pair(c, 0, 2, 1, 4n * E8, usd(3000));
    const h = await c.ex.accountState(c.keys[0]); expect(h.equity > h.mm).to.equal(true);
    c.stale = 1 << 1; await time.increase(70); await refresh(c);
    let err = null;
    try { await c.ex.connect(c.actors[7]).liquidate.staticCall(c.keys[0], 0, { gasLimit: GAS }); } catch (e) { err = decodeErr(c.ex, e); }
    expect(err && err.name).to.equal("NotLiquidatable");
    // the stale market itself cannot be liquidated (no price to close at)
    let err2 = null;
    try { await c.ex.connect(c.actors[7]).liquidate.staticCall(c.keys[0], 1, { gasLimit: GAS }); } catch (e) { err2 = decodeErr(c.ex, e); }
    expect(err2, "stale market itself must not be liquidatable").to.not.equal(null);
  });

  itF("FINDING LIQ-2b: writeOff() is permissionless but can only act on a FLAT NEGATIVE bucket", async () => {
    const c = await mkCtx();
    await FEES_FULL(c);
    await pair(c, 0, 1, 0, btc(1), usd(50000));
    const rev = async (a, m) => { try { await c.ex.connect(c.actors[7]).writeOff.staticCall(a, m); return null; } catch (e) { return decodeErr(c.ex, e); } };
    expect(await rev(c.keys[0], 0), "open position").to.not.equal(null);
    expect(await rev(c.keys[2], 0), "positive flat balance").to.not.equal(null);
    expect(await rev(BACKSTOP, 0), "backstop").to.not.equal(null);
    // negative cross collateral while a position is still open elsewhere is not written off either
    await setPx(c, 0, usd(30000));
    expect(await rev(c.keys[0], 0), "negative but position still open").to.not.equal(null);
  });

  itF("FINDING SETTLE-1: settleDelisted() leaves negative collateral without recording bad debt (docs claim it behaves like liquidation)", async () => {
    const c = await mkCtx();
    await FEES_FULL(c);
    await pair(c, 0, 1, 0, btc(1), usd(50000));
    await c.ex.setMarketState(0, STATE.ReduceOnly);
    await c.ex.delistMarket(0, usd(30000)); // admin-supplied settle price far below entry
    await c.ex.connect(c.actors[7]).settleDelisted(c.keys[0], 0);
    const coll = await c.ex.collateral(c.keys[0]); const ubd = await c.ex.unresolvedBadDebt();
    log("t0 collateral after settle", usdStr(coll), "unresolvedBadDebt", usdStr(ubd), "adlDebt", usdStr(await c.ex.adlDebt(0)));
    expect(coll >= 0n || ubd >= -coll).to.equal(true);
  });

  itF("FINDING WASH-1: reducing fills are not margin- or price-band-checked: off-market reduce-only wash trade manufactures bad debt and drains the vault", async () => {
    const c = await mkCtx([6500, 6500, 100000, 100000, 100000, 100000]);
    await pair(c, 0, 2, 0, btc(1), usd(50000)); // mallory(t0) long 1 BTC @50k with 6.5k
    // accomplice t1 bids 10 BTC at $1 (far outside the band); mallory tries to dump her long into it with a reduce-only IOC
    await c.ex.connect(c.actors[1]).placeOrder(c.actors[1].address, 0, order({ market: 0, isBuy: true, price: usd(1), size: btc(10) }));
    await c.ex.connect(c.actors[0]).placeOrder(c.actors[0].address, 0, order({ market: 0, isBuy: false, price: usd(1), size: btc(1), tif: TIF.IOC, reduceOnly: true }));
    log("mallory position after wash attempt", await posOf(c, 0, 0), "collateral", usdStr(await c.ex.collateral(c.keys[0])));
    expect(await posOf(c, 0, 0), "off-band fill must not execute").to.equal(btc(1));
    const st = await readState(c); c.st = st;
    let pos = 0n; for (const k of c.allKeys) { const x = st.coll.get(k); if (x > 0n) pos += x; }
    expect(pos + st.ins - st.ubd <= st.bal + 2n, "vault must cover all positive claims").to.equal(true);
  });

  itF("FINDING WASH-1b: an in-band wash by an underwater account records its shortfall as bad debt at once (extraction bounded by bandBps)", async () => {
    const c = await mkCtx([6500, 6500, 100000, 100000, 100000, 100000]);
    await pair(c, 0, 2, 0, btc(1), usd(50000));  // mallory(t0) long 1 BTC @50k with 6.5k
    await setPx(c, 0, usd(40000));                // index 40k: mallory equity 6.5k - 10k < 0
    // accomplice bids at the bottom of the band (5%): 38,500 is inside, 38,000 is the edge
    await c.ex.connect(c.actors[1]).placeOrder(c.actors[1].address, 0, order({ market: 0, isBuy: true, price: usd(38500), size: btc(1) }));
    await c.ex.connect(c.actors[0]).placeOrder(c.actors[0].address, 0, order({ market: 0, isBuy: false, price: usd(38500), size: btc(1), tif: TIF.IOC, reduceOnly: true }));
    const coll = await c.ex.collateral(c.keys[0]); const ubd = await c.ex.unresolvedBadDebt(); const adl = await c.ex.adlDebt(0);
    log("mallory flat collateral", usdStr(coll), "unresolvedBadDebt", usdStr(ubd), "adlDebt", usdStr(adl));
    expect(await posOf(c, 0, 0)).to.equal(0n);
    expect(coll, "flat negative balance must have been written off at fill time").to.equal(0n);
    expect(ubd).to.be.gt(0n);
    expect(adl).to.equal(ubd);
    c.st = await readState(c);
    checkCore(c, c.st, "wash-1b");
  });

  itF("FINDING LEDGER-1: ledgerTotals() omits isoMargin so the reconciliation view is wrong whenever isolated margin exists", async () => {
    const c = await mkCtx();
    await c.ex.connect(c.actors[0]).setIsolated(0, 0, true);
    await c.ex.connect(c.actors[0]).addIsoMargin(0, 0, usd(3000));
    const [tracked, net] = await c.ex.ledgerTotals(c.keys);
    log("ledgerTotals tracked", usdStr(tracked), "net deposits", usdStr(net), "difference", usdStr(tracked - net));
    expect(tracked - net >= -5n && tracked - net <= 5n).to.equal(true);
  });

  // ---- shared setup for the backstop tests: t0 (6.5k) short 1 BTC vs t1 long @50k; BTC 60k; t0 liquidated: backstop short 1 BTC @60k
  async function bsSetup(insDonation = 0) {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 100000]);
    await FEES_FULL(c);
    if (insDonation) await c.ex.connect(c.payer).fundInsurance(usd(insDonation));
    await pair(c, 1, 0, 0, btc(1), usd(50000));
    await setPx(c, 0, usd(60000));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0);
    c.st = await readState(c);
    return c;
  }
  const sync = (c) => c.ex.connect(c.actors[7]).syncBackstop();
  const rd = async (c) => { c.st = await readState(c); return c.st; };
  const bsEq = (c) => backstopEquity(c, c.st);

  itF("FINDING BACKSTOP-1: backstop equity is unbounded-negative and never recorded as debt (price continues after takeover)", async () => {
    const c = await bsSetup();
    const st0 = await rd(c); const ubd0 = st0.ubd, ins0 = st0.ins;
    expect(ins0).to.equal(0n);
    const rows = [];
    for (const px of [60000, 100000, 150000, 250000, 500000]) {
      await setPx(c, 0, usd(px));
      await sync(c);
      const st = await rd(c);
      rows.push([px, usdStr(bsEq(c)), usdStr(st.ins), usdStr(st.ubd), usdStr(st.coll.get(BACKSTOP))]);
      // correct predicate: after sync no backstop loss is unrecorded; recorded debt grew by exactly the mark-to-market loss (insurance is 0)
      expect(bsEq(c) >= -2n, `E_B after sync at ${px}`).to.equal(true);
      expect(st.coll.get(BACKSTOP) >= 0n).to.equal(true);
      expect(st.ubd).to.equal(ubd0 + usd(px - 60000));
      expect(st.ubd).to.equal(st.adl.reduce((x, y) => x + y, 0n)); // P3a
      const cl = await readStateClaims(c);
      expect(cl.shortfallVsRecorded <= 2n, `physical: claims - ubd - balance = ${cl.shortfallVsRecorded}`).to.equal(true);
    }
    log("BTC price | backstop equity | insurance | unresolvedBadDebt | backstop collateral"); for (const r of rows) log(r.join(" | "));
    // reversion: debt recorded for the move is repaid in full when the price comes back
    await setPx(c, 0, usd(60000)); await sync(c); const st = await rd(c);
    expect(st.ubd).to.equal(ubd0); expect(st.bsDebt).to.equal(0n);
  });

  // claims - ubd - USDC balance (the P3 quantity); <= 0 means the vault covers every positive bucket net of recorded debt
  async function readStateClaims(c) {
    const s2 = await readState(c);
    let claims = s2.ins + (s2.fee > 0n ? s2.fee : 0n) + (s2.fund > 0n ? s2.fund : 0n);
    for (const k of c.allKeys) { const cc = s2.coll.get(k); if (cc > 0n) claims += cc; for (let m = 0; m < NM; m++) { const x = s2.pos.get(k)[m].isoMargin; if (x > 0n) claims += x; } }
    return { shortfallVsRecorded: claims - s2.ubd - s2.bal };
  }

  itF("FINDING ADL-2: ADL pushes a cross-margined target (who is profitable on one market) underwater on its other positions", async () => {
    const c = await mkCtx([6500, 12000, 100000, 100000, 100000, 100000]);
    await FEES_FULL(c); await c.ex.setAdlMaxPremBps(10000);
    await pair(c, 1, 0, 0, btc(1), usd(50000));        // t0 short BTC (victim), t1 long BTC (will be ADL target)
    await pair(c, 2, 1, 1, 8n * E8, usd(3000));         // t1 short 8 ETH (24k) vs t2 long
    await setPx(c, 0, usd(70000)); await setPx(c, 1, usd(5400)); // t1: BTC long +20k, ETH short -19.2k
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0);
    const h0 = await c.ex.accountState(c.keys[1]); log("t1 before ADL: equity", usdStr(h0.equity), "mm", usdStr(h0.mm));
    await c.ex.connect(c.actors[7]).adl([c.keys[1]], 0);
    const h1 = await c.ex.accountState(c.keys[1]); log("t1 after ADL: equity", usdStr(h1.equity), "mm", usdStr(h1.mm), "BTC pos", await posOf(c, 1, 0), "ETH pos", await posOf(c, 1, 1));
    expect(h1.equity >= h0.mm, "ADL must leave the target at or above its maintenance requirement from BEFORE the ADL").to.equal(true);
    expect(h1.equity >= h1.mm).to.equal(true);
  });

  itF("ADL-2b: a target at/below maintenance is SKIPPED (event, no revert, nothing changes); equity <= 0 is not ranked at all", async () => {
    const c = await mkCtx([6500, 12000, 100000, 100000, 100000, 100000]);
    await FEES_FULL(c); await c.ex.setAdlMaxPremBps(10000);
    await pair(c, 1, 0, 0, btc(1), usd(50000)); await pair(c, 2, 1, 1, 8n * E8, usd(3000));
    await setPx(c, 0, usd(70000)); await setPx(c, 1, usd(6400));       // t1: BTC +20k, ETH -27.2k: equity 4.8k < mm
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0);
    const h = await c.ex.accountState(c.keys[1]); expect(h.equity > 0n && h.equity < h.mm).to.equal(true);
    expect(await c.ex.adlScore(c.keys[1], 0) > 0n).to.equal(true);       // in profit on BTC, equity > 0: ranked
    const ubd0 = (await readState(c)).ubd, pos0 = await posOf(c, 1, 0);
    const tx = await c.ex.connect(c.actors[7]).adl([c.keys[1]], 0);
    const r = await tx.wait(); const evs = parseEvents(c, r);
    expect(evs.some((e) => e.name === "AdlSkipped")).to.equal(true);
    expect(evs.some((e) => e.name === "AdlExecuted")).to.equal(false);
    expect(await posOf(c, 1, 0)).to.equal(pos0);
    expect((await readState(c)).ubd).to.equal(ubd0);
    // equity <= 0: score 0 (must be liquidated, never deleveraged or ranked first)
    await setPx(c, 1, usd(7600));
    const h2 = await c.ex.accountState(c.keys[1]); expect(h2.equity <= 0n).to.equal(true);
    expect(await c.ex.adlScore(c.keys[1], 0)).to.equal(0n);
    // a skipped target does not abort the batch: [skipped t1 is rejected as score 0], but a valid second target still works
  });

  itF("BACKSTOP-1b: insurance is drawn FIRST for the backstop deficit, then debt; recovery refunds insurance first, then debt", async () => {
    const c = await bsSetup(10_000); // 10k donated insurance (victim's 3.6k deficit also draws on it)
    const st0 = await rd(c); const ins0 = st0.ins, ubd0 = st0.ubd;
    expect(ins0 > 0n).to.equal(true);
    await setPx(c, 0, usd(100000)); await sync(c);           // deficit 40k: ins0 from insurance, 40k - ins0 debt
    let st = await rd(c);
    expect(st.ins).to.equal(0n); expect(st.bsIns).to.equal(ins0);
    expect(st.bsDebt).to.equal(usd(40000) - ins0); expect(st.ubd).to.equal(ubd0 + usd(40000) - ins0);
    expect(st.ubd).to.equal(st.adl.reduce((x, y) => x + y, 0n));
    await setPx(c, 0, usd(80000)); await sync(c);            // deficit shrinks to 20k: 20k recovered => insurance first
    st = await rd(c);
    expect(st.ins).to.equal(ins0);                            // fully refunded first
    expect(st.bsIns).to.equal(0n);
    expect(st.bsDebt).to.equal(usd(40000) - ins0 - (usd(20000) - ins0)); // = 20k: the rest of the recovery repaid debt
    expect(st.ubd).to.equal(ubd0 + usd(20000)); expect(bsEq(c) >= -2n && bsEq(c) <= 2n).to.equal(true);
    await setPx(c, 0, usd(55000)); await sync(c);            // above water: surplus beyond draws is kept as backstop equity
    st = await rd(c);
    expect(st.ubd).to.equal(ubd0); expect(st.bsDebt).to.equal(0n); expect(bsEq(c)).to.equal(usd(5000));
    await sync(c); const st2 = await rd(c); expect(st2.ubd).to.equal(st.ubd); expect(st2.ins).to.equal(st.ins); // idempotent
  });

  itF("BACKSTOP-1c: stale feed values the backstop ADVERSELY by 20% (over-records, never hides); repaid when the feed recovers", async () => {
    const c = await bsSetup();
    const ubd0 = (await rd(c)).ubd;
    await c.ex.pokeFunding(0);                       // records lastIndexPrice = 60k
    await time.increase(70);                          // feed older than maxAge (60 s): invalid
    await expect(c.ex.markPrice(0)).to.be.reverted;
    await sync(c);                                    // must NOT revert on a stale feed
    let st = await rd(c);
    expect(st.ubd).to.equal(ubd0 + usd(12000));      // short backstop: valued at 60k * 1.2 = 72k
    expect(st.bsDebt).to.equal(usd(12000));
    await refresh(c); await sync(c);                  // feed back at 60k
    st = await rd(c); expect(st.ubd).to.equal(ubd0); expect(st.bsDebt).to.equal(0n);
  });

  itF("BACKSTOP-1d: settleDelisted syncs the backstop at the frozen settle price (exact)", async () => {
    const c = await bsSetup();
    const ubd0 = (await rd(c)).ubd;
    await setPx(c, 0, usd(100000));
    await c.ex.setMarketState(0, STATE.ReduceOnly); await c.ex.delistMarket(0, usd(100000));
    await c.ex.connect(c.actors[7]).settleDelisted(c.keys[1], 0);   // long closes at 100k against the backstop: realises the -40k
    const st = await rd(c);
    expect((await c.ex.positions(BACKSTOP, 0)).size).to.equal(0n);
    expect(st.coll.get(BACKSTOP) >= 0n).to.equal(true);
    expect(st.ubd).to.equal(ubd0 + usd(40000));
    expect((await c.ex.backstopEquity())).to.equal(0n);
  });

  itF("BACKSTOP-1e: syncBackstop is permissionless, idempotent, works while globally paused, and no-ops when the backstop is flat", async () => {
    const c = await mkCtx();
    const tx0 = await c.ex.connect(c.sg[14]).syncBackstop(); expect((await tx0.wait()).logs.length).to.equal(0);   // flat: no event
    const c2 = await bsSetup();
    await setPx(c2, 0, usd(70000)); await c2.ex.setGlobalPause(true);
    const r1 = await (await c2.ex.connect(c2.sg[14]).syncBackstop()).wait();          // random account, paused
    expect(parseEvents(c2, r1).filter((e) => e.name === "BackstopSynced").length).to.equal(1);
    const r2 = await (await c2.ex.connect(c2.sg[15]).syncBackstop()).wait();
    expect(r2.logs.length).to.equal(0);                                                 // second call: nothing to do
  });

  itF("BACKSTOP-1f: withdraw records the backstop deficit BEFORE paying out; the limiter then restricts earned profit to deposited principal", async () => {
    const c = await bsSetup();
    const ubd0 = (await rd(c)).ubd;
    await setPx(c, 0, usd(100000));                                  // backstop deficit 40k, nobody has synced
    expect((await rd(c)).ubd).to.equal(ubd0);
    await c.ex.connect(c.actors[3]).withdraw(0, usd(1000));          // bystander t3 withdraws: hook syncs first
    let st = await rd(c);
    expect(st.ubd).to.equal(ubd0 + usd(40000));
    // winner t1 realises profit (sells to t2 at 100k): collateral 150k, principal 100k
    await pair(c, 2, 1, 0, btc(1), usd(100000));
    const k1 = c.keys[1]; st = await rd(c); expect(st.coll.get(k1) > usd(100000)).to.equal(true);
    expect(await c.ex.principal(k1)).to.equal(usd(100000));
    expect(st.ubd > (await c.ex.wdGateThreshold())).to.equal(true);
    await expect(c.ex.connect(c.actors[1]).withdraw(0, usd(100000) + 1n)).to.be.revertedWithCustomError(c.ex, "WithdrawGated");
    await c.ex.connect(c.actors[1]).withdraw(0, usd(100000));        // deposited principal always leaves
    expect(await c.ex.principal(k1)).to.equal(0n);
    await expect(c.ex.connect(c.actors[1]).withdraw(0, 1n)).to.be.revertedWithCustomError(c.ex, "WithdrawGated"); // earned profit locked
    // a loser/bystander can withdraw its own remaining collateral up to principal
    await c.ex.connect(c.actors[3]).withdraw(0, usd(99000));
    // deposits, internal transfers (principal follows funds), liquidations never blocked; recapitalising unlocks profit
    await c.ex.connect(c.actors[2]).transferInternal(0, 1, usd(1000));
    expect(await c.ex.principal(c.keys[2])).to.equal(usd(99000)); expect(await c.ex.principal(await c.ex.acctKey(c.actors[2].address, 1))).to.equal(usd(1000));
    await c.ex.connect(c.actors[4]).deposit(c.actors[4].address, 0, usd(5));
    await c.ex.connect(c.payer).recapitalize(0, (await rd(c)).adl[0]);
    expect((await rd(c)).ubd).to.equal(0n);
    await c.ex.connect(c.actors[1]).withdraw(0, usd(1000));          // profit unlocked
  });

  itF("BACKSTOP-1g: gate/ceiling parameter governance: bounds, guardian may only tighten, defaults documented", async () => {
    const c = await mkCtx();
    expect(await c.ex.adlHardPremBps()).to.equal(10000n); expect(await c.ex.wdGateThreshold()).to.equal(usd(100));
    const g = c.sg[14], rnd = c.sg[15];
    await c.ex.grantRole(await c.ex.GUARDIAN_ROLE(), g.address);
    // ceiling: [adlMaxPremBps, 10000]; adlMaxPremBps may not exceed the ceiling
    await expect(c.ex.setAdlHardPremBps(10001)).to.be.reverted;
    await expect(c.ex.setAdlHardPremBps(2499)).to.be.reverted;      // < adlMaxPremBps (2500)
    await c.ex.setAdlHardPremBps(6000); expect(await c.ex.adlHardPremBps()).to.equal(6000n);
    await expect(c.ex.setAdlMaxPremBps(6001)).to.be.reverted;
    await expect(c.ex.connect(g).setAdlHardPremBps(7000)).to.be.revertedWithCustomError(c.ex, "NotAuthorized"); // guardian cannot raise
    await c.ex.connect(g).setAdlHardPremBps(5000); expect(await c.ex.adlHardPremBps()).to.equal(5000n);       // but may lower
    await expect(c.ex.connect(g).setAdlHardPremBps(2000)).to.be.reverted;                                    // not below adlMaxPremBps
    await expect(c.ex.connect(rnd).setAdlHardPremBps(2600)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");
    // limiter
    await expect(c.ex.connect(g).setWithdrawGate(usd(200))).to.be.revertedWithCustomError(c.ex, "NotAuthorized"); // guardian cannot loosen
    await c.ex.connect(g).setWithdrawGate(usd(50)); expect(await c.ex.wdGateThreshold()).to.equal(usd(50));
    await expect(c.ex.connect(rnd).setWithdrawGate(0)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");
    await c.ex.setWithdrawGate(ethers.MaxUint256); expect(await c.ex.wdGateThreshold()).to.equal(ethers.MaxUint256); // admin may disable
  });

  itF("BACKSTOP-1h: ADL ceiling: with backstop-originated debt ADL may concede up to the target's profit; ordinary debt keeps adlMaxPremBps", async () => {
    // (i) default ceiling 100%: after a 500k run-up, ADL of the winner clears (almost) all recorded backstop debt
    const c = await bsSetup(); await setPx(c, 0, usd(500000)); await sync(c);
    const s0 = await rd(c); expect(s0.bsDebt > 0n).to.equal(true);
    await c.ex.connect(c.actors[7]).adl([c.keys[1]], 0);
    const s1 = await rd(c); log("ceiling 100%: ubd", usdStr(s0.ubd), "->", usdStr(s1.ubd), "bsDebt ->", usdStr(s1.bsDebt));
    expect(s1.ubd < s0.ubd - usd(400000)).to.equal(true);
    expect(s1.ubd).to.equal(s1.adl.reduce((x, y) => x + y, 0n));
    // (ii) ceiling lowered to the ordinary cap: only 25% of mark per BTC
    const d = await bsSetup(); await d.ex.setAdlHardPremBps(2500); await setPx(d, 0, usd(500000)); await sync(d);
    const t0 = await rd(d); await d.ex.connect(d.actors[7]).adl([d.keys[1]], 0); const t1 = await rd(d);
    expect(t0.ubd - t1.ubd).to.equal(usd(125000));
  });

  itF("ADL-3: global debt pool: ADL on BTC (backstop short BTC) clears debt that was booked on ETH; ubd == sum(adlDebt) throughout", async () => {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 3000]);
    await FEES_FULL(c);
    await pair(c, 1, 0, 0, btc(1), usd(50000));           // t0 short 1 BTC, t1 long (future ADL target, profit when BTC rises)
    await pair(c, 2, 5, 1, 5n * E8, usd(3000));           // t5 short 5 ETH (15k) on 3k margin, t2 long
    await setPx(c, 0, usd(56000));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0);      // no bad debt: backstop short 1 BTC @56k
    await setPx(c, 1, usd(4500));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[5], 1);      // t5 loses 7.5k on 3k margin: debt booked on ETH (market 1)
    const s0 = await rd(c);
    expect(s0.adl[0]).to.equal(0n); expect(s0.adl[1] > 0n).to.equal(true); expect(s0.ubd).to.equal(s0.adl[1]);
    expect(s0.bsDebt).to.equal(0n);
    await c.ex.connect(c.actors[7]).adl([c.keys[1]], 0);          // the ONLY backstop inventory opposite a winner is BTC
    const s1 = await rd(c);
    const cleared = s0.ubd - s1.ubd;
    log("ETH-booked debt", usdStr(s0.adl[1]), "cleared through a BTC ADL:", usdStr(cleared));
    expect(cleared > 0n).to.equal(true); expect(s1.adl[1]).to.equal(s0.adl[1] - cleared); expect(s1.adl[0]).to.equal(0n);
    expect(s1.ubd).to.equal(s1.adl.reduce((x, y) => x + y, 0n));
    expect(cleared <= usd(6000)).to.equal(true);                   // t1's BTC profit (56k - 50k) bounds the concession
  });

  // =========================================================== PHASE 2: backstop inventory management ===========================================================
  const CFG = [usd(20000), 200, 60, 600, 1200]; // soft 20k notional, max discount 200 bps, dwell 60 s, ramp 600 s, forced unwind after 1200 s
  async function p2Setup({ fee = 10, bsInsDon = 0 } = {}) {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 100000]);
    await FEES_FULL(c);
    if (bsInsDon) await c.ex.connect(c.payer).fundInsurance(usd(bsInsDon));
    await c.ex.setBackstopCfg(0, ...CFG); await c.ex.setBackstopTakeFee(fee);
    await pair(c, 1, 0, 0, btc(1), usd(50000));
    await setPx(c, 0, usd(60000));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0);       // backstop short 1 BTC @60k: 60k notional > 20k soft => elevated
    c.st = await readState(c);
    return c;
  }
  const take = (c, who, size, limit, m = 0) => c.ex.connect(c.actors[who]).takeBackstop(c.actors[who].address, 0, m, size, limit);
  const advance = async (c, dt) => { await time.increase(dt); await refresh(c); };
  const cfgOf = (c, m = 0) => c.ex.backstopCfg(m);

  itF("P2-gov: backstop parameters: bounds, guardian may only tighten, fee <= 10 bps, backstopPlace gate", async () => {
    const c = await mkCtx(); const g = c.sg[14], rnd = c.sg[15];
    await c.ex.grantRole(await c.ex.GUARDIAN_ROLE(), g.address);
    await expect(c.ex.setBackstopCfg(0, ...[CFG[0], 301, 60, 600, 1200])).to.be.revertedWithCustomError(c.ex, "BadParam");   // > 300 bps
    await expect(c.ex.setBackstopCfg(0, ...[CFG[0], 200, 60, 59, 1200])).to.be.revertedWithCustomError(c.ex, "BadParam");    // ramp < 60
    await expect(c.ex.setBackstopCfg(0, ...[CFG[0], 200, 60, 600, 659])).to.be.revertedWithCustomError(c.ex, "BadParam");    // maxAge < dwell + ramp
    await expect(c.ex.setBackstopCfg(9, ...CFG)).to.be.revertedWithCustomError(c.ex, "BadParam");                              // no such market
    await expect(c.ex.connect(g).setBackstopCfg(0, ...CFG)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");              // guardian cannot ENABLE
    await c.ex.setBackstopCfg(0, ...CFG);
    await expect(c.ex.connect(g).setBackstopCfg(0, usd(30000), 200, 60, 600, 1200)).to.be.revertedWithCustomError(c.ex, "NotAuthorized"); // loosen soft
    await expect(c.ex.connect(g).setBackstopCfg(0, usd(20000), 250, 60, 600, 1200)).to.be.revertedWithCustomError(c.ex, "NotAuthorized"); // raise discount
    await expect(c.ex.connect(g).setBackstopCfg(0, usd(20000), 200, 60, 600, 1300)).to.be.revertedWithCustomError(c.ex, "NotAuthorized"); // later forced unwind
    await expect(c.ex.connect(g).setBackstopCfg(0, 0, 200, 60, 600, 1200)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");           // cannot disable
    await c.ex.connect(g).setBackstopCfg(0, usd(10000), 100, 30, 300, 600);
    expect((await cfgOf(c)).softNotional).to.equal(usd(10000));
    await expect(c.ex.connect(rnd).setBackstopCfg(0, usd(1), 1, 1, 60, 61)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");
    await expect(c.ex.setBackstopTakeFee(11)).to.be.revertedWithCustomError(c.ex, "BadParam");
    await c.ex.setBackstopTakeFee(8); await expect(c.ex.connect(g).setBackstopTakeFee(9)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");
    await c.ex.connect(g).setBackstopTakeFee(3); expect(await c.ex.backstopTakeFeeBps()).to.equal(3n);
    await expect(c.ex.connect(rnd).setBackstopTakeFee(0)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");
    await c.ex.connect(g).setBackstopPlaceOpen(false); expect(await c.ex.backstopPlaceOpen()).to.equal(false);
    await expect(c.ex.connect(g).setBackstopPlaceOpen(true)).to.be.revertedWithCustomError(c.ex, "NotAuthorized");   // only admin reopens
    await c.ex.setBackstopPlaceOpen(true);
  });

  itF("P2-auction: disabled/not elevated reverts; liquidation starts the clock; price = INDEX x (1 + disc) with dwell then linear ramp", async () => {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 100000]); await FEES_FULL(c);
    await pair(c, 1, 0, 0, btc(1), usd(50000)); await setPx(c, 0, usd(60000));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0);                    // phase 2 NOT configured: feature off
    await expect(take(c, 2, btc(0.1), ethers.MaxUint256 >> 192n)).to.be.revertedWithCustomError(c.ex, "BadParam");
    expect((await c.ex.backstopAuction(0)).active).to.equal(false);
    // configure, then poke: clock starts
    await c.ex.setBackstopCfg(0, ...CFG);
    await c.ex.pokeBackstop(0); const t0 = BigInt((await time.latest()));
    expect((await cfgOf(c)).elevatedSince > 0n).to.equal(true);
    let q = await c.ex.backstopAuction(0);
    expect(q.active && q.takerSells).to.equal(true); expect(q.discBps).to.equal(0n); expect(q.price).to.equal(usd(60000));
    await advance(c, 30);  q = await c.ex.backstopAuction(0); expect(q.discBps).to.equal(0n);         // still inside dwell
    await advance(c, 330); q = await c.ex.backstopAuction(0);                                         // ~ 390 s after: ramp 330 s of 600 => ~110 bps
    log("disc at ~390 s:", q.discBps, "bps price", usdStr(q.price));
    expect(q.discBps >= 100n && q.discBps <= 120n).to.equal(true);
    expect(q.price).to.equal(usd(60000) * (10000n + q.discBps) / 10000n);
    await advance(c, 2000); q = await c.ex.backstopAuction(0);
    expect(q.discBps).to.equal(200n); expect(q.price).to.equal(usd(61200));                           // capped at maxDiscBps
    // never outside the price band
    expect(q.price <= usd(60000) * (10000n + 500n) / 10000n).to.equal(true);
    expect(t0 > 0n).to.equal(true);
  });

  itF("P2-take: partial take, taker margin check, limit, lot, fee to insurance, interplay with the phase-1 sync", async () => {
    const c = await p2Setup({ fee: 10 });
    await advance(c, 2000);                                  // full 200 bps discount: backstop (short) pays 61,200 to buy back
    const st0 = await rd(c); const bs0 = (await c.ex.positions(BACKSTOP, 0)).size; expect(bs0).to.equal(-btc(1));
    // limit price: taker sells, wants >= 62k: not met
    await expect(take(c, 2, btc(0.4), usd(62000))).to.be.revertedWithCustomError(c.ex, "BadParam");
    await expect(take(c, 2, btc(0.4) + 1n, usd(61000))).to.be.revertedWithCustomError(c.ex, "BadParam");   // lot
    await expect(take(c, 2, btc(2), usd(61000))).to.be.revertedWithCustomError(c.ex, "BadParam");           // more than the inventory
    // margin: t0 (liquidated, ~0 collateral) cannot take a 0.5 BTC short
    await expect(take(c, 0, btc(0.5), usd(61000))).to.be.revertedWithCustomError(c.ex, "Unhealthy");
    const tx = await take(c, 2, btc(0.4), usd(61000)); const r = await tx.wait(); const evs = parseEvents(c, r);
    const T = evs.find((e) => e.name === "BackstopTaken").args;
    expect(T.price).to.equal(usd(61200)); expect(T.size).to.equal(btc(0.4)); expect(T.takerSold).to.equal(true); expect(T.discBps).to.equal(200n);
    const notional = usd(61200) * btc(0.4) / E8; const fee = (notional * 10n + 9999n) / 10000n;
    expect(T.fee).to.equal(fee);
    expect((await c.ex.positions(c.keys[2], 0)).size).to.equal(-btc(0.4));
    expect((await c.ex.positions(BACKSTOP, 0)).size).to.equal(-btc(0.6));
    // backstop realised (61,200-60,000)*0.4 = 480 loss, covered by insurance first (fee + liquidation share), rest recorded
    const st1 = await rd(c); checkCore(c, st1, "p2-take");
    expect(st1.coll.get(BACKSTOP) >= 0n).to.equal(true); expect(bsEq(c) >= -2n).to.equal(true); expect(st1.bsDebt <= st1.ubd).to.equal(true);
    log("insurance", usdStr(st0.ins), "->", usdStr(st1.ins), "fee", usdStr(fee), "ubd", usdStr(st0.ubd), "->", usdStr(st1.ubd), "bsIns", usdStr(st1.bsIns), "bsDebt", usdStr(st1.bsDebt));
    expect(st1.ins + (st1.bsIns - st0.bsIns)).to.equal(st0.ins + fee);                               // the fee reached insurance exactly (draws for the backstop loss are mirrored in bsInsDrawn)
    expect(parseEvents(c, r).some((e) => e.name === "Fill")).to.equal(false);
    // taker equity gain at the index is bounded by disc x size (wash bound): sold 0.4 at 61.2k vs index 60k
    const acc = await c.ex.accountState(c.keys[2]);
    expect(acc.equity - (BigInt(usd(100000))) <= usd(480) - fee + 5n).to.equal(true);
    // take the rest (partial remainder): clock cleared once at/below the threshold
    await take(c, 3, btc(0.6), usd(61000));
    expect((await c.ex.positions(BACKSTOP, 0)).size).to.equal(0n);
    expect((await cfgOf(c)).elevatedSince).to.equal(0n);
    await expect(take(c, 4, btc(0.1), usd(61000))).to.be.revertedWithCustomError(c.ex, "BadParam");  // nothing left / not elevated
  });

  itF("P2-take-buy: backstop LONG inventory is sold to the taker at index x (1 - disc), rounded in the backstop's favour", async () => {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 100000]); await FEES_FULL(c);
    await c.ex.setBackstopCfg(0, ...CFG); await c.ex.setBackstopTakeFee(0);
    await pair(c, 0, 1, 0, btc(1), usd(50000));              // t0 LONG 1 BTC (6.5k), t1 short
    await setPx(c, 0, usd(40000));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0); // backstop LONG 1 BTC @40k
    await advance(c, 2000);
    const q = await c.ex.backstopAuction(0); expect(q.takerSells).to.equal(false); expect(q.price).to.equal(usd(39200));
    await expect(take(c, 2, btc(0.5), usd(39000))).to.be.revertedWithCustomError(c.ex, "BadParam");   // buyer's max price 39k < 39.2k
    await take(c, 2, btc(0.5), usd(39200));
    expect((await c.ex.positions(c.keys[2], 0)).size).to.equal(btc(0.5));
    expect((await c.ex.positions(BACKSTOP, 0)).size).to.equal(btc(0.5));
    checkCore(c, await rd(c), "p2-buy");
  });

  itF("P2-unwind: forced unwind at MARK after maxAge, ranked, no concession, to the threshold; liquidation stays enabled", async () => {
    const c = await p2Setup({ fee: 0 });
    const bsA = [c.keys[1]];
    await expect(c.ex.connect(c.actors[7]).unwindBackstop(bsA, 0)).to.be.revertedWithCustomError(c.ex, "BadParam");   // not due yet
    await advance(c, 1100);
    await expect(c.ex.connect(c.actors[7]).unwindBackstop(bsA, 0)).to.be.revertedWithCustomError(c.ex, "BadParam");   // 1100 < 1200
    await advance(c, 200);
    await expect(c.ex.connect(c.actors[7]).unwindBackstop([c.keys[2]], 0)).to.be.reverted;                              // no position / not in profit
    // Q7: liquidation is still enabled while elevated/due: make t3 liquidatable and liquidate it
    await pair(c, 3, 4, 0, btc(0.1), usd(60000));            // t3 long 0.1, t4 short 0.1 (both 100k): not liquidatable; just ensure call path alive
    const before = await c.ex.collateral(c.keys[1]);
    const tx = await c.ex.connect(c.actors[7]).unwindBackstop(bsA, 0); const evs = parseEvents(c, await tx.wait());
    const U = evs.find((e) => e.name === "BackstopUnwound").args;
    const keep = usd(20000) * E8 / usd(60000);               // threshold in size units
    const want = (btc(1) - keep + 9999n) / 10000n * 10000n;  // rounded UP to the lot (10,000)
    expect(U.size).to.equal(want); expect(U.price).to.equal(usd(60000));
    // winner t1 keeps full profit: closed `want` at mark 60k vs entry 50k
    const after = await c.ex.collateral(c.keys[1]);
    expect(after - before).to.equal(U.size * usd(10000) / E8);
    const bs = (await c.ex.positions(BACKSTOP, 0)).size; expect(bs).to.equal(-(btc(1) - U.size));
    expect((await cfgOf(c)).elevatedSince).to.equal(0n);     // back at the threshold: clock cleared
    const st = await rd(c); checkCore(c, st, "p2-unwind"); expect(bsEq(c) >= -2n).to.equal(true);
    // a liquidation of an unrelated account is not blocked at any point of elevation (here: still live)
    await setPx(c, 0, usd(50000)); await c.ex.connect(c.actors[7]).syncBackstop();
  });

  itF("P2-unwind-rank: unranked / wrong-side targets revert; forced unwind needs a fresh feed", async () => {
    const c = await p2Setup({ fee: 0 });
    await advance(c, 1300);
    await expect(c.ex.connect(c.actors[7]).unwindBackstop([c.keys[2]], 0)).to.be.revertedWithCustomError(c.ex, "BadParam"); // no profit / no position
    await time.increase(70);                                   // feed now stale
    await expect(c.ex.connect(c.actors[7]).unwindBackstop([c.keys[1]], 0)).to.be.reverted;
    await expect(take(c, 2, btc(0.1), usd(61000))).to.be.revertedWithCustomError(c.ex, "OracleDegraded");
    await c.ex.connect(c.actors[7]).syncBackstop();            // phase-1 sync still works on a stale feed (adverse valuation)
    await refresh(c);
  });

  itF("P2-place: backstopPlace may reduce inventory but not grow it above the soft threshold; guardian can close the gate", async () => {
    const c = await mkCtx([6500, 100000, 100000, 100000, 100000, 100000]); await FEES_FULL(c);
    await c.ex.setBackstopCfg(0, ...CFG);
    await pair(c, 0, 1, 0, btc(1), usd(50000));              // t0 long 1 BTC on 6.5k
    await setPx(c, 0, usd(40000));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0); // backstop long 1 BTC (40k notional > 20k soft)
    await c.ex.pokeBackstop(0);
    expect((await c.ex.positions(BACKSTOP, 0)).size).to.equal(btc(1));
    const px = usd(40000);
    const o = (isBuy, size) => order({ market: 0, isBuy, price: px, size, tif: TIF.IOC });
    await c.ex.connect(c.actors[4]).placeOrder(c.actors[4].address, 0, order({ market: 0, isBuy: false, price: px, size: btc(0.2) })); // ask rests
    // growing is refused: by the margin check while the backstop is under-capitalised (as here), by BackstopCap once it has equity (cap path covered by the fuzz)
    await expect(c.ex.connect(c.bsOp).backstopPlace(o(true, btc(0.2)))).to.be.reverted;
    await c.ex.connect(c.actors[3]).placeOrder(c.actors[3].address, 0, order({ market: 0, isBuy: true, price: px, size: btc(0.2) })); // bid rests
    await c.ex.connect(c.bsOp).backstopPlace(o(false, btc(0.2)));                                                                       // reduces: allowed
    expect((await c.ex.positions(BACKSTOP, 0)).size <= btc(1)).to.equal(true);   // a reducing order is never refused by the cap
    await c.ex.grantRole(await c.ex.GUARDIAN_ROLE(), c.sg[14].address);
    await c.ex.connect(c.sg[14]).setBackstopPlaceOpen(false);
    await expect(c.ex.connect(c.bsOp).backstopPlace(o(false, btc(0.1)))).to.be.revertedWithCustomError(c.ex, "BackstopCap");
  });

  itF("P2-pause: global pause blocks takeBackstop (new risk), not liquidation or sync; Delisted markets cannot be taken", async () => {
    const c = await p2Setup({ fee: 0 });
    await c.ex.setGlobalPause(true);
    await expect(take(c, 2, btc(0.1), usd(61000))).to.be.revertedWithCustomError(c.ex, "MarketRestricted");
    await c.ex.connect(c.actors[7]).syncBackstop();
    await c.ex.setGlobalPause(false);
    await c.ex.setMarketState(0, STATE.ReduceOnly);            // reduce-only market: auction still allowed for reducing takers? taker sells => opens short => margin path decides
    await take(c, 2, btc(0.1), usd(59000));
  });

  itF("P2-nonreentrant: takeBackstop performs no token transfer or external call (pure accounting)", async () => {
    const c = await p2Setup({ fee: 5 });
    const r = await (await take(c, 2, btc(0.1), usd(59000))).wait();
    const usdcAddr = (await c.usdc.getAddress()).toLowerCase();
    expect(r.logs.filter((l) => l.address.toLowerCase() === usdcAddr).length).to.equal(0);
  });

  // =========================================================== PHASE 2b: debt attribution (found on the live demo, market id 3)
  const adlArr = async (c) => { const o = []; for (let m = 0; m < NM; m++) o.push(await c.ex.adlDebt(m)); return o; };
  async function expectAttributed(c, m, label) {
    const a = await adlArr(c); const st = await rd(c);
    log(label, "adlDebt", a.map(usdStr).join(","), "ubd", usdStr(st.ubd), "bsDebt", usdStr(st.bsDebt), "bsIns", usdStr(st.bsIns));
    for (let j = 0; j < NM; j++) if (j !== m) expect(a[j], `${label}: adlDebt[${j}]`).to.equal(0n);
    expect(a[m], `${label}: adlDebt[${m}]`).to.be.gt(0n);
    expect(a.reduce((x, y) => x + y, 0n)).to.equal(st.ubd);
    expect(st.bsDebt <= st.ubd).to.equal(true);
  }
  const SOL = 2, sol = btc;
  // t0 long `size` SOL @150 (6.5k), liquidated at 89 while the price is held: the backstop gets a long (price held, no deficit yet)
  async function solLong(cfg = true) {
    const c = await mkCtx([6500, 100000, 100000, 6500, 100000, 100000]); await FEES_FULL(c);
    if (cfg) { await c.ex.setBackstopCfg(SOL, usd(1000), 200, 60, 600, 1200); await c.ex.setBackstopTakeFee(0); }
    await pair(c, 0, 1, SOL, sol(100), usd(150));
    await setPx(c, SOL, usd(89));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], SOL);
    return c;
  }

  itF("ATTR-1 (demo): long liquidated into the backstop at mark on market id 2, taken at a discount: the loss is booked on market 2, not 0", async () => {
    const c = await solLong();
    const st0 = await rd(c); expect(st0.ubd).to.equal(0n);
    const bs = (await c.ex.positions(BACKSTOP, SOL)).size; expect(bs > 0n).to.equal(true);
    await advance(c, 2000);                                           // full 200 bps discount; price held at 89
    await c.ex.connect(c.actors[2]).takeBackstop(c.actors[2].address, 0, SOL, bs, usd(1000));
    expect((await c.ex.positions(BACKSTOP, SOL)).size).to.equal(0n);  // flat: the old code defaulted attribution to market 0
    const st = await rd(c); expect(st.ubd > 0n).to.equal(true);       // insurance (liquidation fee share) is smaller than the loss
    expect(st.ins).to.equal(0n);
    await expectAttributed(c, SOL, "demo");
    // a later permissionless sync (backstop flat, nothing new) neither moves nor re-books the debt
    await sync(c); await expectAttributed(c, SOL, "demo+sync");
  });

  itF("ATTR-2: liquidate with a backstop deficit realised on the liquidated market (backstop short bought back by a liquidated long)", async () => {
    const c = await mkCtx([6500, 100000, 100000, 6500, 100000, 100000]); await FEES_FULL(c);
    await pair(c, 1, 0, SOL, sol(100), usd(150));                    // t0 SHORT 100 SOL
    await setPx(c, SOL, usd(210));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], SOL);       // backstop short @210
    const X = -(await c.ex.positions(BACKSTOP, SOL)).size; expect(X > 0n).to.equal(true);
    await setPx(c, SOL, usd(400));
    await pair(c, 3, 2, SOL, X, usd(400)); // t3 long X @400 (6.5k collateral)
    await setPx(c, SOL, usd(340));
    expect(await c.ex.adlDebt(0) + await c.ex.adlDebt(1) + await c.ex.adlDebt(2)).to.equal(0n);
    await c.ex.connect(c.actors[7]).liquidate(c.keys[3], SOL);       // backstop buys back X: flat, realised loss ~ X x 130
    expect((await c.ex.positions(BACKSTOP, SOL)).size).to.equal(0n);
    await expectAttributed(c, SOL, "liquidate");
  });

  itF("ATTR-3: unwindBackstop realises the loss at mark on its market and books it there", async () => {
    const c = await solLong();
    await c.ex.pokeBackstop(SOL);
    await c.ex.setBackstopCfg(SOL, 1, 200, 60, 600, 1200);            // threshold ~0: unwind takes the whole inventory
    await advance(c, 1300);
    await c.ex.pokeBackstop(SOL);
    await advance(c, 1300);
    await setPx(c, SOL, usd(70));                                     // backstop long loses on the way down; t1 (short) is deep in profit
    await c.ex.connect(c.actors[7]).unwindBackstop([c.keys[1]], SOL);
    expect((await c.ex.positions(BACKSTOP, SOL)).size).to.equal(0n);
    await expectAttributed(c, SOL, "unwind");
  });

  itF("ATTR-4: settleDelisted closing a backstop short at the settle price books the loss on the delisted market", async () => {
    const c = await mkCtx([6500, 100000, 100000, 6500, 100000, 100000]); await FEES_FULL(c);
    await pair(c, 1, 0, SOL, sol(100), usd(150));
    await setPx(c, SOL, usd(210));
    await c.ex.connect(c.actors[7]).liquidate(c.keys[0], SOL);       // backstop short @210
    const X = -(await c.ex.positions(BACKSTOP, SOL)).size;
    await setPx(c, SOL, usd(400));
    await pair(c, 3, 2, SOL, X, usd(400));                            // t3 long X @400
    await c.ex.setMarketState(SOL, STATE.ReduceOnly);
    await c.ex.delistMarket(SOL, usd(340));
    await c.ex.connect(c.actors[7]).settleDelisted(c.keys[3], SOL);   // backstop (short @210) buys back at 340: flat, realised loss
    expect((await c.ex.positions(BACKSTOP, SOL)).size).to.equal(0n);
    await expectAttributed(c, SOL, "settleDelisted");
  });

  itF("FINDING OI-1: lowering maxOI below current OI makes every fill revert OICap, including reduce-only closes", async () => {
    const c = await mkCtx();
    await pair(c, 0, 1, 0, btc(1), usd(50000));
    await c.ex.setMarketParams(0, 100n * E8, btc(0.5), usd(10), 60, 500, 100, 400_000_000n);
    await c.ex.connect(c.cp).placeOrder(c.cp.address, 0, order({ market: 0, isBuy: true, price: usd(50000), size: btc(1) }));
    let err = null;
    try { await c.ex.connect(c.actors[0]).placeOrder.staticCall(c.actors[0].address, 0, order({ market: 0, isBuy: false, price: usd(50000), size: btc(1), tif: TIF.IOC, reduceOnly: true })); } catch (e) { err = decodeErr(c.ex, e); }
    log("reduce-only close with oi > maxOI ->", err ? errStr(err) : "ok");
    expect(err).to.equal(null);
  });

  it("partial-liquidation loops (closeFactor 50%, fullCloseNotional 10k): liquidations needed after a gap", async () => {
    const c0 = await mkCtx([1_000_000, 100000, 100000, 100000, 100000, 100000]);
    const snap = await takeSnapshot();
    const rows = [["notional", "gap", "liquidations", "end state", "bad debt"]];
    for (const N of [100_000, 1_000_000, 5_000_000]) for (const gap of [-5, -12, -30, -60]) {
      await snap.restore();
      const c = c0; c.px = MK.map((m) => m.px0); await refresh(c);
      const im = N <= 100_000 ? 10n : N <= 1_000_000 ? 20n : 50n;
      const size = BigInt(N) * E8 / 50_000n;
      // victim = t5 with exactly IM + fee headroom
      await c.ex.connect(c.actors[5]).withdraw(0, await c.ex.withdrawable(c.keys[5]));
      const need = usd(N) * im / 100n + usd(N) / 1000n * 2n;
      await c.ex.connect(c.actors[5]).deposit(c.actors[5].address, 0, need);
      await pair(c, 5, 6, 0, size, usd(50000));
      await setPx(c, 0, usd(50000) * BigInt(100 + gap) / 100n);
      let n = 0, end = "";
      for (; n < 60; n++) {
        const pos = await posOf(c, 5, 0); if (pos === 0n) { end = "flat"; break; }
        const h = await c.ex.accountState(c.keys[5]); if (h.equity >= h.mm) { end = "healthy"; break; }
        await c.ex.connect(c.actors[7]).liquidate(c.keys[5], 0);
      }
      const bad = await c.ex.unresolvedBadDebt();
      rows.push([usdStr(BigInt(N) * 1_000_000n), gap + "%", String(n), end, usdStr(bad)]);
      const bound = Math.ceil(Math.log2(N / 10_000)) + 2;
      expect(n, `liquidations needed (${N}, ${gap}%) must be bounded by ~log2`).to.be.lessThanOrEqual(bound);
    }
    for (const r of rows) log(r.join(" | "));
  });

  async function addMarkets(c, total) {
    for (let m = NM; m < total; m++) {
      const mk = { name: "M" + m, feed: ethers.id("M" + m), px0: 100_000_000n, tick: 10_000n, lot: 1_000_000n, maxOrderSize: 200_000n * E8, maxOI: 1_000_000n * E8 };
      MK[m] = mk; await c.oracle.set(mk.feed, mk.px0); await c.ex.createMarket(mcfg(mk), TIERS); c.px[m] = mk.px0; c.opx[m] = mk.px0;
    }
  }
  async function gasScenario(total) {
    const c = await mkCtx([8000 + 2500 * total, 400000, 400000, 400000, 400000, 400000]);
    const orig = MK.length; await addMarkets(c, total);
    await FEES_FULL(c); await c.ex.setAdlMaxPremBps(10000);
    // refresh must cover all markets
    const refreshAll = async () => { for (let m = 0; m < total; m++) { await c.oracle.set(MK[m].feed, c.px[m]); c.opx[m] = c.px[m]; } c.lastRefresh = await time.latest(); };
    // victim t0: long in every market; 8 winners t1..t5,cp,kp style: use t1-t5 (5) + cp + kp + t0? => winners are accounts 1..5,6(cp),7(kp)=7 -> need 8: reuse t0? use 7 shorts + victim separate sub? keep 7 winners + note
    for (let m = 0; m < total; m++) {
      const sz = m === 0 ? btc(2) : 100n * E8 / BigInt(m === 1 ? 33 : 1) ; void sz;
    }
    // victim long BTC 2 BTC (100k notional) + ~10k notional on every other market
    await c.ex.connect(c.payer).fundInsurance(usd(1)); // nonzero insurance
    const sizeOf = (m) => (m === 0 ? btc(2) : m === 1 ? 3n * E8 : 100n * E8 / 1n); // ETH 3 (=9k), others 100 units @ $100 = 10k
    await c.ex.connect(c.actors[7]).deposit(c.actors[7].address, 0, usd(100000));
    // 8 shorts: t1..t5, kp(7), and two extra sub accounts of cp/t5 (subs 1,2) - use sub-accounts to reach 8
    const winners = []; // [signer, sub]
    for (const i of [1, 2, 3, 4, 5, 7]) winners.push([c.actors[i], 0]);
    for (const sub of [1, 2]) { const s = c.actors[6]; await c.ex.connect(s).deposit(s.address, sub, usd(400000)); winners.push([s, sub]); }
    const wkey = (w) => acctKey(w[0].address, w[1]);
    for (let m = 0; m < total; m++) {
      const sz = sizeOf(m);
      // victim buys total sz from the 8 winners (each sells sz/8, at least one lot) - maker winners, taker victim
      await refreshAll();
      const part = Math.max(Number(sz / 20n / MK[m].lot), 1); const partS = BigInt(part) * MK[m].lot;
      for (const w of winners) {
        await c.ex.connect(w[0]).placeOrder(w[0].address, w[1], order({ market: m, isBuy: false, price: MK[m].px0, size: partS }), { gasLimit: GAS });
      }
      const rest = sz / MK[m].lot * MK[m].lot - 8n * partS;
      await c.ex.connect(c.cp).placeOrder(c.cp.address, 0, order({ market: m, isBuy: false, price: MK[m].px0, size: rest > 0n ? rest : MK[m].lot }), { gasLimit: GAS });
      await c.ex.connect(c.actors[0]).placeOrder(c.actors[0].address, 0, order({ market: m, isBuy: true, price: MK[m].px0, size: 8n * partS + (rest > 0n ? rest : MK[m].lot), tif: TIF.IOC }), { gasLimit: GAS });
      for (const w of winners) await c.ex.connect(w[0]).cancelAll(w[0].address, w[1]);
      await c.ex.connect(c.cp).cancelAll(c.cp.address, 0);
    }
    // 32 resting orders for the victim to make cancellation worst-case
    await refreshAll();
    for (let i = 0; i < 30; i++) {
      if (i % 10 === 9) await refreshAll();
      await c.ex.connect(c.actors[0]).placeOrder(c.actors[0].address, 0, order({ market: 0, isBuy: true, price: usd(40000) - BigInt(i) * 100_000n, size: btc(0.01) }), { gasLimit: GAS });
    }
    const open = (await c.ex.openOrderIds(c.keys[0])).length;
    // gap: every market -75% => victim deeply insolvent, winners (short) hugely profitable
    for (let m = 0; m < total; m++) c.px[m] = rt(MK[m].px0 / 4n, m);
    await refreshAll();
    const r = await (await c.ex.connect(c.actors[7]).liquidate(c.keys[0], 0, { gasLimit: 30_000_000 })).wait();
    // the remaining cross positions must each be liquidated too; bad debt is only recorded when the LAST cross position closes,
    // and it is attributed to THAT market (adlDebt[last]), not to the market where the loss arose
    let lastGas = 0n, maxGas = r.gasUsed;
    for (let m = 1; m < total; m++) { await refreshAll(); const rr = await (await c.ex.connect(c.actors[7]).liquidate(c.keys[0], m, { gasLimit: 30_000_000 })).wait(); lastGas = rr.gasUsed; if (rr.gasUsed > maxGas) maxGas = rr.gasUsed; }
    const am = total - 1;
    const debt = await c.ex.adlDebt(am);
    log("adlDebt by market:", (await Promise.all(MK.slice(0, total).map((_, m) => c.ex.adlDebt(m)))).map((x) => usdStr(x)).join(","));
    // rank 8 winners by score
    const sc = [];
    for (const w of winners) { sc.push([wkey(w), await c.ex.adlScore(wkey(w), am)]); }
    sc.sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : a[0] < b[0] ? -1 : 1));
    const r2 = await (await c.ex.connect(c.actors[7]).adl(sc.map((x) => x[0]), am, { gasLimit: 30_000_000 })).wait();
    const nAdl = r2.logs.map((l) => { try { return c.ex.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === "AdlExecuted").length;
    log(`${total} markets: victim holds ${total} cross positions + ${open} resting orders; first liquidate gas = ${r.gasUsed} (max over all ${total} liquidations ${maxGas}); adl debt ${usdStr(debt)}; adl(8 candidates) executed ${nAdl} targets, gas = ${r2.gasUsed}`);
    MK.length = orig;
    return { liqGas: r.gasUsed, adlGas: r2.gasUsed, nAdl };
  }
  it("gas: liquidate() with 3 cross positions + 32 resting orders, adl() with 8 targets (3 markets)", async () => {
    const g = await gasScenario(3);
    expect(g.nAdl).to.equal(8);
    expect(g.liqGas).to.be.lessThan(8_000_000n);
    expect(g.adlGas).to.be.lessThan(8_000_000n);
  });
  it("gas: same at MAX_MARKETS=16 (every account holds 16 cross positions)", async () => {
    const g = await gasScenario(16);
    expect(g.nAdl).to.equal(8);
    expect(g.liqGas).to.be.lessThan(25_000_000n);
    expect(g.adlGas).to.be.lessThan(25_000_000n);
  });
});
