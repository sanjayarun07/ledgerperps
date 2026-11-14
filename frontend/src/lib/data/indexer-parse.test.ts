import { describe, expect, it } from "vitest";
import bookFx from "./fixtures/book.json";
import candlesFx from "./fixtures/candles.json";
import conditionalsFx from "./fixtures/conditionals.json";
import err404 from "./fixtures/error-404.json";
import fillsFx from "./fixtures/fills.json";
import ordersFx from "./fixtures/orders.json";
import positionsFx from "./fixtures/positions.json";
import statusFx from "./fixtures/status.json";
import tradesFx from "./fixtures/trades.json";
import transfersFx from "./fixtures/transfers.json";
import twapsFx from "./fixtures/twaps.json";
import wsFx from "./fixtures/ws-frames.json";
import { aggregateCandles, baseIntervalFor, getJson, IndexerError } from "./indexer";
import {
  envelope, parseApiError, parseBadDebt, parseBook, parseCandles, parseConditionals, parseFills, parseFundingSettlements, parseLiquidations, parseOrders, parsePositions,
  parseStatus, parseTransfers, parseTwaps, parseWs,
} from "./indexer-parse";

// Fixtures are REAL payloads recorded from the running Rust indexer (scripts/capture-fixtures.mjs); the OpenAPI file has no examples.
// Funding settlements / liquidations / bad-debt are empty on the dev chain, so those use payloads written to the documented schema.
const ME = "0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101";

describe("indexer REST shape parsing", () => {
  it("envelope carries indexed_block and next_cursor", () => {
    const e = envelope(tradesFx);
    expect(typeof e.indexedBlock).toBe("number");
    expect(e.nextCursor === null || typeof e.nextCursor === "string").toBe(true);
    expect(() => envelope({ nope: 1 })).toThrow();
  });
  it("book: decimal strings become bigints, bids high->low, asks low->high, seq preserved", () => {
    const b = parseBook(envelope(bookFx).data);
    expect(b.seq).toBeGreaterThan(0);
    expect(b.asks.length).toBeGreaterThan(0);
    for (let i = 1; i < b.asks.length; i++) expect(b.asks[i][0] > b.asks[i - 1][0]).toBe(true);
    for (let i = 1; i < b.bids.length; i++) expect(b.bids[i][0] < b.bids[i - 1][0]).toBe(true);
    expect(typeof b.asks[0][0]).toBe("bigint");
  });
  it("trades/fills: taker_side -> takerIsBuy, fees and ids as bigint, times in seconds", () => {
    const t = parseFills(envelope(tradesFx).data);
    expect(t.length).toBeGreaterThan(0);
    const raw = (envelope(tradesFx).data as Record<string, string>[])[0];
    expect(t[0].takerIsBuy).toBe(raw.taker_side === "buy");
    expect(t[0].tradeId).toBe(BigInt(raw.trade_id));
    expect(t[0].price).toBe(BigInt(raw.price));
    expect(t[0].time).toBeGreaterThan(1_600_000_000);
    expect(parseFills(envelope(fillsFx).data).length).toBeGreaterThan(0);
  });
  it("candles: scales price 1e6 and base volume 1e8", () => {
    const c = parseCandles(envelope(candlesFx).data);
    const raw = ((envelope(candlesFx).data as { candles: Record<string, string>[] }).candles)[0];
    expect(c[0].open).toBe(Number(raw.o) / 1e6);
    expect(c[0].volume).toBe(Number(raw.v) / 1e8);
    expect(c[0].time).toBe(Number(raw.t));
  });
  it("orders: status, tif, reduce_only and cancel_reason map through", () => {
    const o = parseOrders(envelope(ordersFx).data);
    expect(o.some((x) => x.status === "open")).toBe(true);
    expect(o.some((x) => x.status === "canceled" && x.cancelReason === "user")).toBe(true);
    expect(o[0].isBuy === (((envelope(ordersFx).data as Record<string, string>[])[0].side) === "buy")).toBe(true);
  });
  it("orders: a price_band cancel (WASH-1) is a plain canceled order with its reason label", () => {
    const base = (envelope(ordersFx).data as Record<string, unknown>[])[0];
    const o = parseOrders([{ ...base, status: "canceled", cancel_reason: "price_band" }]);
    expect(o[0]).toMatchObject({ status: "canceled", cancelReason: "price_band" });
  });
  it("positions: signed size/basis, realized pnl and fees", () => {
    const p = parsePositions(envelope(positionsFx).data);
    expect(p[0].size).toBeGreaterThan(0n);
    expect(p[0].feesPaid).toBeGreaterThan(0n);
    expect(p[0].approximate).toBe(false);
  });
  it("conditionals: sibling OCO ids and active flag", () => {
    const c = parseConditionals(envelope(conditionalsFx).data);
    expect(c).toHaveLength(2);
    expect(c.every((x) => x.active && x.reduceOnly)).toBe(true);
    expect(c.find((x) => x.id === 2n)!.sibling).toBe(1n);
    expect(c.find((x) => x.id === 1n)!.above).toBe(true);
  });
  it("twaps: slices_done/failed/interval; nextTime is NOT in the schema and stays 0 for the caller to fill", () => {
    const t = parseTwaps(envelope(twapsFx).data);
    expect(t[0]).toMatchObject({ slices: 3, done: 0, failed: 0, interval: 30, active: true, status: "active", nextTime: 0 });
  });
  it("transfers: internal transfer is negative for the sender and positive for the receiver; kinds map to ledger kinds", () => {
    const rows = parseTransfers(envelope(transfersFx).data, ME);
    expect(rows.map((r) => r.kind).sort()).toEqual(["Deposit", "InternalTransfer", "Withdraw"]);
    const it_ = rows.find((r) => r.kind === "InternalTransfer")!;
    expect(it_.amount).toBeLessThan(0n);
    const counterparty = (envelope(transfersFx).data as { counterparty: string | null }[]).find((x) => x.counterparty)!.counterparty!;
    expect(parseTransfers(envelope(transfersFx).data, counterparty).find((r) => r.kind === "InternalTransfer")!.amount).toBeGreaterThan(0n);
  });
  it("status: lag and head", () => {
    const s = parseStatus(envelope(statusFx).data);
    expect(s).toMatchObject({ ok: true, halted: null });
    expect(s.indexedBlock).toBe(s.chainHead);
  });
  it("schema-shaped payloads: funding settlement, liquidation, bad-debt events", () => {
    expect(parseFundingSettlements([{ acct: ME, market: 0, owed: "-1500000", block: 10, log_index: 2, ts: 1700000000 }])[0]).toMatchObject({ owed: -1500000n, market: 0, block: 10n, time: 1700000000 });
    const tx = "0x" + "11".repeat(32);
    expect(parseLiquidations([{ acct: ME, market: 1, keeper: "0x" + "22".repeat(20), size: "100000000", price: "3000000000", fee: "5", bad_debt: "0", block: 3, log_index: 1, ts: 5, tx_hash: tx }])[0]).toMatchObject({ kind: "Liquidated", amount: 100000000n, market: 1 });
    const ev = parseBadDebt([
      { kind: "bad_debt_unresolved", acct: ME, market: null, amount: "250000000", size: null, price: null, block: 4, log_index: 0, ts: 6, tx_hash: tx },
      { kind: "adl", acct: ME, market: 0, amount: "100", size: "5", price: "50000000000", block: 5, log_index: 0, ts: 7, tx_hash: tx },
      { kind: "recapitalized", acct: null, market: 0, amount: "250000000", size: null, price: null, block: 6, log_index: 0, ts: 8, tx_hash: tx },
    ]);
    expect(ev.map((e) => e.kind)).toEqual(["bad_debt_unresolved", "adl", "recapitalized"]);
    expect(ev[2].acct).toBeNull();
    expect(() => parseBadDebt([{ kind: "mystery", amount: "1", block: 1, ts: 1, tx_hash: tx }])).toThrow(/unknown bad-debt kind/);
  });
  it("rejects malformed payloads instead of guessing (so the source falls back to the chain)", () => {
    expect(() => parseFills([{ trade_id: "1" }])).toThrow();
    expect(() => parseBook({ market: 0, seq: 1, bids: [["1"]], asks: [] })).toThrow();
    expect(() => parseOrders([{ id: "abc" }])).toThrow();
    expect(() => parseCandles({ candles: [{ t: 1, o: "x" }] })).toThrow();
  });
  it("error shape {code,message}", () => {
    expect(parseApiError(err404)).toEqual({ code: "not_found", message: expect.any(String) });
    expect(parseApiError({ data: [] })).toBeNull();
  });
});

describe("indexer websocket frame parsing (recorded frames)", () => {
  const frames = (wsFx as unknown[]).map((f) => parseWs(JSON.stringify(f)));
  it("recognises subscribed / snapshot / delta / trade", () => {
    expect(frames.map((f) => f?.type)).toEqual(expect.arrayContaining(["subscribed", "snapshot", "delta", "trade"]));
    const d = frames.find((f) => f?.type === "delta");
    expect(d && d.type === "delta" && typeof d.size === "bigint" && (d.side === "bid" || d.side === "ask")).toBe(true);
    const t = frames.find((f) => f?.type === "trade");
    expect(t && t.type === "trade" && t.data.market === t.market).toBe(true);
  });
  it("ignores unknown types and non-JSON; resync carries the fork block", () => {
    expect(parseWs("garbage")).toBeNull();
    expect(parseWs(JSON.stringify({ type: "future_thing" }))).toBeNull();
    expect(parseWs(JSON.stringify({ type: "resync", reason: "reorg", fork_block: 12 }))).toEqual({ type: "resync", reason: "reorg", forkBlock: 12 });
    expect(parseWs(JSON.stringify({ type: "error", code: "invalid_argument", message: "m" }))).toMatchObject({ type: "error", code: "invalid_argument" });
  });
});

describe("getJson (fetch layer)", () => {
  const resp = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body }) as unknown as Response;
  it("builds the /v1 URL with encoded params and unwraps the envelope", async () => {
    let url = "";
    const e = await getJson("/markets/0/trades", { limit: 5, order: "asc", cursor: undefined }, (async (u: string) => { url = u; return resp(200, tradesFx); }) as never);
    expect(url).toMatch(/\/v1\/markets\/0\/trades\?limit=5&order=asc$/);
    expect(Array.isArray(e.data)).toBe(true);
  });
  it("surfaces the stable error code and Retry-After on 429", async () => {
    const f = (async () => resp(429, { code: "rate_limited", message: "slow down" }, { "retry-after": "3" })) as never;
    await expect(getJson("/status", {}, f)).rejects.toMatchObject({ status: 429, code: "rate_limited", retryAfter: 3 });
    await expect(getJson("/status", {}, (async () => resp(404, err404)) as never)).rejects.toBeInstanceOf(IndexerError);
  });
});

describe("candle aggregation", () => {
  it("15m is built from 5m candles (open first, close last, high/low extremes, volume summed)", () => {
    const c = (time: number, o: number, h: number, l: number, cl: number, v: number) => ({ time, open: o, high: h, low: l, close: cl, volume: v });
    const out = aggregateCandles([c(0, 1, 5, 1, 2, 1), c(300, 2, 9, 2, 3, 2), c(600, 3, 4, 0.5, 4, 3), c(900, 4, 4, 4, 4, 1)], 900);
    expect(out).toEqual([c(0, 1, 9, 0.5, 4, 6), c(900, 4, 4, 4, 4, 1)]);
    expect(baseIntervalFor(900)).toBe(300);
    expect(baseIntervalFor(3600)).toBe(3600);
    expect(baseIntervalFor(45)).toBeNull();
  });
});

import { parseBackstopEvents } from "./indexer-parse";
describe("backstop events", () => {
  const tx = "0x" + "ab".repeat(32);
  const row = (o: object) => ({ market: null, target: null, block: 5, log_index: 0, ts: 9, tx_hash: tx, ...o });
  it("maps deficit, repayment and ADL skip rows; ignores parameter changes", () => {
    const ev = parseBackstopEvents([
      row({ kind: "backstop_synced", market: 2, from_insurance: "6", to_debt: "9", refunded_insurance: "0", repaid_debt: "0" }),
      row({ kind: "backstop_synced", from_insurance: "0", to_debt: "0", refunded_insurance: "3", repaid_debt: "4" }),
      row({ kind: "adl_skipped", market: 1, target: "0x" + "11".repeat(32), slack: "0" }),
      row({ kind: "adl_hard_prem_set", bps: 2000 }), row({ kind: "withdraw_gate_set", threshold: "5" }),
    ]);
    expect(ev.map((e) => [e.kind, e.amount])).toEqual([["backstop_deficit", 15n], ["backstop_repaid", 7n], ["adl_skipped", 0n]]);
    expect(() => parseBackstopEvents([row({ kind: "mystery" })])).toThrow(/unknown backstop event kind/);
  });
});

describe("backstop phase 2 events", () => {
  const tx = "0x" + "ab".repeat(32);
  const row = (o: object) => ({ market: 0, target: null, block: 7, log_index: 0, ts: 9, tx_hash: tx, ...o });
  it("maps elevated, relaxed, taken and unwound rows and ignores config rows", () => {
    const ev = parseBackstopEvents([
      row({ kind: "backstop_elevated", notional: "2000000" }), row({ kind: "backstop_relaxed" }),
      row({ kind: "backstop_taken", acct: "0x" + "22".repeat(32), size: "50000000", price: 49900000000, taker_sold: false }),
      row({ kind: "backstop_unwound", target: "0x" + "33".repeat(32), size: "10000000", price: 50000000000 }),
      row({ kind: "backstop_cfg_set", soft_notional: "1" }), row({ kind: "backstop_place_open_set", open: false }), row({ kind: "backstop_take_fee_set", bps: 5 }),
    ]);
    expect(ev.map((e) => [e.kind, e.amount, e.price])).toEqual([
      ["backstop_elevated", 2000000n, null], ["backstop_relaxed", 0n, null], ["backstop_taken", 50000000n, 49900000000n], ["backstop_unwound", 10000000n, 50000000000n],
    ]);
  });
});
