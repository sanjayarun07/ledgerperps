import { abs, notionalCeil, SIZE_DEC } from "./units";

const E8 = 10n ** BigInt(SIZE_DEC);

export interface PositionView { size: bigint; basis: bigint }

/** Entry price (1e6) = basis / size. basis = sum(signed size * price). */
export function entryPrice(p: PositionView): bigint {
  return p.size === 0n ? 0n : p.basis / p.size;
}

/** Unrealized PnL (1e6 USDC), floored like the contract: floor((size*mark - basis)/1e8). */
export function unrealizedPnl(p: PositionView, mark: bigint): bigint {
  const x = p.size * mark - p.basis;
  // floor division for negatives
  const q = x / E8;
  return x < 0n && x % E8 !== 0n ? q - 1n : q;
}

/**
 * ESTIMATED liquidation price. Solves equity(p') = maintenance(p') for ONE position, holding everything else fixed:
 *   equity(p') = equity + size*(p' - mark)/1e8
 *   mm(p')     = (mm - mmPos) + |size|*p'*mmrBps/1e8/1e4
 * For isolated positions pass the isolated equity/mm (exact up to rounding & tiering). For cross it is only approximate:
 * other positions' PnL, funding, tier jumps and order reservations are ignored. Returns null if no positive solution
 * (e.g. an unlevered long cannot be liquidated).
 */
export function estimateLiqPrice(a: { size: bigint; mark: bigint; equity: bigint; mm: bigint; mmrBps: bigint }): bigint | null {
  if (a.size === 0n) return null;
  const mmPos = (notionalCeil(a.size, a.mark) * a.mmrBps + 9999n) / 10000n;
  const others = a.mm - mmPos; // mm of everything else
  // size*(p'-mark)/1e8 + equity = others + |size|*p'*mmr/(1e8*1e4)   (multiply by 1e8*1e4)
  // p' * (size*1e4 - |size|*mmr) = (others - equity)*1e8*1e4 + size*mark*1e4
  const denom = a.size * 10000n - abs(a.size) * a.mmrBps;
  if (denom === 0n) return null;
  const num = (others - a.equity) * E8 * 10000n + a.size * a.mark * 10000n;
  const p = num / denom;
  if (p <= 0n) return null;
  return p;
}

/** Pick the maintenance bps tier for a position notional (whole-position tiering, like the contract). */
export function mmrBpsFor(notional: bigint, tiers: readonly { upToNotional: bigint; mmrBps: number }[]): bigint {
  for (const t of tiers) if (notional <= t.upToNotional) return BigInt(t.mmrBps);
  return BigInt(tiers[tiers.length - 1]?.mmrBps ?? 0);
}
export function imrBpsFor(notional: bigint, tiers: readonly { upToNotional: bigint; imrBps: number }[]): bigint {
  for (const t of tiers) if (notional <= t.upToNotional) return BigInt(t.imrBps);
  return BigInt(tiers[tiers.length - 1]?.imrBps ?? 0);
}

/** Effective leverage = notional / equity (as a number, display only). */
export function effectiveLeverage(notional: bigint, equity: bigint): number | null {
  if (equity <= 0n) return null;
  return Number((notional * 100n) / equity) / 100;
}

/** Health: 0..1 fraction of equity cushion above maintenance. 1 = no margin used; 0 = at liquidation. */
export function healthFraction(equity: bigint, mm: bigint): number {
  if (equity <= 0n) return 0;
  if (mm <= 0n) return 1;
  const f = Number(((equity - mm) * 10000n) / equity) / 10000;
  return Math.max(0, Math.min(1, f));
}

/** Max leverage implied by the first tier. */
export const maxLeverageFromImr = (imrBps: number) => (imrBps > 0 ? 10000 / imrBps : 0);

export type HealthKey = "safe" | "watch" | "risk" | "liquidatable";
export interface Health { key: HealthKey; label: string; ratio: number | null; explain: string }
/**
 * Plain-language account health from equity vs maintenance margin (MM). The contract liquidates when equity falls to MM.
 *   ratio = equity / MM:  > 3 Safe, 1.5-3 Watch, 1-1.5 At risk, <= 1 Liquidatable. No open positions (MM = 0) is Safe.
 * The thresholds are a UI guide, not contract parameters.
 */
export function healthState(equity: bigint, mm: bigint): Health {
  if (mm <= 0n) return { key: "safe", label: "Safe", ratio: null, explain: "No open positions, so nothing can be liquidated." };
  if (equity <= mm) return { key: "liquidatable", label: "Liquidatable", ratio: equity <= 0n ? 0 : Number((equity * 100n) / mm) / 100, explain: "Your equity is at or below the maintenance margin. Anyone can liquidate this account. Add collateral or close positions immediately." };
  const ratio = Number((equity * 100n) / mm) / 100;
  if (ratio < 1.5) return { key: "risk", label: "At risk", ratio, explain: "A small price move could get you liquidated. Add collateral or reduce your position now." };
  if (ratio < 3) return { key: "watch", label: "Watch", ratio, explain: "You have a cushion, but a sharp move could erode it. Consider adding collateral or lowering leverage." };
  return { key: "safe", label: "Safe", ratio, explain: "Your equity is well above the maintenance margin." };
}

/** Warning text when the leverage after an order is high, else null. */
export function leverageWarning(lev: number | null, maxLev: number): string | null {
  if (lev === null) return null;
  if (lev >= Math.max(5, maxLev * 0.8)) return `High leverage (${lev.toFixed(1)}x): a price move of about ${(100 / lev).toFixed(0)}% against you can wipe out your margin.`;
  if (lev >= 3) return `Leverage ${lev.toFixed(1)}x: losses are amplified ${lev.toFixed(1)} times.`;
  return null;
}
