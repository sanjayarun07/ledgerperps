// Property-based / fuzz tests for the perp exchange (fast-check, model-based random action sequences).
//
// Run:   npx hardhat test test/fuzz.test.js
// Env:   FUZZ_RUNS (default 40)   number of random action sequences
//        FUZZ_LEN  (default 60)   max actions per sequence
//        FUZZ_SEED (default 20240607) fast-check seed; a failing run prints the seed + counterexample + repro line
//        FUZZ_TIMEOUT_MS (default 900000) mocha timeout for the fuzz property (incl. shrinking)
//
// Every action is executed against a freshly restored chain (loadFixture). After every action ALL invariants are
// re-read from chain state. Expected reverts (custom errors) are tolerated; panics, plain Error(string), empty
// revert data (out-of-gas) and unexpected custom errors FAIL the property.
const { expect } = require("chai");
const fc = require("fast-check");
const { ethers, loadFixture, time, usd, btc, TIF, FEED, order, deploy } = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS ?? 40);
const LEN = Number(process.env.FUZZ_LEN ?? 60);
const SEED = Number(process.env.FUZZ_SEED ?? 20240607);
// Debug aid ONLY (default off): lets the random run continue past the known PostOnly-never-rests bug to expose other issues.
const SKIP_POSTONLY_REST = process.env.FUZZ_SKIP_POSTONLY_REST === "1";
const FUZZ_TIMEOUT = Number(process.env.FUZZ_TIMEOUT_MS ?? 900000);

const TICK = 100_000n; // $0.10
const LOT = 10_000n; // 0.0001 BTC
const BASE_PX = 50_000n * 1_000_000n;
const BACKSTOP = ethers.id("PERP.BACKSTOP");
const GAS = 12_000_000;
const SIZE_SCALE = 100_000_000n;
const N_TRADERS = 5;

const abs = (x) => (x < 0n ? -x : x);
const sgn = (x) => (x > 0n ? 1 : x < 0n ? -1 : 0);
const acctKey = (addr, sub = 0) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8"], [addr, sub]));
function check(cond, msg) { if (!cond) throw new Error("INVARIANT VIOLATED: " + msg); }

// ---------------------------------------------------------------------------------------------- fixture
async function fuzzFixture() {
  const e = await deploy();
  const sg = await ethers.getSigners();
  const traders = [e.alice, e.bob, e.carol, e.keeper, sg[8]];
  const cp = sg[9];
  for (const s of [sg[8], cp]) {
    await e.usdc.mint(s.address, usd(20_000_000));
    await e.usdc.connect(s).approve(await e.ex.getAddress(), ethers.MaxUint256);
  }
  for (const s of traders) await e.ex.connect(s).deposit(s.address, 0, usd(100_000));
  await e.ex.connect(cp).deposit(cp.address, 0, usd(5_000_000));
  const orc = e.oracle;
  return { ...e, traders, cp, orc };
}

// ---------------------------------------------------------------------------------------------- error handling
function decodeErr(ex, e) {
  const cands = [e?.data, e?.error?.data, e?.info?.error?.data, e?.info?.error?.error?.data, e?.error?.error?.data];
  for (const d of cands) {
    const hex = typeof d === "string" ? d : d?.data;
    if (typeof hex === "string" && hex.startsWith("0x") && hex.length >= 10) {
      try { const p = ex.interface.parseError(hex); if (p) return { name: p.name, args: p.args, raw: hex }; } catch {}
      return { name: "Unknown(" + hex.slice(0, 10) + ")", args: [], raw: hex };
    }
  }
  return null;
}
function errStr(d) { return d.name + (d.args && d.args.length ? "(" + d.args.join(",") + ")" : ""); }

// ---------------------------------------------------------------------------------------------- state reader
async function readState(c) {
  const { ex, usdc } = c;
  const keys = c.allKeys;
  const st = { pos: new Map(), basis: new Map(), coll: new Map(), resv: new Map(), open: new Map(), orders: new Map() };
  await Promise.all(keys.map(async (k) => {
    const [p, col, rs, ids] = await Promise.all([ex.positions(k, 0), ex.collateral(k), ex.reserved(k), ex.openOrderIds(k)]);
    st.pos.set(k, p.size); st.basis.set(k, p.basis); st.coll.set(k, col); st.resv.set(k, rs);
    st.open.set(k, ids.map((x) => BigInt(x)));
  }));
  const allIds = [...st.open.values()].flat();
  await Promise.all(allIds.map(async (id) => {
    const o = await ex.orders(id);
    st.orders.set(id, { acct: o.acct, size: o.size, reserve: o.reserve, price: o.price, expiry: o.expiry, prev: o.prev, next: o.next, market: Number(o.market), isBuy: o.isBuy, reduceOnly: o.reduceOnly });
  }));
  const [mk, bb, ba, noid, ntid, feePool, fundingPool, dust, bal, dep, wd, bidSnap, askSnap, ledger] = await Promise.all([
    ex.getMarket(0), ex.bestPrice(0, true), ex.bestPrice(0, false), ex.nextOrderId(), ex.nextTradeId(), ex.feePool(), ex.fundingPool(),
    ex.dustBasis(), usdc.balanceOf(await ex.getAddress()), ex.totalDeposited(), ex.totalWithdrawn(),
    ex.bookSnapshot(0, true, 300), ex.bookSnapshot(0, false, 300),
    ex.ledgerTotals(c.keys),
  ]);
  st.oi = mk.oi; st.maxOI = mk.maxOI; st.bestBid = bb; st.bestAsk = ba; st.nextOrderId = noid; st.nextTradeId = ntid;
  st.feePool = feePool; st.fundingPool = fundingPool; st.dust = dust; st.bal = bal; st.dep = dep; st.wd = wd;
  st.tracked = ledger[0]; st.net = ledger[1];
  const trim = (s) => { const out = []; for (let i = 0; i < s.px.length; i++) { if (s.px[i] === 0n) break; out.push({ px: s.px[i], total: s.sz[i] }); } return out; };
  st.bids = trim(bidSnap); st.asks = trim(askSnap);
  // level walk
  for (const [side, lv] of [[true, st.bids], [false, st.asks]]) {
    await Promise.all(lv.map(async (l) => { l.lvl = await ex.getLevel(0, side, l.px); }));
  }
  return st;
}

// ---------------------------------------------------------------------------------------------- invariants (state only)
function checkState(c, st, label) {
  const W = (m) => `${m} [after ${label}]`;
  // 1. net position zero (incl. backstop)
  let net = 0n, oiSum = 0n, sumBasis = 0n;
  for (const k of c.allKeys) { net += st.pos.get(k); if (st.pos.get(k) > 0n) oiSum += st.pos.get(k); sumBasis += st.basis.get(k); }
  check(net === 0n, W(`aggregate signed position ${net} != 0`));
  // 4. OI
  check(st.oi === oiSum, W(`market oi ${st.oi} != sum of long sizes ${oiSum}`));
  check(st.oi <= st.maxOI, W(`oi ${st.oi} > maxOI ${st.maxOI}`));

  // 2. book integrity
  const inBook = new Set();
  for (const [side, lv, best] of [[true, st.bids, st.bestBid], [false, st.asks, st.bestAsk]]) {
    const nm = side ? "bid" : "ask";
    check(lv.length === 0 ? best === 0n : lv[0].px === best, W(`${nm} bestPrice ${best} != first level`));
    for (let i = 0; i < lv.length; i++) {
      const l = lv[i];
      if (i > 0) check(side ? lv[i - 1].px > l.px : lv[i - 1].px < l.px, W(`${nm} levels not strictly ${side ? "descending" : "ascending"} at ${i}`));
      check(l.lvl.prevPrice === (i === 0 ? 0n : lv[i - 1].px), W(`${nm} level ${l.px} prevPrice link broken`));
      check(l.lvl.nextPrice === (i === lv.length - 1 ? 0n : lv[i + 1].px), W(`${nm} level ${l.px} nextPrice link broken`));
      check(l.total === l.lvl.total, W(`${nm} snapshot total != level total`));
      check(l.total > 0n, W(`${nm} level ${l.px} is empty but linked`));
      let sum = 0n, id = l.lvl.head, prev = 0n, n = 0;
      while (id !== 0n) {
        const o = st.orders.get(id);
        check(o !== undefined, W(`${nm} level ${l.px} contains order ${id} not in any openOrderIds`));
        check(!inBook.has(id), W(`order ${id} appears twice in book`));
        inBook.add(id);
        check(o.prev === prev, W(`order ${id} prev ${o.prev} != ${prev}`));
        check(o.price === l.px && o.isBuy === side && o.market === 0, W(`order ${id} wrong level/side`));
        check(o.size > 0n, W(`order ${id} zero size in book`));
        sum += o.size; prev = id; id = o.next;
        check(++n < 10_000, W("level walk cycle"));
      }
      check(l.lvl.tail === prev, W(`${nm} level ${l.px} tail ${l.lvl.tail} != last ${prev}`));
      check(sum === l.total, W(`${nm} level ${l.px} total ${l.total} != sum of orders ${sum}`));
    }
  }
  if (st.bestBid !== 0n && st.bestAsk !== 0n) check(st.bestBid < st.bestAsk, W(`crossed book ${st.bestBid} >= ${st.bestAsk}`));
  // every open order id is in the book with the right owner, and vice versa
  let openCount = 0;
  for (const k of c.allKeys) {
    let rsv = 0n;
    for (const id of st.open.get(k)) {
      openCount++;
      const o = st.orders.get(id);
      check(o.acct === k, W(`order ${id} owner ${o.acct} != indexed under ${k}`));
      check(inBook.has(id), W(`open order ${id} not reachable in book`));
      rsv += o.reserve;
    }
    // 3. reserved == sum of order reserves
    check(st.resv.get(k) === rsv, W(`reserved[${k.slice(0, 8)}] ${st.resv.get(k)} != sum(order.reserve) ${rsv}`));
  }
  check(inBook.size === openCount, W(`book has ${inBook.size} orders, accounts index ${openCount}`));

  // 9. token conservation
  check(st.bal === st.dep - st.wd, W(`USDC balance ${st.bal} != deposited-withdrawn ${st.dep - st.wd}`));
  // fee bookkeeping
  check(st.feePool === c.feeSum, W(`feePool ${st.feePool} != sum of fill fees ${c.feeSum}`));
  // ledger conservation (holds mid-run too): tracked-net = sum(realized pnl) + floor(dust/1e8),  sum(basis) = 1e8*sum(pnl) + dust
  //  =>  0 <= sumBasis - 1e8*(tracked-net) < 1e8
  const d = st.tracked - st.net;
  const rem = sumBasis - d * SIZE_SCALE;
  check(rem >= 0n && rem < SIZE_SCALE, W(`ledger identity broken: tracked-net=${d}, sumBasis=${sumBasis}, residual=${rem}`));
}

// ---------------------------------------------------------------------------------------------- per-action checks
function parseEvents(c, r) {
  const exAddr = c.exAddr;
  const out = [];
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== exAddr) continue;
    try { const p = c.ex.interface.parseLog(l); if (p) out.push(p); } catch {}
  }
  return out;
}

function absorbEvents(c, evs) {
  for (const e of evs) {
    if (e.name === "OrderAccepted") c.meta.set(e.args.id, { reduceOnly: e.args.reduceOnly, isBuy: e.args.isBuy, price: e.args.price, size: e.args.size, acct: e.args.acct, tif: Number(e.args.tif) });
    if (e.name === "Fill") { c.fills++; c.feeSum += e.args.takerFee + e.args.makerFee; }
    if (e.name === "FundingSettled") c.fundSettles++;
  }
}

function touchedSet(c, pre, evs, actor) {
  const t = new Set();
  if (actor) t.add(actor);
  for (const e of evs) {
    if (e.name === "Fill") { t.add(e.args.maker); t.add(e.args.taker); }
    if (e.name === "FundingSettled") t.add(e.args.acct);
    if (e.name === "OrderCanceled") { const o = pre.orders.get(e.args.id); if (o) t.add(o.acct); }
    if (e.name === "OrderAccepted") t.add(e.args.acct);
  }
  return t;
}

function checkUntouched(c, pre, post, touched, label) {
  for (const k of c.allKeys) {
    if (touched.has(k)) continue;
    check(pre.coll.get(k) === post.coll.get(k), `collateral of untouched account ${k.slice(0, 8)} changed ${pre.coll.get(k)} -> ${post.coll.get(k)} (${label})`);
    check(pre.pos.get(k) === post.pos.get(k), `position of untouched account ${k.slice(0, 8)} changed (${label})`);
  }
}

// order action (place / replace) success checks: invariants 5 & 6 and fill/position consistency
function checkOrderTx(c, pre, post, evs, actor, label, isReplace) {
  const acc = evs.filter((e) => e.name === "OrderAccepted");
  check(acc.length === 1, `${label}: expected exactly one OrderAccepted, got ${acc.length}`);
  const A = acc[0].args;
  check(A.acct === actor, `${label}: accepted for wrong account`);
  const fills = evs.filter((e) => e.name === "Fill").map((e) => e.args);
  const rested = evs.filter((e) => e.name === "OrderRested");
  const truncated = evs.some((e) => e.name === "OrderTruncated");
  const tif = Number(A.tif);
  let sum = 0n; let lastPx = null;
  const bySide = new Map();
  let simPos = new Map(pre.pos);
  for (const f of fills) {
    check(f.taker === actor, `${label}: fill with foreign taker`);
    check(f.takerIsBuy === A.isBuy, `${label}: fill side mismatch`);
    sum += f.size;
    // 5. never worse than the limit
    check(A.isBuy ? f.price <= A.price : f.price >= A.price, `${label}: fill at ${f.price} worse than limit ${A.price} (${A.isBuy ? "buy" : "sell"})`);
    // price priority across the sweep
    if (lastPx !== null) check(A.isBuy ? f.price >= lastPx : f.price <= lastPx, `${label}: fills not in price priority (${lastPx} then ${f.price})`);
    lastPx = f.price;
    const mo = pre.orders.get(f.makerOrderId);
    check(mo !== undefined, `${label}: fill against order ${f.makerOrderId} which was not open`);
    check(mo.acct === f.maker && mo.price === f.price && mo.isBuy !== f.takerIsBuy, `${label}: fill does not match maker order ${f.makerOrderId}`);
    check(f.maker !== f.taker, `${label}: self trade fill`);
    bySide.set(f.makerOrderId, (bySide.get(f.makerOrderId) ?? 0n) + f.size);
    // replay positions
    const dT = f.takerIsBuy ? f.size : -f.size;
    for (const [acct, delta, ro, role] of [[f.maker, -dT, mo.reduceOnly, "maker"], [f.taker, dT, A.reduceOnly, "taker"]]) {
      const old = simPos.get(acct); const nw = old + delta;
      if (ro) {
        // 6. reduce-only: never grows |pos| nor flips sign
        check(old !== 0n && abs(nw) < abs(old) && (nw === 0n || sgn(nw) === sgn(old)), `${label}: reduce-only ${role} order moved position ${old} -> ${nw}`);
      }
      simPos.set(acct, nw);
    }
  }
  check(sum <= A.size, `${label}: filled ${sum} > order size ${A.size}`);
  for (const [oid, q] of bySide) {
    const mo = pre.orders.get(oid); const now = post.orders.get(oid);
    check(q <= mo.size, `${label}: maker ${oid} overfilled ${q} > ${mo.size}`);
    if (now) check(now.size === mo.size - q, `${label}: maker ${oid} remaining ${now.size} != ${mo.size}-${q}`);
  }
  for (const k of c.allKeys) check(simPos.get(k) === post.pos.get(k), `${label}: replayed position of ${k.slice(0, 8)} ${simPos.get(k)} != chain ${post.pos.get(k)}`);
  // tif semantics
  if (tif === TIF.PostOnly) {
    check(fills.length === 0, `${label}: PostOnly produced a Fill`);
    if (!SKIP_POSTONLY_REST) check(rested.length === 1, `${label}: PostOnly (non-crossing) order was NOT rested on the book (OrderRested missing)`);
  }
  if (tif === TIF.FOK) { check(sum === A.size, `${label}: FOK succeeded with fill ${sum} < ${A.size}`); check(rested.length === 0, `${label}: FOK rested`); }
  if (tif === TIF.IOC) check(rested.length === 0, `${label}: IOC rested`);
  if (tif === TIF.GTC) {
    if (sum < A.size && !truncated) check(rested.length === 1, `${label}: GTC remainder neither rested nor truncated`);
    if (truncated) check(rested.length === 0, `${label}: truncated GTC rested`);
  }
  if (rested.length === 1) {
    check(sum < A.size, `${label}: rested although fully filled`);
    check(rested[0].args.remaining === A.size - sum, `${label}: rested remaining ${rested[0].args.remaining} != ${A.size - sum}`);
    const o = post.orders.get(A.id);
    check(o && o.acct === actor && o.size === A.size - sum && o.price === A.price && o.isBuy === A.isBuy, `${label}: rested order not in chain state`);
  } else {
    check(!post.orders.has(A.id), `${label}: order ${A.id} present in book although not rested`);
  }
  return { filled: sum, A };
}

// ---------------------------------------------------------------------------------------------- action machinery
const ALLOWED_PLACE = new Set(["PostOnlyCross", "FokUnfilled", "Unhealthy", "ReduceOnlyViolation", "TooManyOrders", "PriceTooFarFromTop", "DuplicateClientId"]);
function allowed(d, extra = {}) {
  if (ALLOWED_PLACE.has(d.name) && extra.place) return true;
  if (d.name === "Expired" && extra.expiry) return true;
  if (d.name === "BadParam" && extra.badParams?.includes(d.args[0])) return true;
  if (d.name === "Unhealthy" && extra.unhealthy) return true;
  if (d.name === "NotAuthorized" && extra.notAuth) return true;
  return false;
}

const STATS = {};
async function attempt(c, label, sendFn, extra) {
  try {
    const tx = await sendFn();
    const r = await tx.wait();
    return { ok: true, r };
  } catch (e) {
    const d = decodeErr(c.ex, e);
    if (!d) throw new Error(`UNEXPECTED non-contract failure in ${label}: ${String(e.message).slice(0, 300)}`);
    if (!allowed(d, extra)) throw new Error(`UNEXPECTED revert in ${label}: ${errStr(d)}`);
    STATS[d.name + (d.name === "BadParam" ? ":" + d.args[0] : "")] = (STATS[d.name + (d.name === "BadParam" ? ":" + d.args[0] : "")] ?? 0) + 1;
    return { ok: false, err: d };
  }
}

async function refreshOracle(c, px) {
  c.px = px ?? c.px;
  await c.orc.set(FEED, c.px);
  c.oracleTs = await time.latest();
}
async function ensureFresh(c) {
  const now = await time.latest();
  if (now - c.oracleTs > 25) await refreshOracle(c);
}

const signerOf = (c, i) => c.traders[i];
const keyOf = (c, i) => c.keys[i];

function mkOrder(c, a) {
  let price = c.px + BigInt(a.off) * TICK;
  if (price < TICK) price = TICK;
  price = (price / TICK) * TICK;
  return order({
    isBuy: a.buy, price, size: BigInt(a.lots) * LOT, tif: a.tif, reduceOnly: a.ro, cloid: BigInt(a.cloid),
    expiry: a.exp > 0 ? BigInt(await_now_sync(c) + a.exp) : 0n,
  });
}
function await_now_sync(c) { return c.lastBlockTs; }

async function runAction(c, a, idx) {
  await ensureFresh(c);
  c.lastBlockTs = await time.latest();
  const pre = c.st;
  const label = `#${idx} ${JSON.stringify(a, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
  let evs = [], actor = null, ok = true, r = null, extra;

  const finish = async (tag) => {
    absorbEvents(c, evs);
    const post = await readState(c);
    return post;
  };

  switch (a.t) {
    case "place": {
      const s = signerOf(c, a.a); actor = keyOf(c, a.a);
      const o = mkOrder(c, a);
      extra = { place: true, expiry: a.exp > 0, badParams: ["min notional"] };
      const res = await attempt(c, label, () => c.ex.connect(s).placeOrder(s.address, 0, o, { gasLimit: GAS }), extra);
      ok = res.ok; r = res.r;
      if (ok) {
        evs = parseEvents(c, r);
        absorbEvents(c, evs);
        const post = await readState(c);
        checkOrderTx(c, pre, post, evs, actor, label, false);
        checkUntouched(c, pre, post, touchedSet(c, pre, evs, actor), label);
        c.st = post; checkState(c, post, label);
        return;
      }
      break;
    }
    case "replace": {
      const s = signerOf(c, a.a); actor = keyOf(c, a.a);
      const mine = pre.open.get(actor);
      if (mine.length === 0) return; // nothing to replace
      const oldId = mine[a.pick % mine.length];
      const o = mkOrder(c, a);
      extra = { place: true, expiry: a.exp > 0, badParams: ["min notional", "no order"] };
      const res = await attempt(c, label, () => c.ex.connect(s).replaceOrder(oldId, o, { gasLimit: GAS }), extra);
      ok = res.ok; r = res.r;
      if (ok) {
        evs = parseEvents(c, r);
        absorbEvents(c, evs);
        const post = await readState(c);
        // the replaced order must be gone
        check(!post.orders.has(oldId), `${label}: replaced order ${oldId} still open`);
        // a Replaced cancel must have been emitted for it
        check(evs.some((e) => e.name === "OrderCanceled" && e.args.id === oldId), `${label}: no cancel event for replaced order`);
        // make the pre-state not contain the replaced order for fill checks (cannot be a maker of its own replacement anyway)
        checkOrderTx(c, pre, post, evs, actor, label, true);
        checkUntouched(c, pre, post, touchedSet(c, pre, evs, actor), label);
        c.st = post; checkState(c, post, label);
        return;
      }
      break;
    }
    case "cancel": {
      // pick any open order in the whole book (possibly someone else's -> sent by its owner)
      const all = [...pre.orders.keys()];
      if (all.length === 0 || a.stale) {
        const id = a.stale ? BigInt(1 + (a.pick % 50)) : 999_999n;
        const s = signerOf(c, a.a); actor = keyOf(c, a.a);
        const known = pre.orders.get(id);
        if (known && known.acct === actor) { /* real order of the sender; fine */ }
        const res = await attempt(c, label, () => c.ex.connect(s).cancelOrder(id, { gasLimit: GAS }), { badParams: ["no order"], notAuth: true });
        ok = res.ok; r = res.r;
        if (ok) { evs = parseEvents(c, r); }
        break;
      }
      const id = all[a.pick % all.length];
      const o = pre.orders.get(id);
      const i = c.keys.indexOf(o.acct);
      if (i < 0 || i >= N_TRADERS) return; // backstop's orders: not cancelable by traders
      const s = signerOf(c, i); actor = o.acct;
      const res = await attempt(c, label, () => c.ex.connect(s).cancelOrder(id, { gasLimit: GAS }), {});
      ok = res.ok; r = res.r; evs = parseEvents(c, r);
      const post = await readState(c);
      check(!post.orders.has(id), `${label}: canceled order ${id} still open`);
      check(!post.open.get(actor).includes(id), `${label}: canceled order ${id} still in openOrderIds`);
      checkUntouched(c, pre, post, touchedSet(c, pre, evs, actor), label);
      for (const k of c.allKeys) check(post.pos.get(k) === pre.pos.get(k), `${label}: cancel moved a position`);
      c.st = post; checkState(c, post, label);
      return;
    }
    case "cancelAll": {
      const s = signerOf(c, a.a); actor = keyOf(c, a.a);
      const res = await attempt(c, label, () => c.ex.connect(s).cancelAll(s.address, 0, { gasLimit: GAS }), {});
      r = res.r; evs = parseEvents(c, r);
      const post = await readState(c);
      check(post.open.get(actor).length === 0, `${label}: orders remain after cancelAll`);
      checkUntouched(c, pre, post, touchedSet(c, pre, evs, actor), label);
      for (const k of c.allKeys) check(post.pos.get(k) === pre.pos.get(k), `${label}: cancelAll moved a position`);
      c.st = post; checkState(c, post, label);
      return;
    }
    case "tick": {
      await time.increase(a.dt);
      let np = c.px + BigInt(a.dp) * TICK;
      if (np < 47_000n * 1_000_000n) np = 47_000n * 1_000_000n;
      if (np > 53_000n * 1_000_000n) np = 53_000n * 1_000_000n;
      await refreshOracle(c, np);
      const post = await readState(c);
      checkUntouched(c, pre, post, new Set(), label);
      c.st = post; checkState(c, post, label);
      return;
    }
    case "poke": {
      const s = signerOf(c, a.a);
      const res = await attempt(c, label, () => c.ex.connect(s).pokeFunding(0, { gasLimit: GAS }), {});
      evs = parseEvents(c, res.r);
      const post = await readState(c);
      checkUntouched(c, pre, post, new Set(), label);
      c.st = post; checkState(c, post, label);
      return;
    }
    case "deposit": {
      const s = signerOf(c, a.a); actor = keyOf(c, a.a);
      const amt = usd(a.amt);
      const res = await attempt(c, label, () => c.ex.connect(s).deposit(s.address, 0, amt, { gasLimit: GAS }), {});
      const post = await readState(c);
      check(post.coll.get(actor) === pre.coll.get(actor) + amt, `${label}: deposit credited wrong amount`);
      checkUntouched(c, pre, post, new Set([actor]), label);
      c.st = post; checkState(c, post, label);
      return;
    }
    case "withdraw": {
      const s = signerOf(c, a.a); actor = keyOf(c, a.a);
      const amt = usd(a.amt);
      const res = await attempt(c, label, () => c.ex.connect(s).withdraw(0, amt, { gasLimit: GAS }), { unhealthy: true });
      ok = res.ok;
      if (ok) {
        evs = parseEvents(c, res.r);
        const owed = evs.filter((e) => e.name === "FundingSettled" && e.args.acct === actor).reduce((x, e) => x + e.args.owed, 0n);
        absorbEvents(c, evs);
        const post = await readState(c);
        check(post.coll.get(actor) === pre.coll.get(actor) - amt - owed, `${label}: withdraw collateral delta wrong (${post.coll.get(actor) - pre.coll.get(actor)} vs -${amt} - funding ${owed})`);
        // 8. withdrawal safety: equity >= IM + reserved afterwards
        const as = await c.ex.accountState(actor);
        check(as.equity >= as.im + as.resv, `${label}: withdraw left equity ${as.equity} < im ${as.im} + reserved ${as.resv}`);
        checkUntouched(c, pre, post, touchedSet(c, pre, evs, actor), label);
        c.st = post; checkState(c, post, label);
        return;
      }
      break;
    }
    default: throw new Error("unknown action " + a.t);
  }

  // revert path: absolutely no state change
  if (!ok) {
    const post = await readState(c);
    for (const k of c.allKeys) {
      check(post.pos.get(k) === pre.pos.get(k) && post.coll.get(k) === pre.coll.get(k) && post.resv.get(k) === pre.resv.get(k), `${label}: reverted tx changed account state`);
    }
    check(post.nextOrderId === pre.nextOrderId && post.nextTradeId === pre.nextTradeId && post.bestBid === pre.bestBid && post.bestAsk === pre.bestAsk, `${label}: reverted tx changed book counters`);
    c.st = post; checkState(c, post, label);
    return;
  }
  // non-order success paths that fell through (stale cancel success)
  absorbEvents(c, evs);
  const post = await readState(c);
  c.st = post; checkState(c, post, label);
}

// ---------------------------------------------------------------------------------------------- unwind + final ledger checks
async function unwind(c) {
  const { ex, cp } = c;
  await ensureFresh(c);
  for (let i = 0; i < N_TRADERS; i++) { const s = signerOf(c, i); await ex.connect(s).cancelAll(s.address, 0, { gasLimit: GAS }); }
  await ex.connect(cp).cancelAll(cp.address, 0, { gasLimit: GAS });
  let st = await readState(c);
  check(st.bestBid === 0n && st.bestAsk === 0n, "book not empty after cancelAll");
  c.st = st; checkState(c, st, "cancelAll-all");
  for (let i = 0; i < N_TRADERS; i++) {
    await ensureFresh(c);
    const k = keyOf(c, i); const pos = c.st.pos.get(k);
    if (pos === 0n) continue;
    const s = signerOf(c, i);
    const size = abs(pos);
    const cpSize = size < 4n * LOT ? 4n * LOT : size; // cp order must satisfy min notional (>= $10 even at 47k)
    const closerSells = pos > 0n;
    const px = c.px;
    await ex.connect(cp).placeOrder(cp.address, 0, order({ isBuy: closerSells, price: px, size: cpSize }), { gasLimit: GAS });
    const tx = await ex.connect(s).placeOrder(s.address, 0, order({ isBuy: !closerSells, price: px, size, tif: TIF.IOC, reduceOnly: true }), { gasLimit: GAS });
    const r = await tx.wait(); const evs = parseEvents(c, r); absorbEvents(c, evs);
    await ex.connect(cp).cancelAll(cp.address, 0, { gasLimit: GAS });
    st = await readState(c);
    check(st.pos.get(k) === 0n, `unwind: account ${i} not flat (${st.pos.get(k)})`);
    c.st = st; checkState(c, st, `unwind-${i}`);
  }
  // cp must be flat too; everything flat
  st = await readState(c);
  for (const k of c.allKeys) check(st.pos.get(k) === 0n, `unwind: ${k.slice(0, 8)} not flat: ${st.pos.get(k)}`);
  check(st.oi === 0n, "oi != 0 after unwind");
  check(st.bestBid === 0n && st.bestAsk === 0n, "book not empty after unwind");
  // 7. ledger conservation at flat
  const drift = st.tracked - st.net;
  check(abs(drift) <= BigInt(c.fills), `ledger drift ${drift} exceeds number of fills ${c.fills}`);
  check(drift === 0n, `ledger drift ${drift} != 0 at flat (exact identity expected)`);
  // funding pool: sum of rounding residue only: 0 <= pool <= number of funding settlements
  check(st.fundingPool >= 0n && st.fundingPool <= BigInt(c.fundSettles), `fundingPool ${st.fundingPool} outside [0, ${c.fundSettles}] at flat`);
  check(st.feePool === c.feeSum, `feePool ${st.feePool} != sum of fill fees ${c.feeSum}`);
  check(st.dust >= 0n && st.dust <= BigInt(c.fills) * 2n * SIZE_SCALE, `dustBasis ${st.dust} implausible`);
  for (const k of c.allKeys) check(st.resv.get(k) === 0n, "reserved != 0 at flat/no orders");
  return st;
}

// ---------------------------------------------------------------------------------------------- arbitraries
const tifArb = fc.constantFrom(0, 0, 0, 1, 1, 2, 3, 3);
const offArb = fc.oneof({ weight: 8, arbitrary: fc.integer({ min: -6, max: 6 }) }, { weight: 3, arbitrary: fc.integer({ min: -30, max: 30 }) }, { weight: 1, arbitrary: fc.integer({ min: -300, max: 300 }) });
const lotsArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 2, max: 40 }) },
  { weight: 3, arbitrary: fc.integer({ min: 40, max: 1500 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1500, max: 20000 }) },
);
const expArb = fc.constantFrom(0, 0, 0, 0, 12, 40, 400);
const orderFields = {
  a: fc.integer({ min: 0, max: N_TRADERS - 1 }), buy: fc.boolean(), off: offArb, lots: lotsArb, tif: tifArb,
  ro: fc.constantFrom(false, false, false, false, false, false, false, true), cloid: fc.constantFrom(0, 0, 0, 0, 0, 0, 1, 2, 3), exp: expArb,
};
const actionArb = fc.oneof(
  { weight: 10, arbitrary: fc.record({ t: fc.constant("place"), ...orderFields }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("replace"), pick: fc.nat(1000), ...orderFields }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("cancel"), a: fc.integer({ min: 0, max: N_TRADERS - 1 }), pick: fc.nat(1000), stale: fc.constantFrom(false, false, false, false, true) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("cancelAll"), a: fc.integer({ min: 0, max: N_TRADERS - 1 }) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("tick"), dt: fc.oneof({ weight: 5, arbitrary: fc.integer({ min: 1, max: 20 }) }, { weight: 1, arbitrary: fc.integer({ min: 1800, max: 9000 }) }), dp: fc.integer({ min: -150, max: 150 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("poke"), a: fc.integer({ min: 0, max: N_TRADERS - 1 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("deposit"), a: fc.integer({ min: 0, max: N_TRADERS - 1 }), amt: fc.integer({ min: 1, max: 3000 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("withdraw"), a: fc.integer({ min: 0, max: N_TRADERS - 1 }), amt: fc.integer({ min: 1, max: 20000 }) }) },
);

async function newCtx() {
  const e = await loadFixture(fuzzFixture);
  const c = { ...e };
  c.exAddr = (await e.ex.getAddress()).toLowerCase();
  c.keys = [...e.traders.map((s) => acctKey(s.address, 0)), acctKey(e.cp.address, 0)]; // traders..., cp  (ledgerTotals adds BACKSTOP itself)
  c.allKeys = [...c.keys, BACKSTOP];
  c.px = BASE_PX; c.meta = new Map(); c.fills = 0; c.feeSum = 0n; c.fundSettles = 0;
  await refreshOracle(c, BASE_PX);
  c.st = await readState(c);
  checkState(c, c.st, "init");
  return c;
}

// ================================================================================================ tests
describe("fuzz: model-based random action sequences", function () {
  this.timeout(FUZZ_TIMEOUT);

  it(`invariants hold over random sequences (runs=${RUNS}, len<=${LEN}, seed=${SEED})`, async function () {
    const t0 = Date.now();
    let totalActions = 0, runsDone = 0, totalFills = 0;
    const prop = fc.asyncProperty(fc.array(actionArb, { minLength: Math.min(10, LEN), maxLength: LEN, size: "max" }), async (actions) => {
      const c = await newCtx();
      for (let i = 0; i < actions.length; i++) {
        try { await runAction(c, actions[i], i); } catch (e) { e.message = `(action ${i}/${actions.length}) ` + e.message; throw e; }
        totalActions++;
      }
      await unwind(c);
      runsDone++; totalFills += c.fills;
    });
    try {
      await fc.assert(prop, { numRuns: RUNS, seed: SEED, verbose: 0, markInterruptAsFailure: true });
    } catch (e) {
      console.log(`\n      FUZZ FAILURE. Reproduce with: FUZZ_SEED=${SEED} FUZZ_RUNS=${RUNS} FUZZ_LEN=${LEN} npx hardhat test test/fuzz.test.js\n`);
      throw e;
    }
    console.log(`      tolerated reverts: ${JSON.stringify(STATS)}`);
    console.log(`      fuzz: ${runsDone} runs, ${totalActions} actions, ${totalFills} fills, ${((Date.now() - t0) / 1000).toFixed(1)}s (seed ${SEED})`);
  });

  it("PostOnly (non-crossing) rests on the book [targeted property]", async function () {
    const c = await newCtx();
    const s = c.traders[0];
    const r = await (await c.ex.connect(s).placeOrder(s.address, 0, order({ isBuy: true, price: BASE_PX - 10n * TICK, size: btc(0.1), tif: TIF.PostOnly }), { gasLimit: GAS })).wait();
    const evs = parseEvents(c, r).map((e) => e.name);
    expect(evs, "PostOnly order should emit OrderRested").to.include("OrderRested");
    expect(await c.ex.bestPrice(0, true)).to.equal(BASE_PX - 10n * TICK);
  });
});

// ================================================================================================ adversarial book
describe("fuzz: adversarial dense book (bounded gas)", function () {
  this.timeout(600000);
  const GAS_BOUND = 4_500_000n; // far below block gas limit; see printed numbers

  async function advFixture() {
    const e = await deploy();
    for (const s of [e.alice, e.bob]) await e.ex.connect(s).deposit(s.address, 0, usd(200_000));
    return e;
  }

  async function fundSubs(e, n) {
    for (let sub = 0; sub < n; sub++) await e.ex.connect(e.alice).deposit(e.alice.address, sub, usd(100));
  }
  const refresh = (e) => e.oracle.set(FEED, usd(50000));

  it("dense multi-level book: large taker gas is bounded by MAX_LEVELS/MAX_TOUCHES; insertion beyond MAX_INSERT_WALK reverts", async () => {
    const e = await loadFixture(advFixture);
    const { ex, alice, bob, oracle } = e;
    const MAXL = Number(await ex.MAX_LEVELS_PER_TX()), MAXT = Number(await ex.MAX_TOUCHES_PER_TX()), WALK = Number(await ex.MAX_INSERT_WALK()), MAXO = Number(await ex.MAX_OPEN_ORDERS());
    const LEVELS = WALK + 6, PER = 2;
    const base = usd(50100);
    const nOrders = LEVELS * PER;
    const nSubs = Math.ceil(nOrders / (MAXO - 2)) + 2;
    await fundSubs(e, nSubs + 2);
    // build worst level first so every insertion is O(1) at the top: 2 orders per level, spacing 2 ticks
    let k = 0;
    for (let i = LEVELS - 1; i >= 0; i--) {
      for (let j = 0; j < PER; j++) {
        if (k % 12 === 0) await refresh(e);
        const sub = Math.floor(k / (MAXO - 2));
        await ex.connect(alice).placeOrder(alice.address, sub, order({ isBuy: false, price: base + BigInt(2 * i) * TICK, size: 3n * LOT }), { gasLimit: GAS });
        k++;
      }
    }
    await refresh(e);
    const snap = await ex.bookSnapshot(0, false, LEVELS + 10);
    expect(snap.px.filter((p) => p !== 0n).length).to.equal(LEVELS);
    console.log(`      built ask book: ${LEVELS} levels, ${nOrders} orders over ${nSubs} sub-accounts`);

    // insertion exactly at walk bound succeeds, one beyond reverts with PriceTooFarFromTop
    const subIns = nSubs + 1;
    const okPx = base + BigInt(2 * WALK + 1) * TICK; // after level WALK -> WALK steps
    const badPx = base + BigInt(2 * (WALK + 1) + 1) * TICK; // WALK+1 steps
    const rOk = await (await ex.connect(alice).placeOrder(alice.address, subIns, order({ isBuy: false, price: okPx, size: 3n * LOT }), { gasLimit: GAS })).wait();
    console.log(`      insertion at walk=${WALK} gas: ${rOk.gasUsed}`);
    await expect(ex.connect(alice).placeOrder(alice.address, subIns, order({ isBuy: false, price: badPx, size: 3n * LOT }), { gasLimit: GAS })).to.be.revertedWithCustomError(ex, "PriceTooFarFromTop");
    const worst = base + BigInt(2 * LEVELS + 10) * TICK;
    await expect(ex.connect(alice).placeOrder(alice.address, subIns, order({ isBuy: false, price: worst, size: 3n * LOT }), { gasLimit: GAS })).to.be.revertedWithCustomError(ex, "PriceTooFarFromTop");
    // existing deep level: joining a level that already exists never walks, even far from top
    const deepExisting = base + BigInt(2 * (LEVELS - 1)) * TICK;
    const rDeep = await (await ex.connect(alice).placeOrder(alice.address, subIns, order({ isBuy: false, price: deepExisting, size: 3n * LOT }), { gasLimit: GAS })).wait();
    console.log(`      join deepest existing level gas: ${rDeep.gasUsed}`);

    // large taker sweeping everything: capped at MAX_LEVELS levels / MAX_TOUCHES touches
    await refresh(e);
    const tx = await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: true, price: base + BigInt(2 * LEVELS + 20) * TICK, size: btc(1), tif: TIF.GTC }), { gasLimit: GAS });
    const r = await tx.wait();
    const names = r.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const fills = names.filter((n) => n.name === "Fill");
    console.log(`      large taker over ${LEVELS} levels: fills=${fills.length} (MAX_LEVELS=${MAXL}, MAX_TOUCHES=${MAXT}) gas=${r.gasUsed}`);
    expect(fills.length).to.equal(Math.min(MAXL * PER, MAXT));
    expect(names.map((n) => n.name)).to.include("OrderTruncated");
    expect(names.map((n) => n.name)).to.not.include("OrderRested");
    expect(r.gasUsed).to.be.lessThan(GAS_BOUND);
    expect(new Set(fills.map((f) => f.args.price)).size).to.equal(MAXL);

    // cancelAll for a full sub-account is bounded by MAX_OPEN_ORDERS
    const rc = await (await ex.connect(alice).cancelAll(alice.address, 1, { gasLimit: GAS })).wait();
    console.log(`      cancelAll (${MAXO - 2} orders) gas: ${rc.gasUsed}`);
    expect(rc.gasUsed).to.be.lessThan(GAS_BOUND);
  });

  it("single dense level (100+ tiny orders): taker touches at most MAX_TOUCHES; expired-maker flood is also bounded", async () => {
    const e = await loadFixture(advFixture);
    const { ex, alice, bob } = e;
    const MAXT = Number(await ex.MAX_TOUCHES_PER_TX()), MAXO = Number(await ex.MAX_OPEN_ORDERS());
    const N = 110;
    const nSubs = Math.ceil(N / (MAXO - 2)) + 1;
    await fundSubs(e, nSubs + 4);
    const px = usd(50100);
    for (let i = 0; i < N; i++) {
      if (i % 12 === 0) await refresh(e);
      await ex.connect(alice).placeOrder(alice.address, Math.floor(i / (MAXO - 2)), order({ isBuy: false, price: px, size: 3n * LOT }), { gasLimit: GAS });
    }
    await refresh(e);
    expect((await ex.getLevel(0, false, px)).total).to.equal(BigInt(N) * 3n * LOT);
    const r = await (await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: true, price: px, size: btc(1), tif: TIF.IOC }), { gasLimit: GAS })).wait();
    const fills = r.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).filter((l) => l && l.name === "Fill");
    console.log(`      single level of ${N} orders: taker fills=${fills.length} (MAX_TOUCHES=${MAXT}) gas=${r.gasUsed}`);
    expect(fills.length).to.equal(MAXT);
    expect(r.gasUsed).to.be.lessThan(GAS_BOUND);
    expect((await ex.getLevel(0, false, px)).total).to.equal(BigInt(N - MAXT) * 3n * LOT);

    // expired flood: 70 short-lived orders on another level; a taker removes at most MAX_TOUCHES of them per tx
    const px2 = usd(50200);
    for (let i = 0; i < 70; i++) {
      if (i % 12 === 0) await refresh(e);
      const exp_ = BigInt(await time.latest()) + 400n;
      await ex.connect(alice).placeOrder(alice.address, 4 + Math.floor(i / (MAXO - 2)), order({ isBuy: false, price: px2, size: 3n * LOT, expiry: exp_ }), { gasLimit: GAS });
    }
    await time.increase(1000);
    await refresh(e);
    // clear px level first so the flood is at the top
    for (let g = 0; g < 3; g++) { await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: true, price: px, size: btc(1), tif: TIF.IOC }), { gasLimit: GAS }); await refresh(e); }
    const before = await ex.getLevel(0, false, px2);
    const r2 = await (await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: true, price: px2, size: btc(1), tif: TIF.IOC }), { gasLimit: GAS })).wait();
    const evs = r2.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const expired = evs.filter((x) => x.name === "OrderCanceled" && Number(x.args.reason) === 1).length;
    console.log(`      expired-maker flood: removed ${expired} expired orders in one tx (MAX_TOUCHES=${MAXT}) gas=${r2.gasUsed}; level had ${before.total / (3n * LOT)} orders`);
    expect(expired).to.be.at.most(MAXT);
    expect(r2.gasUsed).to.be.lessThan(GAS_BOUND);
  });
});
