// E2E assertions against the running indexer API, using ground truth written by scripts/scenario.js.
//   node tests/check.js <api-base> <expected.json> [--dump out.json]
// --dump writes a canonical dump of (almost) every read endpoint, used to compare a live index with a wiped re-index.
const fs = require("fs");
const API = process.argv[2];
const expected = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const dumpIdx = process.argv.indexOf("--dump");
const DUMP = dumpIdx > 0 ? process.argv[dumpIdx + 1] : null;
let failures = 0, passes = 0;
const ok = (c, msg) => { if (c) { passes++; console.log("  PASS", msg); } else { failures++; console.log("  FAIL", msg); } };
const eq = (a, b, msg) => { const js = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)); const A = js(a), B = js(b); ok(A === B, A === B ? msg : `${msg}\n         got      ${A.slice(0, 400)}\n         expected ${B.slice(0, 400)}`); };

async function get(p) { const r = await fetch(API + p); return { status: r.status, body: await r.json().catch(() => null) }; }
async function all(p, order = "asc") {
  const out = []; let cursor = null;
  for (let i = 0; i < 1000; i++) {
    const sep = p.includes("?") ? "&" : "?";
    const r = await get(`${p}${sep}limit=7&order=${order}${cursor ? "&cursor=" + cursor : ""}`);
    if (r.status !== 200) throw new Error(`${p} -> ${r.status} ${JSON.stringify(r.body)}`);
    out.push(...r.body.data);
    if (!r.body.next_cursor) return out;
    cursor = r.body.next_cursor;
  }
  throw new Error("pagination did not terminate");
}

(async () => {
  if (!process.env.DUMP_ONLY) {
  console.log("== status");
  const st = (await get("/v1/status")).body.data;
  eq(st.indexed_head.number, expected.head, "indexed head == chain head after scenario");
  eq(st.lag_blocks, 0, "lag is 0");
  eq(st.parent_chain_finality.status, "unknown", "parent-chain finality reported as unknown (not conflated with canonical execution)");
  ok(st.canonical_execution && st.canonical_execution.block === expected.head, "canonical_execution block reported separately");
  eq((await get("/readyz")).status, 200, "/readyz 200");
  eq((await get("/healthz")).status, 200, "/healthz 200");

  console.log("== trades (decoded by Rust vs ethers ground truth)");
  for (const m of [0, 1, 2]) {
    const want = expected.fills.filter((f) => f.market === m);
    const got = await all(`/v1/markets/${m}/trades`);
    eq(got.map((t) => [t.trade_id, t.price, t.size, t.maker, t.taker]), want.map((f) => [f.tradeId, f.price, f.size, f.maker, f.taker]), `market ${m}: ${want.length} trades match (cursor-paginated, 7 per page)`);
    const desc = await all(`/v1/markets/${m}/trades`, "desc");
    eq(desc.map((t) => t.trade_id), got.map((t) => t.trade_id).reverse(), `market ${m}: desc pagination is the reverse of asc`);
  }

  console.log("== candles (1m) vs independent JS aggregation");
  for (const m of [0, 1, 2]) {
    const want = expected.candles.filter((c) => c.market === m).map((c) => [c.t, c.o, c.h, c.l, c.c, c.v, c.qv, c.n]);
    const got = (await get(`/v1/markets/${m}/candles?interval=1m&limit=5000`)).body.data.candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v, c.qv, c.n]);
    eq(got, want, `market ${m}: ${want.length} 1m candles match`);
    const h1 = (await get(`/v1/markets/${m}/candles?interval=1h&limit=5000`)).body.data.candles;
    const sumV = h1.reduce((a, c) => a + BigInt(c.v), 0n);
    eq(sumV.toString(), expected.fills.filter((f) => f.market === m).reduce((a, f) => a + BigInt(f.size), 0n).toString(), `market ${m}: 1h candle volume == total filled size`);
  }

  console.log("== book + market stats vs contract views");
  for (const m of [0, 1, 2]) {
    const b = (await get(`/v1/markets/${m}/book?depth=20`)).body.data;
    eq(b.bids, expected.markets[m].bids, `market ${m}: bids match bookSnapshot()`);
    eq(b.asks, expected.markets[m].asks, `market ${m}: asks match bookSnapshot()`);
    const mk = (await get(`/v1/markets/${m}`)).body.data;
    eq(mk.funding_index, expected.markets[m].fundingIndex, `market ${m}: funding index matches contract`);
    eq(mk.open_interest, expected.markets[m].oi, `market ${m}: open interest matches contract`);
    if (expected.markets[m].lastTradePrice !== "0") eq(mk.last_price, expected.markets[m].lastTradePrice, `market ${m}: last price matches contract`);
    eq(mk.state, expected.markets[m].state, `market ${m}: market state`);
    ok(mk.name && mk.config && mk.config.tick, `market ${m}: name + tick/lot config loaded via eth_call (${mk.name})`);
  }

  console.log("== positions / open orders vs contract views");
  for (const [name, key] of Object.entries(expected.accts)) {
    const pos = (await get(`/v1/accounts/${key}/positions`)).body.data;
    const want = Object.entries(expected.positions).filter(([k]) => k.startsWith(name + ":")).map(([k, v]) => [Number(k.split(":")[1]), v.size, v.basis]);
    eq(pos.map((p) => [p.market, p.size, p.basis]), want, `positions for ${name} match positions()`);
    const open = [...(await all(`/v1/accounts/${key}/orders?status=open`)), ...(await all(`/v1/accounts/${key}/orders?status=partially_filled`))].map((o) => String(o.id)).sort();
    eq(open, (expected.openOrders[name] || []).slice().sort(), `open orders for ${name} match openOrderIds()`);
  }

  console.log("== order statuses / TWAP / conditional / liquidation / funding / transfers");
  const aliceOrders = await all(`/v1/accounts/${expected.accts.alice}/orders`);
  const statuses = new Set((await Promise.all(Object.values(expected.accts).map((k) => all(`/v1/accounts/${k}/orders`)))).flat().map((o) => o.status));
  for (const s of ["filled", "canceled", "expired", "open", "partially_filled"]) ok(statuses.has(s), `at least one order with status ${s}`);
  ok(aliceOrders.some((o) => o.parent && o.parent.kind === "twap"), "TWAP child orders linked to their parent");
  ok(aliceOrders.some((o) => o.parent && o.parent.kind === "conditional"), "conditional child order linked to its trigger");
  const twaps = await all(`/v1/accounts/${expected.accts.alice}/twaps`);
  eq(twaps.map((t) => [t.status, t.slices_done]), [["done", 2]], "TWAP 1 done after 2 slices");
  const conds = await all(`/v1/accounts/${expected.accts.alice}/conditionals`);
  eq(conds.map((c) => c.status), ["canceled", "triggered", "canceled"], "conditionals: user-canceled, TP triggered, SL OCO-canceled");
  const liq = await all("/v1/liquidations", "asc");
  eq(liq.length, expected.counts.Liquidated, "liquidation count");
  ok(liq[0] && liq[0].acct === expected.accts.carol, "first liquidated account is carol");
  eq(liq.map((l) => [l.acct, l.market, l.size, l.price, l.bad_debt]), expected.adl.liquidations.map((l) => [l.acct, l.market, l.size, l.price, l.badDebt]), "liquidations (incl. erin's gap-move liquidation with bad debt) match chain events");
  const fund = await all("/v1/markets/0/funding");
  ok(fund.length === expected.counts.FundingUpdated && fund.length > 0, `funding updates indexed (${fund.length})`);
  ok(fund.some((f) => f.rate !== "0"), "non-zero funding rate observed");
  const fs_ = await all(`/v1/accounts/${expected.accts.alice}/funding`);
  ok(fs_.length > 0, "alice has FundingSettled history");
  const dep = await all("/v1/transfers?kind=deposit");
  eq(dep.length, expected.counts.Deposit, "deposit count");
  eq((await all("/v1/transfers?kind=withdraw")).length, expected.counts.Withdraw, "withdraw count");
  ok((await all("/v1/transfers?kind=iso_margin")).length === 2, "isolated margin movements recorded");
  ok((await all("/v1/transfers?kind=internal_transfer")).length === 1, "internal transfer recorded");
  const fillsAcct = await all(`/v1/accounts/${expected.accts.carol}/fills`);
  ok(fillsAcct.length >= 1 && fillsAcct[0].role === "taker", "account fills carry role");

  console.log("== bad debt / ADL / recapitalisation vs chain state (SOL gap-move scenario)");
  {
    const A = expected.adl;
    ok(A.badDebt.length === 3 && ["bad_debt_unresolved", "adl", "recapitalized"].every((k, i) => A.badDebt[i].kind === k), "scenario produced BadDebtUnresolved -> AdlExecuted -> Recapitalized on chain");
    const bd = await all("/v1/bad-debt", "asc");
    eq(bd.map((r) => [r.kind, r.acct, r.market, r.amount, r.size, r.price]),
       A.badDebt.map((r) => [r.kind, r.acct ?? null, r.market ?? null, r.amount, r.size ?? null, r.price ?? null]), "/v1/bad-debt rows equal the three ethers-decoded events (kind, acct, market, amount, size, price)");
    eq((await all("/v1/bad-debt?market=2", "asc")).map((r) => r.kind), ["adl", "recapitalized"], "/v1/bad-debt?market=2 filter");
    const adl = A.badDebt[1], rec = A.badDebt[2], bad = A.badDebt[0];
    ok(BigInt(adl.amount) + BigInt(rec.amount) === BigInt(A.debtAfterLiq), `debt cleared by ADL (${adl.amount}) + recapitalisation (${rec.amount}) == adlDebt after liquidation (${A.debtAfterLiq})`);
    ok(BigInt(bad.amount) <= BigInt(A.debtAfterLiq), "BadDebtUnresolved amount is part of the adl debt");
    eq(A.adlDebtNow, "0", "contract adlDebt(2) is zero after recapitalisation");
    // account views of the ADL target and the liquidated account
    const frankPos = (await get(`/v1/accounts/${expected.accts.frank}/positions?include_closed=true`)).body.data.find((p) => p.market === 2);
    eq(frankPos.size, "0", "ADL target frank (short 6 SOL) was force-closed");
    const gracePos = (await get(`/v1/accounts/${expected.accts.grace}/positions?include_closed=true`)).body.data.find((p) => p.market === 2);
    eq(gracePos.size, (-(4n * 10n ** 8n)).toString(), "grace (not a target) keeps her 4 SOL short");
    eq(BigInt(adl.size).toString(), (6n * 10n ** 8n).toString(), "ADL closed 6 SOL (the target's whole position)");
    const erinPos = (await get(`/v1/accounts/${expected.accts.erin}/positions?include_closed=true`)).body.data.find((p) => p.market === 2);
    eq(erinPos.size, "0", "liquidated erin is flat");
    // backstop: size/basis come from ADL(reduce) and match the contract exactly; only realised pnl uses an estimated price
    const bsPos = (await get(`/v1/accounts/${expected.accts.backstop}/positions?include_closed=true`)).body.data.find((p) => p.market === 2);
    eq([bsPos.size, bsPos.basis], [A.backstopNow.size, A.backstopNow.basis], "backstop size+basis after liquidation+ADL equal positions(BACKSTOP) on chain");
    ok(bsPos.approximate === true && BigInt(bsPos.realized_pnl_error_bound) > 0n, `backstop flagged approximate with an explicit pnl error bound (${bsPos.realized_pnl_error_bound} micro-USDC)`);
    // exact backstop realised pnl on its ADL leg (liquidation price == mark == 80 here): reduce at mk => 0. Indexer must be within its bound.
    const exactPnl = 0n;
    const diff = BigInt(bsPos.realized_pnl) - exactPnl;
    ok((diff < 0n ? -diff : diff) <= BigInt(bsPos.realized_pnl_error_bound), `backstop realised pnl ${bsPos.realized_pnl} vs exact ${exactPnl} within bound ${bsPos.realized_pnl_error_bound}`);
    // the backstop price estimated from AdlExecuted(price, size, debtCleared) recovers the oracle mark (80) to within 1e8/size + 1
    const prem = (BigInt(adl.amount) * 100000000n) / BigInt(adl.size);
    const est = BigInt(adl.price) - prem; // frank is short => pT = mk + prem
    const tol = 100000000n / BigInt(adl.size) + 1n;
    const d2 = est - 80000000n;
    ok((d2 < 0n ? -d2 : d2) <= tol, `estimated backstop fill price ${est} vs real mark 80000000 (|err| ${d2 < 0n ? -d2 : d2} <= ${tol})`);
  }

  console.log("== per-event counters vs ethers-decoded counts");
  const mt = await (await fetch(API + "/metrics")).text();
  for (const [ev, n] of Object.entries(expected.counts)) {
    const m = new RegExp(`indexer_events_total\\{event="${ev}"\\} (\\d+)`).exec(mt);
    eq(m && Number(m[1]), n, `${ev} count`);
  }
  ok(/indexer_unknown_refs_total 0/.test(mt), "no events referenced unseen orders");

  console.log("== error contract");
  let r = await get("/v1/markets/99"); ok(r.status === 404 && r.body.code === "not_found", "404 not_found JSON");
  r = await get("/v1/markets/0/trades?cursor=zz"); ok(r.status === 400 && r.body.code === "invalid_argument", "400 invalid_argument JSON");

  console.log("== websocket snapshot == REST book");
  await new Promise((resolve) => {
    const ws = new WebSocket(API.replace("http", "ws") + "/v1/ws");
    const t = setTimeout(() => { ok(false, "websocket snapshot timeout"); resolve(); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", channel: "book", market: 0 }));
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "snapshot") {
        const rest = (await get("/v1/markets/0/book?depth=1000")).body.data;
        eq([m.seq, m.bids, m.asks], [rest.seq, rest.bids, rest.asks], "ws snapshot (seq, bids, asks) equals REST book");
        clearTimeout(t); ws.close(); resolve();
      }
    };
    ws.onerror = () => { ok(false, "websocket error"); clearTimeout(t); resolve(); };
  });

  }

  if (DUMP) {
    const d = {};
    const strip = (v) => v;
    d.markets = (await get("/v1/markets")).body.data;
    for (const m of [0, 1, 2]) {
      d[`trades${m}`] = await all(`/v1/markets/${m}/trades`);
      d[`funding${m}`] = await all(`/v1/markets/${m}/funding`);
      d[`book${m}`] = (await get(`/v1/markets/${m}/book?depth=1000`)).body.data;
      for (const iv of ["1m", "5m", "1h"]) d[`candles${m}_${iv}`] = (await get(`/v1/markets/${m}/candles?interval=${iv}&limit=5000`)).body.data;
    }
    for (const [name, key] of Object.entries(expected.accts)) {
      d[`orders_${name}`] = await all(`/v1/accounts/${key}/orders`);
      d[`fills_${name}`] = await all(`/v1/accounts/${key}/fills`);
      d[`positions_${name}`] = (await get(`/v1/accounts/${key}/positions?include_closed=true`)).body.data;
      d[`funding_${name}`] = await all(`/v1/accounts/${key}/funding`);
      d[`transfers_${name}`] = await all(`/v1/accounts/${key}/transfers`);
      d[`twaps_${name}`] = await all(`/v1/accounts/${key}/twaps`);
      d[`conds_${name}`] = await all(`/v1/accounts/${key}/conditionals`);
    }
    d.liquidations = await all("/v1/liquidations");
    d.badDebt = await all("/v1/bad-debt");
    d.transfers = await all("/v1/transfers");
    fs.writeFileSync(DUMP, JSON.stringify(strip(d), null, 1));
    console.log(`dumped ${Object.keys(d).length} endpoint results to ${DUMP}`);
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("check crashed:", e); process.exit(2); });
