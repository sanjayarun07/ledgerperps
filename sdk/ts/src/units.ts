import { formatUnits, parseUnits } from "viem";
import type { MarketConfig, OrderInput } from "./types.js";

export const PRICE_DECIMALS = 6;
export const SIZE_DECIMALS = 8;
export const USDC_DECIMALS = 6;
export const BPS = 10_000n;
export const SIZE_SCALE = 10n ** 8n;

type Dec = string | number;
const asStr = (v: Dec): string => {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("non-finite number");
    // avoid exponent notation (1e-7 -> "0.0000001")
    return v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  }
  return v;
};
/** Decimal human price ("50000.1") -> raw 1e6 price. Throws if it has more than 6 decimals. */
export const toPrice = (v: Dec): bigint => parseUnits(asStr(v), PRICE_DECIMALS);
/** Decimal human size ("0.25") -> raw 1e8 size. */
export const toSize = (v: Dec): bigint => parseUnits(asStr(v), SIZE_DECIMALS);
/** Decimal USDC ("100.5") -> raw 1e6 amount. */
export const toUsdc = (v: Dec): bigint => parseUnits(asStr(v), USDC_DECIMALS);
export const fromPrice = (v: bigint): string => formatUnits(v, PRICE_DECIMALS);
export const fromSize = (v: bigint): string => formatUnits(v, SIZE_DECIMALS);
export const fromUsdc = (v: bigint): string => formatUnits(v, USDC_DECIMALS);

/** notional (raw USDC 1e6) = size*price/1e8, floored (as the contract does for fills/min-notional). */
export const notionalFloor = (size: bigint, price: bigint): bigint => (size * price) / SIZE_SCALE;
export const notionalCeil = (size: bigint, price: bigint): bigint => (size * price + SIZE_SCALE - 1n) / SIZE_SCALE;

export const roundDownTo = (v: bigint, step: bigint): bigint => (v / step) * step;
export const roundUpTo = (v: bigint, step: bigint): bigint => ((v + step - 1n) / step) * step;
export const roundToNearest = (v: bigint, step: bigint): bigint => ((v + step / 2n) / step) * step;
export const roundPriceToTick = (price: bigint, tick: bigint, mode: "down" | "up" | "nearest" = "nearest"): bigint =>
  mode === "down" ? roundDownTo(price, tick) : mode === "up" ? roundUpTo(price, tick) : roundToNearest(price, tick);
export const roundSizeToLot = (size: bigint, lot: bigint): bigint => roundDownTo(size, lot);

/**
 * Slippage-bounded limit price for a market-as-IOC order.
 * Buy: ref*(1+bps) rounded UP to tick; sell: ref*(1-bps) rounded DOWN to tick (never below one tick).
 */
export function slippagePrice(isBuy: boolean, refPrice: bigint, slippageBps: number | bigint, tick: bigint): bigint {
  const bps = BigInt(slippageBps);
  if (bps < 0n || bps > 10_000n) throw new RangeError("slippageBps out of range");
  if (refPrice <= 0n) throw new RangeError("refPrice must be positive");
  if (isBuy) return roundUpTo((refPrice * (BPS + bps) + BPS - 1n) / BPS, tick);
  const p = roundDownTo((refPrice * (BPS - bps)) / BPS, tick);
  return p < tick ? tick : p;
}

/** Returns a list of human-readable problems (empty = OK). Mirrors PerpTrading._place checks. */
export function validateOrder(m: Pick<MarketConfig, "tick" | "lot" | "minNotional" | "maxOrderSize">, o: OrderInput): string[] {
  const errs: string[] = [];
  if (o.price <= 0n) errs.push("price must be > 0");
  else if (o.price % m.tick !== 0n) errs.push(`price ${o.price} is not a multiple of tick ${m.tick}`);
  if (o.size <= 0n) errs.push("size must be > 0");
  else {
    if (o.size % m.lot !== 0n) errs.push(`size ${o.size} is not a multiple of lot ${m.lot}`);
    if (o.size > m.maxOrderSize) errs.push(`size ${o.size} exceeds maxOrderSize ${m.maxOrderSize}`);
  }
  if (!o.reduceOnly && o.price > 0n && o.size > 0n && notionalFloor(o.size, o.price) < m.minNotional)
    errs.push(`notional ${notionalFloor(o.size, o.price)} below minNotional ${m.minNotional}`);
  if (o.price > 2n ** 64n - 1n) errs.push("price exceeds uint64");
  if (o.size > 2n ** 128n - 1n) errs.push("size exceeds uint128");
  return errs;
}

export class OrderValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid order: ${problems.join("; ")}`);
    this.name = "OrderValidationError";
  }
}
export function assertValidOrder(m: Parameters<typeof validateOrder>[0], o: OrderInput): void {
  const p = validateOrder(m, o);
  if (p.length) throw new OrderValidationError(p);
}
