import { demoStaleText } from "./network";
/**
 * What a trader can do in each market state. Derived from the contract rules (PerpTrading._place, PerpExchange._requireMarketsOpenForWithdraw,
 * PerpExtras.cancelOrder/cancelAll, PerpLiquidation.settleDelisted), NOT from UI preference:
 *  - placing ANY order (including a reduce-only close) reverts when the exchange is paused, or the market is Paused / OracleDegraded / Delisted,
 *    or the price feed is stale (markPrice reverts). ReduceOnly and Recovery accept only orders that shrink the position.
 *  - cancelling orders and adding collateral are allowed in every state.
 *  - withdrawing while holding a position is blocked in Paused / OracleDegraded markets (and, in practice, when the price feed is stale, because settlement needs a price).
 *  - a Delisted market is settled by the account calling settleDelisted at the frozen settle price.
 */
export const STATE_NAMES = ["Normal", "ReduceOnly", "OracleDegraded", "Paused", "Recovery", "Delisted"] as const;
export type MarketStateName = (typeof STATE_NAMES)[number];

export interface Allowed {
  /** open or increase a position */ open: boolean;
  /** place an order that only shrinks a position (this is also how a position is closed) */ reduce: boolean;
  /** cancel resting orders */ cancel: boolean;
  /** deposit / add isolated margin */ addCollateral: boolean;
  /** withdraw while holding a position in this market */ withdrawWithPosition: boolean;
  /** settle a delisted market's position at the frozen price */ settleDelisted: boolean;
  /** one plain-language sentence with the operational consequence, or null when everything works */ notice: string | null;
  tone: "ok" | "warn" | "bad" | "info";
}

export function allowedActions(i: { state: number | MarketStateName; globalPaused?: boolean; oracleOk?: boolean; name?: string; oracle?: "demo" | "chainlink" | "median" | "manual" }): Allowed {
  const s: MarketStateName = typeof i.state === "number" ? STATE_NAMES[i.state] ?? "Normal" : i.state;
  const n = i.name ?? "This market";
  const all = { cancel: true, addCollateral: true };
  if (i.globalPaused)
    return { ...all, open: false, reduce: false, withdrawWithPosition: s !== "Paused" && s !== "OracleDegraded", settleDelisted: s === "Delisted", tone: "bad", notice: "Trading is paused exchange-wide. New and closing orders are blocked. You can still cancel orders and add collateral." };
  if (s === "Delisted")
    return { ...all, open: false, reduce: false, withdrawWithPosition: true, settleDelisted: true, tone: "bad", notice: `${n} is delisted. Orders are closed; settle your position at the final price, then withdraw.` };
  if (i.oracleOk === false)
    return { ...all, open: false, reduce: false, withdrawWithPosition: false, settleDelisted: false, tone: "warn", notice: i.oracle === "demo" ? demoStaleText(n) : `Price feed delayed${i.oracle === "chainlink" ? " (the Chainlink price is stale)" : ""}. New positions and closing orders in ${n} are temporarily unavailable; withdrawals with an open position are blocked. You can still cancel orders and add collateral.` };
  switch (s) {
    case "Normal": return { ...all, open: true, reduce: true, withdrawWithPosition: true, settleDelisted: false, tone: "ok", notice: null };
    case "ReduceOnly": return { ...all, open: false, reduce: true, withdrawWithPosition: true, settleDelisted: false, tone: "warn", notice: `${n} is reduce-only. You can shrink or close positions, but not open or add to them.` };
    case "Recovery": return { ...all, open: false, reduce: true, withdrawWithPosition: true, settleDelisted: false, tone: "info", notice: `${n} is recovering. Only orders that shrink a position are accepted until it returns to normal.` };
    case "OracleDegraded": return { ...all, open: false, reduce: false, withdrawWithPosition: false, settleDelisted: false, tone: "warn", notice: `Price feed degraded. New positions and closing orders in ${n} are temporarily unavailable. You can still cancel orders and add collateral.` };
    case "Paused": return { ...all, open: false, reduce: false, withdrawWithPosition: false, settleDelisted: false, tone: "bad", notice: `${n} is paused. Orders cannot be placed or closed; withdrawals with an open position are blocked. You can still cancel orders and add collateral.` };
  }
}

/** Can this specific order be placed? `reducing` = it shrinks an existing position. */
export function canPlace(a: Allowed, reducing: boolean): { ok: boolean; why: string | null } {
  if (a.open) return { ok: true, why: null };
  if (a.reduce && reducing) return { ok: true, why: null };
  return { ok: false, why: a.reduce ? "Only orders that shrink your position are accepted right now. Turn on reduce-only or pick the opposite side." : a.notice };
}
