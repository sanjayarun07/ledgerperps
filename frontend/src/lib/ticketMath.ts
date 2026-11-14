import { notionalFloor } from "./units";

/** One side of the book: price in 6-dec fixed, size in 8-dec fixed. */
export interface Level { p: bigint; s: bigint }

/** Walk the book for a taker order of `size`. avg is the size-weighted average price; worst is the last level touched. */
export function walkBook(levels: Level[], size: bigint): { filled: bigint; avg: bigint | null; worst: bigint | null; notional: bigint } {
  let left = size, notional = 0n, filled = 0n, worst: bigint | null = null;
  for (const l of levels) {
    if (left <= 0n) break;
    const take = l.s < left ? l.s : left;
    notional += notionalFloor(take, l.p); filled += take; left -= take; worst = l.p;
  }
  const avg = filled > 0n ? (notional * 10n ** 8n) / filled : null;
  return { filled, avg, worst, notional };
}

/** Adverse price impact of an average fill vs a reference price, in basis points (positive = worse for the trader). */
export function impactBps(avg: bigint | null, ref: bigint, isBuy: boolean): number | null {
  if (avg === null || ref === 0n) return null;
  const d = isBuy ? avg - ref : ref - avg;
  return Number((d * 100000n) / ref) / 10;
}

/**
 * The two numbers a trader must never confuse:
 *  - positionNotional: how much exposure the order adds (what you are trading)
 *  - collateral: how much of your money it locks as margin (what you are risking to hold it) = incNotional x initial-margin rate
 */
export function ticketAmounts(i: { orderNotional: bigint; incNotional: bigint; imrBps: bigint; fee: bigint; available: bigint }) {
  const collateral = (i.incNotional * i.imrBps + 9999n) / 10000n;
  return { positionNotional: i.orderNotional, collateral, fee: i.fee, availableAfter: i.available - collateral - i.fee };
}

/** Estimate for a reduce-only close: realised PnL at the expected average exit, the fee, and what comes back. size/entry/avgExit as fixed-point bigints. */
export function closeEstimate(i: { positionSize: bigint; entry: bigint; avgExit: bigint; closeSize: bigint; feeBps: bigint; marginReleased: bigint }) {
  const long = i.positionSize > 0n;
  const entryN = notionalFloor(i.closeSize, i.entry), exitN = notionalFloor(i.closeSize, i.avgExit);
  const pnl = long ? exitN - entryN : entryN - exitN;
  const fee = (exitN * i.feeBps + 9999n) / 10000n;
  return { pnl, fee, proceeds: i.marginReleased + pnl - fee, exitNotional: exitN };
}
