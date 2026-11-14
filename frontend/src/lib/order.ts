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
