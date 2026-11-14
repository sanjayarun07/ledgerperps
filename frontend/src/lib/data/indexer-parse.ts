/**
 * Pure parsers for the Rust indexer's documented /v1 JSON (see services/indexer/docs/openapi.yaml). No I/O here so they can be
 * unit-tested against recorded payloads. All large integers arrive as decimal STRINGS; ids / block numbers / timestamps as numbers.
 * Parsers THROW on a malformed payload (missing/ill-typed field) so the data source can fall back to the chain instead of
 * showing silently wrong numbers.
 */
import type { Hex } from "viem";
import type { Candle, Conditional, FundingPayment, IndexerStatus, LedgerEvent, OrderRow, PositionStat, SolvencyEvent, Trade, Twap } from "./types";

type J = Record<string, unknown>;
const isObj = (x: unknown): x is J => typeof x === "object" && x !== null && !Array.isArray(x);

export class ParseError extends Error {}
const bad = (what: string): never => { throw new ParseError(`indexer payload: ${what}`); };

export function obj(x: unknown, what = "object"): J { return isObj(x) ? x : bad(`${what} is not an object`); }
export function arr(x: unknown, what = "array"): unknown[] { return Array.isArray(x) ? x : bad(`${what} is not an array`); }
export function big(x: unknown, what: string): bigint {
  if (typeof x === "string" && /^-?\d+$/.test(x)) return BigInt(x);
  if (typeof x === "number" && Number.isSafeInteger(x)) return BigInt(x);
  return bad(`${what} is not an integer string`);
}
export const bigOrNull = (x: unknown, what: string): bigint | null => (x === null || x === undefined ? null : big(x, what));
export function num(x: unknown, what: string): number { return typeof x === "number" && Number.isFinite(x) ? x : bad(`${what} is not a number`); }
export function str(x: unknown, what: string): string { return typeof x === "string" ? x : bad(`${what} is not a string`); }
export function hex(x: unknown, what: string): Hex { return typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x) ? (x as Hex) : bad(`${what} is not hex`); }

export interface Envelope { data: unknown; indexedBlock: number | null; nextCursor: string | null }
export function envelope(j: unknown): Envelope {
  const o = obj(j, "response");
  if (!("data" in o)) bad("missing data");
  const ib = o.indexed_block;
  return { data: o.data, indexedBlock: typeof ib === "number" ? ib : null, nextCursor: typeof o.next_cursor === "string" ? o.next_cursor : null };
}
/** Stable error shape: { code, message }. Returns null if the body is not one. */
export function parseApiError(j: unknown): { code: string; message: string } | null {
  return isObj(j) && typeof j.code === "string" && typeof j.message === "string" ? { code: j.code, message: j.message } : null;
}

// ---- book ---------------------------------------------------------------------------------------------------------
export type Level = [bigint, bigint];
export function level(x: unknown): Level {
  const a = arr(x, "level");
  if (a.length !== 2) bad("level must have 2 items");
  return [big(a[0], "level price"), big(a[1], "level size")];
}
export interface ParsedBook { market: number; seq: number; bids: Level[]; asks: Level[] }
export function parseBook(data: unknown): ParsedBook {
  const o = obj(data, "book");
  return { market: num(o.market, "book.market"), seq: num(o.seq, "book.seq"), bids: arr(o.bids, "book.bids").map(level), asks: arr(o.asks, "book.asks").map(level) };
}

// ---- trades / fills ----------------------------------------------------------------------------------------------
export function parseFill(x: unknown): Trade {
  const o = obj(x, "fill");
  const side = str(o.taker_side, "fill.taker_side");
  if (side !== "buy" && side !== "sell") bad("fill.taker_side");
  return {
    tradeId: big(o.trade_id, "trade_id"), market: num(o.market, "market"), price: big(o.price, "price"), size: big(o.size, "size"),
    takerIsBuy: side === "buy", time: num(o.ts, "ts"), block: big(o.block, "block"), maker: hex(o.maker, "maker"), taker: hex(o.taker, "taker"),
    takerFee: big(o.taker_fee, "taker_fee"), makerFee: big(o.maker_fee, "maker_fee"), txHash: hex(o.tx_hash, "tx_hash"),
  };
}
export const parseFills = (data: unknown): Trade[] => arr(data, "fills").map(parseFill);

// ---- candles ------------------------------------------------------------------------------------------------------
export function parseCandles(data: unknown): Candle[] {
  const o = obj(data, "candles");
  return arr(o.candles, "candles.candles").map((c) => {
    const x = obj(c, "candle");
    return { time: num(x.t, "t"), open: Number(big(x.o, "o")) / 1e6, high: Number(big(x.h, "h")) / 1e6, low: Number(big(x.l, "l")) / 1e6, close: Number(big(x.c, "c")) / 1e6, volume: Number(big(x.v, "v")) / 1e8 };
  });
}

// ---- orders -------------------------------------------------------------------------------------------------------
export function parseOrder(x: unknown): OrderRow {
  const o = obj(x, "order");
  const side = str(o.side, "order.side");
  return {
    id: big(o.id, "id"), market: num(o.market, "market"), isBuy: side === "buy", price: big(o.price, "price"), size: big(o.size, "size"), filled: big(o.filled, "filled"),
    remaining: big(o.remaining, "remaining"), avgFillPrice: bigOrNull(o.avg_fill_price, "avg_fill_price"), status: str(o.status, "status"), tif: str(o.tif, "tif"),
    reduceOnly: o.reduce_only === true, cancelReason: typeof o.cancel_reason === "string" ? o.cancel_reason : null,
    time: typeof o.updated_ts === "number" ? o.updated_ts : typeof o.created_ts === "number" ? o.created_ts : 0, txHash: typeof o.tx_hash === "string" ? (o.tx_hash as Hex) : null,
  };
}
export const parseOrders = (data: unknown): OrderRow[] => arr(data, "orders").map(parseOrder);

// ---- positions ----------------------------------------------------------------------------------------------------
export function parsePositions(data: unknown): PositionStat[] {
  return arr(data, "positions").map((x) => {
    const o = obj(x, "position");
    return { market: num(o.market, "market"), size: big(o.size, "size"), basis: big(o.basis, "basis"), entryPrice: bigOrNull(o.entry_price, "entry_price"), realizedPnl: big(o.realized_pnl, "realized_pnl"), feesPaid: big(o.fees_paid, "fees_paid"), fundingPaid: big(o.funding_paid, "funding_paid"), approximate: o.approximate === true };
  });
}

// ---- funding / transfers / liquidations ----------------------------------------------------------------------------
export function parseFundingSettlements(data: unknown): FundingPayment[] {
  return arr(data, "funding").map((x) => { const o = obj(x, "settlement"); return { market: num(o.market, "market"), owed: big(o.owed, "owed"), block: big(o.block, "block"), time: num(o.ts, "ts") }; });
}
export function parseFundingRate(data: unknown): { rate: bigint; ts: number } | null {
  const a = arr(data, "funding updates");
  if (!a.length) return null;
  const o = obj(a[0], "funding update");
  return { rate: big(o.rate, "rate"), ts: num(o.ts, "ts") };
}
/** `self` is the 32-byte account key the page is showing; an internal transfer is negative if `self` sent it. */
export function parseTransfers(data: unknown, self: string): LedgerEvent[] {
  return arr(data, "transfers").map((x) => {
    const o = obj(x, "transfer");
    const kind = str(o.kind, "kind");
    const amount = big(o.amount, "amount");
    const base = { block: big(o.block, "block"), time: num(o.ts, "ts"), txHash: hex(o.tx_hash, "tx_hash") };
    switch (kind) {
      case "deposit": return { kind: "Deposit" as const, amount, ...base };
      case "withdraw": return { kind: "Withdraw" as const, amount, ...base };
      case "internal_transfer": return { kind: "InternalTransfer" as const, amount: str(o.acct, "acct").toLowerCase() === self.toLowerCase() ? -amount : amount, ...base };
      case "iso_margin": return { kind: "IsoMargin" as const, amount, market: typeof o.market === "number" ? o.market : undefined, ...base };
      default: return bad(`unknown transfer kind ${kind}`);
    }
  });
}
export function parseLiquidations(data: unknown): LedgerEvent[] {
  return arr(data, "liquidations").map((x) => { const o = obj(x, "liquidation"); return { kind: "Liquidated" as const, amount: big(o.size, "size"), market: num(o.market, "market"), block: big(o.block, "block"), time: num(o.ts, "ts"), txHash: hex(o.tx_hash, "tx_hash") }; });
}

// ---- twaps / conditionals -----------------------------------------------------------------------------------------
export function parseTwap(x: unknown): Twap {
  const o = obj(x, "twap");
  const status = str(o.status, "status");
  if (status !== "active" && status !== "done" && status !== "canceled") bad("twap.status");
  return {
    id: big(o.id, "id"), market: num(o.market, "market"), isBuy: str(o.side, "side") === "buy", total: big(o.total, "total"), filled: big(o.filled, "filled"),
    slices: num(o.slices, "slices"), done: num(o.slices_done, "slices_done"), failed: num(o.slices_failed, "slices_failed"), interval: num(o.interval_secs, "interval_secs"),
    nextTime: 0, // NOT in the indexer schema: callers fill it from the chain's twapStatus for active schedules
    slippageBps: num(o.slippage_bps, "slippage_bps"), reduceOnly: o.reduce_only === true, active: status === "active", status: status as Twap["status"],
  };
}
export const parseTwaps = (data: unknown): Twap[] => arr(data, "twaps").map(parseTwap);
export function parseConditional(x: unknown): Conditional {
  const o = obj(x, "conditional");
  return {
    id: big(o.id, "id"), market: num(o.market, "market"), isBuy: str(o.side, "side") === "buy", above: o.above === true, trigger: big(o.trigger, "trigger"), limit: big(o.limit, "limit"),
    size: big(o.size, "size"), reduceOnly: o.reduce_only === true, sibling: big(o.sibling ?? 0, "sibling"), active: str(o.status, "status") === "active",
  };
}
export const parseConditionals = (data: unknown): Conditional[] => arr(data, "conditionals").map(parseConditional);

// ---- bad debt / ADL ----------------------------------------------------------------------------------------------
export function parseBadDebt(data: unknown): SolvencyEvent[] {
  return arr(data, "bad-debt").map((x) => {
    const o = obj(x, "bad-debt event");
    const kind = str(o.kind, "kind");
    if (kind !== "adl" && kind !== "recapitalized" && kind !== "bad_debt_unresolved") bad(`unknown bad-debt kind ${kind}`);
    return { kind: kind as SolvencyEvent["kind"], market: typeof o.market === "number" ? o.market : null, acct: typeof o.acct === "string" ? (o.acct as Hex) : null, amount: big(o.amount, "amount"), size: bigOrNull(o.size, "size"), price: bigOrNull(o.price, "price"), block: big(o.block, "block"), time: num(o.ts, "ts"), txHash: hex(o.tx_hash, "tx_hash") };
  });
}

/** `/v1/backstop/events` -> solvency rows (backstop deficit / repayment / ADL skip). Parameter-change events are not rows. */
export function parseBackstopEvents(data: unknown): SolvencyEvent[] {
  const out: SolvencyEvent[] = [];
  for (const x of arr(data, "backstop events")) {
    const o = obj(x, "backstop event");
    const kind = str(o.kind, "kind");
    const base = { block: big(o.block, "block"), time: num(o.ts, "ts"), txHash: hex(o.tx_hash, "tx_hash"), size: null, price: null };
    const n = (v: unknown) => (typeof v === "string" ? BigInt(v) : 0n);
    if (kind === "backstop_synced") {
      const d = n(o.from_insurance) + n(o.to_debt);
      out.push(d > 0n ? { ...base, kind: "backstop_deficit", market: typeof o.market === "number" ? o.market : null, acct: null, amount: d } : { ...base, kind: "backstop_repaid", market: null, acct: null, amount: n(o.refunded_insurance) + n(o.repaid_debt) });
    } else if (kind === "adl_skipped") out.push({ ...base, kind: "adl_skipped", market: typeof o.market === "number" ? o.market : null, acct: typeof o.target === "string" ? (o.target as Hex) : null, amount: n(o.slack) });
    else if (kind === "backstop_elevated") out.push({ ...base, kind: "backstop_elevated", market: typeof o.market === "number" ? o.market : null, acct: null, amount: n(o.notional) });
    else if (kind === "backstop_relaxed") out.push({ ...base, kind: "backstop_relaxed", market: typeof o.market === "number" ? o.market : null, acct: null, amount: 0n });
    else if (kind === "backstop_taken") out.push({ ...base, kind: "backstop_taken", market: typeof o.market === "number" ? o.market : null, acct: typeof o.acct === "string" ? (o.acct as Hex) : null, amount: n(o.size), size: n(o.size), price: typeof o.price === "number" ? BigInt(o.price) : null });
    else if (kind === "backstop_unwound") out.push({ ...base, kind: "backstop_unwound", market: typeof o.market === "number" ? o.market : null, acct: typeof o.target === "string" ? (o.target as Hex) : null, amount: n(o.size), size: n(o.size), price: typeof o.price === "number" ? BigInt(o.price) : null });
    else if (!["adl_hard_prem_set", "withdraw_gate_set", "backstop_cfg_set", "backstop_place_open_set", "backstop_take_fee_set"].includes(kind)) bad(`unknown backstop event kind ${kind}`);
  }
  return out;
}

// ---- status ------------------------------------------------------------------------------------------------------
export function parseStatus(data: unknown): IndexerStatus {
  const o = obj(data, "status");
  const head = isObj(o.indexed_head) ? o.indexed_head : null;
  return {
    ok: true, synced: o.synced === true, lagBlocks: typeof o.lag_blocks === "number" ? o.lag_blocks : null, indexedBlock: head && typeof head.number === "number" ? head.number : null,
    chainHead: typeof o.chain_head === "number" ? o.chain_head : null, halted: typeof o.halted === "string" ? o.halted : null,
  };
}

// ---- websocket frames ---------------------------------------------------------------------------------------------
export type WsMsg =
  | { type: "subscribed"; channel: string }
  | { type: "snapshot"; channel: "book"; market: number; seq: number; bids: Level[]; asks: Level[] }
  | { type: "delta"; channel: "book"; market: number; seq: number; side: "bid" | "ask"; price: bigint; size: bigint }
  | { type: "trade"; channel: "trades"; market: number; data: Trade }
  | { type: "candle"; channel: "candles"; market: number; interval: string }
  | { type: "order"; channel: "orders"; acct: string }
  | { type: "fill"; channel: "fills"; acct: string }
  | { type: "resync"; reason: string; forkBlock: number | null }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

/** Returns null for frames we do not understand (ignored, never fatal). Throws only for a recognised frame with a bad body. */
export function parseWs(raw: string): WsMsg | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!isObj(j) || typeof j.type !== "string") return null;
  switch (j.type) {
    case "subscribed": return { type: "subscribed", channel: String(j.channel) };
    case "snapshot": if (j.channel !== "book") return null; return { type: "snapshot", channel: "book", market: num(j.market, "market"), seq: num(j.seq, "seq"), bids: arr(j.bids, "bids").map(level), asks: arr(j.asks, "asks").map(level) };
    case "delta": {
      if (j.channel !== "book") return null;
      const side = j.side === "bid" || j.side === "ask" ? j.side : bad("delta.side");
      return { type: "delta", channel: "book", market: num(j.market, "market"), seq: num(j.seq, "seq"), side, price: big(j.price, "price"), size: big(j.size, "size") };
    }
    case "trade": return { type: "trade", channel: "trades", market: num(j.market, "market"), data: parseFill(j.data) };
    case "candle": return { type: "candle", channel: "candles", market: num(j.market, "market"), interval: String(j.interval) };
    case "order": return { type: "order", channel: "orders", acct: String(j.acct) };
    case "fill": return { type: "fill", channel: "fills", acct: String(j.acct) };
    case "resync": return { type: "resync", reason: String(j.reason), forkBlock: typeof j.fork_block === "number" ? j.fork_block : null };
    case "error": return { type: "error", code: String(j.code), message: String(j.message) };
    case "pong": return { type: "pong" };
    default: return null;
  }
}
