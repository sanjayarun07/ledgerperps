import { abs, formatFixed, notionalFloor, parseDecimal, PRICE_DEC, SIZE_DEC } from "./units";

export const TIF = { GTC: 0, IOC: 1, FOK: 2, PostOnly: 3 } as const;
export type TifName = keyof typeof TIF;
export const CANCEL_REASONS = ["User", "Expired", "SelfTrade", "InvalidReduceOnly", "MakerMargin", "Filled", "Liquidation", "Replaced", "PriceBand"] as const;
/** Index of `PriceBand` in CancelReason: a resting order was outside oracle price +/- the market band when it would have matched. */
export const CANCEL_PRICE_BAND = 8;
const CANCEL_TEXT: Record<string, string> = {
  user: "Order cancelled by you", expired: "Order cancelled: it expired", self_trade: "Order cancelled: it would have traded against your own order",
  invalid_reduce_only: "Order cancelled: it would have increased your position", maker_margin: "Order cancelled: not enough margin to keep it open",
  filled: "Order filled", liquidation: "Order cancelled by a liquidation", replaced: "Order replaced",
  price_band: "Order cancelled: its price was too far from the oracle price",
};
/** Plain-language text for a cancel reason given as the on-chain code (0..8), the contract name ("PriceBand") or the indexer label ("price_band"). */
export function cancelReasonText(r: number | string | null | undefined): string {
  if (r === null || r === undefined || r === "") return "";
  const key = typeof r === "number" ? CANCEL_REASONS[r] : r;
  if (key === undefined) return `Order cancelled (reason ${r})`;
  const snake = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return CANCEL_TEXT[snake] ?? `Order cancelled (${key})`;
}
export const MARKET_STATES = ["Normal", "ReduceOnly", "OracleDegraded", "Paused", "Recovery", "Delisted"] as const;

export interface MarketRules { tick: bigint; lot: bigint; minNotional: bigint; maxOrderSize: bigint; /** base asset symbol for messages, e.g. BTC */ unit?: string }

export interface OrderParams {
  market: number; isBuy: boolean; price: bigint; size: bigint; tif: number; reduceOnly: boolean; cloid: bigint; expiry: bigint;
}

/** Worst acceptable price for a market-as-IOC order, rounded AWAY from the reference by slippage and onto the tick grid in the safe direction. */
export function slippagePrice(ref: bigint, isBuy: boolean, slippageBps: number, tick: bigint): bigint {
  const bps = BigInt(Math.round(slippageBps));
  if (isBuy) {
    const raw = (ref * (10000n + bps) + 9999n) / 10000n; // ceil
    return ((raw + tick - 1n) / tick) * tick; // ceil to tick
  }
  const raw = (ref * (10000n - bps)) / 10000n; // floor
  const t = (raw / tick) * tick;
  return t > 0n ? t : tick;
}

export interface TicketInput {
  type: "limit" | "market";
  isBuy: boolean;
  priceStr: string;
  sizeStr: string;
  tif: TifName;
  reduceOnly: boolean;
  slippageBps: number;
  refPrice: bigint; // mark (for market) / fallback
  /** best opposite price from the book (for market order pricing); falls back to refPrice */
  bookTop?: bigint;
  /** current signed position (for reduce-only validation) */
  position: bigint;
}

export interface ValidationResult { ok: boolean; errors: string[]; price?: bigint; size?: bigint; notional?: bigint }

/** Nearest valid size at or below `size` (never below one lot). */
export const suggestSize = (size: bigint, lot: bigint) => { const n = (size / lot) * lot; return n > 0n ? n : lot; };
/** Nearest valid price on the tick grid. */
export const suggestPrice = (px: bigint, tick: bigint) => { const n = ((px + tick / 2n) / tick) * tick; return n > 0n ? n : tick; };
const sz8 = (v: bigint) => formatFixed(v, SIZE_DEC, SIZE_DEC, 4);
const px6 = (v: bigint) => formatFixed(v, PRICE_DEC, PRICE_DEC, 2);
const usd6 = (v: bigint) => formatFixed(v, 6, 2, 2);

export function validateTicket(t: TicketInput, r: MarketRules): ValidationResult {
  const errors: string[] = [];
  const u = r.unit ? ` ${r.unit}` : "";
  const size = parseDecimal(t.sizeStr, SIZE_DEC);
  if (size === null || size === 0n) errors.push(t.sizeStr.trim() === "" ? "Enter a size, for example 0.0010" : "Size must be a positive number with at most 8 decimals");
  else {
    if (size % r.lot !== 0n) errors.push(`Size must be a multiple of the lot (${sz8(r.lot)}${u}); try ${sz8(suggestSize(size, r.lot))}`);
    if (size > r.maxOrderSize) errors.push(`Size is above the max order size (${sz8(r.maxOrderSize)}${u}); try ${sz8(suggestSize(r.maxOrderSize, r.lot))} or less`);
  }
  let price: bigint | undefined;
  if (t.type === "limit") {
    const p = parseDecimal(t.priceStr, PRICE_DEC);
    if (p === null || p === 0n) errors.push(t.priceStr.trim() === "" ? "Enter a limit price in USDC" : "Price must be a positive number with at most 6 decimals");
    else {
      if (p % r.tick !== 0n) errors.push(`Price must be a multiple of the tick (${px6(r.tick)} USDC); try ${px6(suggestPrice(p, r.tick))}`);
      price = p;
    }
  } else {
    const ref = t.bookTop && t.bookTop > 0n ? t.bookTop : t.refPrice;
    if (ref <= 0n) errors.push("No reference price is available for a market order yet. Wait for the price feed or use a limit order.");
    else price = slippagePrice(ref, t.isBuy, t.slippageBps, r.tick);
  }
  if (t.reduceOnly) {
    if (t.position === 0n) errors.push("Reduce-only needs an open position in this market. Turn reduce-only off, or open a position first.");
    else if ((t.position > 0n) === t.isBuy) errors.push(`Reduce-only must be on the opposite side of your position (you are ${t.position > 0n ? "long, so choose Sell" : "short, so choose Buy"}).`);
  }
  let notional: bigint | undefined;
  if (size && price) {
    notional = notionalFloor(size, price);
    if (!t.reduceOnly && notional < r.minNotional) {
      const minSize = ((r.minNotional * 10n ** BigInt(SIZE_DEC) + price - 1n) / price + r.lot - 1n) / r.lot * r.lot;
      errors.push(`Order value ${usd6(notional)} USDC is below the minimum notional (${usd6(r.minNotional)} USDC); try at least ${sz8(minSize)}${u}`);
    }
  }
  return { ok: errors.length === 0, errors, price, size: size ?? undefined, notional };
}

export function buildOrderParams(i: { market: number; isBuy: boolean; price: bigint; size: bigint; type: "limit" | "market"; tif: TifName; reduceOnly: boolean; cloid?: bigint; expiry?: bigint }): OrderParams {
  return {
    market: i.market, isBuy: i.isBuy, price: i.price, size: i.size,
    tif: i.type === "market" ? TIF.IOC : TIF[i.tif],
    reduceOnly: i.reduceOnly, cloid: i.cloid ?? 0n, expiry: i.expiry ?? 0n,
  };
}

/** TP/SL sanity relative to the position direction and mark. Returns error strings. */
export function validateBracket(a: { isLong: boolean; mark: bigint; tp?: bigint; sl?: bigint; tick: bigint }): string[] {
  const e: string[] = [];
  if (a.tp === undefined || a.sl === undefined) { e.push("Both take-profit and stop-loss prices are required for a bracket"); return e; }
  if (a.tp % a.tick !== 0n || a.sl % a.tick !== 0n) e.push("Prices must be multiples of the tick");
  if (a.isLong) { if (a.tp <= a.mark) e.push("Take-profit must be above mark for a long"); if (a.sl >= a.mark) e.push("Stop-loss must be below mark for a long"); }
  else { if (a.tp >= a.mark) e.push("Take-profit must be below mark for a short"); if (a.sl <= a.mark) e.push("Stop-loss must be above mark for a short"); }
  return e;
}

export function validateTwap(a: { sizeStr: string; slices: number; intervalSecs: number; slippageBps: number }, r: MarketRules): { ok: boolean; errors: string[]; size?: bigint } {
  const e: string[] = [];
  const size = parseDecimal(a.sizeStr, SIZE_DEC);
  if (!size || size === 0n) e.push("Enter a total size");
  else {
    if (size % r.lot !== 0n) e.push("Total size must be a multiple of the lot");
    if (!Number.isInteger(a.slices) || a.slices < 2 || a.slices > 100) e.push("Slices must be an integer from 2 to 100");
    else if (size / BigInt(a.slices) < r.lot) e.push("Each slice must be at least one lot");
  }
  if (!Number.isInteger(a.intervalSecs) || a.intervalSecs < 1) e.push("Interval must be at least 1 second");
  if (!Number.isInteger(a.slippageBps) || a.slippageBps < 0 || a.slippageBps > 1000) e.push("Slippage must be 0 to 1000 bps");
  return { ok: e.length === 0, errors: e, size: size ?? undefined };
}

export const sameSign = (a: bigint, b: bigint) => (a > 0n) === (b > 0n) && a !== 0n && b !== 0n;
export { abs };

/**
 * Size (1e8) that brings the TOTAL position to about `leverage` x equity on the chosen side at `price`, floored to the lot grid.
 * Returns null when that would not be an order on this side (e.g. already at or above the target) or inputs are unusable.
 */
export function sizeForLeverage(a: { leverage: number; equity: bigint; price: bigint; isBuy: boolean; position: bigint; lot: bigint }): bigint | null {
  if (a.equity <= 0n || a.price <= 0n || a.lot <= 0n || !(a.leverage > 0)) return null;
  const targetNotional = (a.equity * BigInt(Math.round(a.leverage * 100))) / 100n; // USDC 1e6
  const targetSize = (targetNotional * 10n ** BigInt(SIZE_DEC)) / a.price;
  const signed = a.isBuy ? targetSize : -targetSize;
  const delta = signed - a.position;
  if (a.isBuy ? delta <= 0n : delta >= 0n) return null;
  const n = ((delta < 0n ? -delta : delta) / a.lot) * a.lot;
  return n > 0n ? n : null;
}

// ---------------------------------------------------------------- advanced order types

export type TriggerKind = "stop" | "tp";
/** Direction the price must cross for a trigger order to fire: a stop BUY fires when price RISES to it, a stop SELL when it FALLS; take-profit is the reverse. */
export const triggerAbove = (kind: TriggerKind, isBuy: boolean): boolean => (kind === "stop" ? isBuy : !isBuy);

export function validateTrigger(a: { kind: TriggerKind; isBuy: boolean; exec: "market" | "limit"; triggerStr: string; limitStr: string; sizeStr: string; mark: bigint; position: bigint; reduceOnly: boolean; slippageBps: number }, r: MarketRules): { ok: boolean; errors: string[]; warnings: string[]; trigger?: bigint; limit?: bigint; size?: bigint; above: boolean } {
  const errors: string[] = [], warnings: string[] = [];
  const above = triggerAbove(a.kind, a.isBuy);
  const trigger = parseDecimal(a.triggerStr, PRICE_DEC) ?? undefined;
  if (!trigger) errors.push(a.triggerStr.trim() === "" ? "Enter a trigger price in USDC" : "Trigger must be a positive number with at most 6 decimals");
  else {
    if (trigger % r.tick !== 0n) errors.push(`Trigger must be a multiple of the tick (${px6(r.tick)} USDC); try ${px6(suggestPrice(trigger, r.tick))}`);
    if (a.mark > 0n && (above ? trigger <= a.mark : trigger >= a.mark)) errors.push(`${a.kind === "stop" ? "Stop" : "Take-profit"} ${a.isBuy ? "buy" : "sell"} fires when the price ${above ? "rises to" : "falls to"} the trigger, so it must be ${above ? "above" : "below"} the mark (${px6(a.mark)} USDC)`);
  }
  let limit: bigint | undefined;
  if (a.exec === "limit") {
    limit = parseDecimal(a.limitStr, PRICE_DEC) ?? undefined;
    if (!limit) errors.push(a.limitStr.trim() === "" ? "Enter a limit price in USDC" : "Limit price must be a positive number with at most 6 decimals");
    else if (limit % r.tick !== 0n) errors.push(`Limit price must be a multiple of the tick (${px6(r.tick)} USDC); try ${px6(suggestPrice(limit, r.tick))}`);
    else if (trigger && (a.isBuy ? limit < trigger : limit > trigger)) warnings.push(`A ${a.isBuy ? "buy" : "sell"} limit ${a.isBuy ? "below" : "above"} the trigger may never fill once triggered`);
  } else if (trigger) limit = slippagePrice(trigger, a.isBuy, a.slippageBps, r.tick);
  const size = parseDecimal(a.sizeStr, SIZE_DEC) ?? undefined;
  if (!size) errors.push(a.sizeStr.trim() === "" ? "Enter a size" : "Size must be a positive number with at most 8 decimals");
  else {
    if (size % r.lot !== 0n) errors.push(`Size must be a multiple of the lot (${sz8(r.lot)}${r.unit ? ` ${r.unit}` : ""}); try ${sz8(suggestSize(size, r.lot))}`);
    if (size > r.maxOrderSize) errors.push(`Size is above the max order size (${sz8(r.maxOrderSize)})`);
    if (!a.reduceOnly && trigger && (limit ?? trigger) > 0n && notionalFloor(size, limit ?? trigger) < r.minNotional) errors.push(`Order value is below the minimum notional (${usd6(r.minNotional)} USDC)`);
  }
  if (a.reduceOnly && size) {
    if (a.position === 0n) warnings.push("Reduce-only with no open position: it will be rejected when it fires unless you open one first");
    else if ((a.position > 0n) === a.isBuy) errors.push(`Reduce-only must be on the opposite side of your position (you are ${a.position > 0n ? "long, so choose Sell" : "short, so choose Buy"})`);
    else if (size > abs(a.position)) warnings.push(`Size is bigger than your position (${sz8(abs(a.position))}); a reduce-only order is capped at the position`);
  }
  return { ok: errors.length === 0, errors, warnings, trigger, limit, size, above };
}

/** Scale order: `n` equal-ish limit orders spread evenly from `from` to `to` (inclusive), each on the tick grid, sizes on the lot grid summing to `total`. */
export function scaleLevels(a: { from: bigint; to: bigint; total: bigint; n: number; tick: bigint; lot: bigint }): { prices: bigint[]; sizes: bigint[] } {
  const { from, to, total, n, tick, lot } = a;
  const prices: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const raw = n === 1 ? from : from + ((to - from) * BigInt(i)) / BigInt(n - 1);
    prices.push(((raw + tick / 2n) / tick) * tick);
  }
  const lots = total / lot, base = lots / BigInt(n), extra = lots % BigInt(n);
  const sizes = prices.map((_, i) => (base + (BigInt(i) < extra ? 1n : 0n)) * lot);
  return { prices, sizes };
}

export function validateScale(a: { isBuy: boolean; fromStr: string; toStr: string; sizeStr: string; n: number; reduceOnly: boolean; mark: bigint }, r: MarketRules): { ok: boolean; errors: string[]; warnings: string[]; prices: bigint[]; sizes: bigint[] } {
  const errors: string[] = [], warnings: string[] = [];
  const from = parseDecimal(a.fromStr, PRICE_DEC), to = parseDecimal(a.toStr, PRICE_DEC), total = parseDecimal(a.sizeStr, SIZE_DEC);
  if (!from) errors.push("Enter the start price in USDC");
  if (!to) errors.push("Enter the end price in USDC");
  if (!total) errors.push("Enter a total size");
  if (!Number.isInteger(a.n) || a.n < 2 || a.n > 10) errors.push("Orders must be a whole number from 2 to 10");
  if (!from || !to || !total || errors.length) return { ok: false, errors, warnings, prices: [], sizes: [] };
  if (from === to) errors.push("Start and end price must differ");
  if (total % r.lot !== 0n) errors.push(`Total size must be a multiple of the lot (${sz8(r.lot)}); try ${sz8(suggestSize(total, r.lot))}`);
  else if (total / r.lot < BigInt(a.n)) errors.push(`Each order must be at least one lot (${sz8(r.lot)}): lower the number of orders or raise the size`);
  if (errors.length) return { ok: false, errors, warnings, prices: [], sizes: [] };
  const { prices, sizes } = scaleLevels({ from, to, total, n: a.n, tick: r.tick, lot: r.lot });
  if (new Set(prices.map(String)).size !== prices.length) errors.push("Prices collapse onto the same tick: widen the range or use fewer orders");
  if (!a.reduceOnly) { const small = prices.findIndex((p, i) => notionalFloor(sizes[i]!, p) < r.minNotional); if (small >= 0) errors.push(`Order ${small + 1} is below the minimum notional (${usd6(r.minNotional)} USDC): use fewer orders or a larger size`); }
  if (a.mark > 0n) { const cross = prices.filter((p) => (a.isBuy ? p >= a.mark : p <= a.mark)).length; if (cross > 0) warnings.push(`${cross} of ${a.n} orders ${a.isBuy ? "are at or above" : "are at or below"} the mark and may fill immediately as takers`); }
  return { ok: errors.length === 0, errors, warnings, prices, sizes };
}
