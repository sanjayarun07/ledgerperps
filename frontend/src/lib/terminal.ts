import type { Candle } from "./data/types";

/** ---- order-panel math ---- */
/**
 * Percent-of-available slider: notional = available * leverage * pct%, converted to a base size at `price` and floored to the lot grid.
 * `maxBase` caps it (e.g. the position size for reduce-only). Returns null when nothing valid results.
 */
export function sizeFromPercent(a: { pct: number; avail: bigint; leverage: number; price: bigint; lot: bigint; maxBase?: bigint }): bigint | null {
  if (!(a.pct > 0) || a.avail <= 0n || a.price <= 0n || a.lot <= 0n || !(a.leverage > 0)) return null;
  const pct = BigInt(Math.round(Math.min(100, a.pct) * 100)); // basis points of 1%
  const lev = BigInt(Math.round(a.leverage * 100));
  const notional = (a.avail * lev * pct) / (100n * 10000n); // USDC 1e6
  let size = (notional * 10n ** 8n) / a.price;
  if (a.maxBase !== undefined && size > a.maxBase) size = a.maxBase;
  size = (size / a.lot) * a.lot;
  return size > 0n ? size : null;
}
/** Quote (USDC, 1e6) -> base size (1e8) at `price`, floored to the lot. */
export function quoteToBase(quote: bigint, price: bigint, lot: bigint): bigint | null {
  if (quote <= 0n || price <= 0n || lot <= 0n) return null;
  const s = ((quote * 10n ** 8n) / price / lot) * lot;
  return s > 0n ? s : null;
}

/** ---- 24h stats from candles (chain-time based) ---- */
export interface Stats24h { open: number; last: number; high: number; low: number; change: number; changePct: number | null; volumeBase: number; volumeQuote: number; candles: number }
/** Derive 24h stats from candles (any interval <= 1h). Returns null when there is no trade in the window. `now` is CHAIN time (seconds). */
export function stats24h(candles: readonly Candle[], now: number): Stats24h | null {
  const from = now - 86400;
  const w = candles.filter((c) => c.time + 0 >= from - 3600 && c.time <= now + 3600).sort((a, b) => a.time - b.time);
  if (!w.length) return null;
  const open = w[0].open, last = w[w.length - 1].close;
  let high = -Infinity, low = Infinity, vb = 0, vq = 0;
  for (const c of w) { high = Math.max(high, c.high); low = Math.min(low, c.low); vb += c.volume; vq += c.volume * c.close; }
  return { open, last, high, low, change: last - open, changePct: open > 0 ? ((last - open) / open) * 100 : null, volumeBase: vb, volumeQuote: vq, candles: w.length };
}

/** ---- chart ---- */
export function sma(values: readonly number[], n: number): (number | null)[] {
  const out: (number | null)[] = []; let sum = 0;
  values.forEach((v, i) => { sum += v; if (i >= n) sum -= values[i - n]; out.push(i >= n - 1 ? sum / n : null); });
  return out;
}

/** ---- order book ---- */
export interface Lvl { p: bigint; s: bigint }
/** Group levels into buckets of `step` (a multiple of the tick). Asks round UP, bids round DOWN so a grouped price is never better than a real one. */
export function groupLevels(levels: readonly Lvl[], step: bigint, side: "ask" | "bid"): Lvl[] {
  if (step <= 0n) return [...levels];
  const m = new Map<bigint, bigint>();
  for (const l of levels) {
    const b = side === "bid" ? (l.p / step) * step : ((l.p + step - 1n) / step) * step;
    m.set(b, (m.get(b) ?? 0n) + l.s);
  }
  return [...m.entries()].map(([p, s]) => ({ p, s })).sort((a, b) => (a.p === b.p ? 0 : (a.p < b.p) === (side === "ask") ? -1 : 1));
}
/** Buy/sell pressure from cumulative displayed size: whole percents that sum to 100. */
export function pressure(bidSize: bigint, askSize: bigint): { buy: number; sell: number } | null {
  const t = bidSize + askSize;
  if (t <= 0n) return null;
  const buy = Number((bidSize * 100n) / t);
  return { buy, sell: 100 - buy };
}
export const spreadInfo = (bestBid?: bigint, bestAsk?: bigint) => (bestBid && bestAsk && bestAsk >= bestBid ? { abs: bestAsk - bestBid, pct: Number(((bestAsk - bestBid) * 1_000_000n) / bestAsk) / 10_000 } : null);

/** ---- keyboard shortcuts ---- */
export type ShortcutAction = "buy" | "sell" | "limit" | "market" | "focus-size" | "help" | "palette" | "escape" | "theme";
export const SHORTCUTS: { keys: string; action: ShortcutAction; label: string }[] = [
  { keys: "B", action: "buy", label: "Switch to Buy / Long" },
  { keys: "S", action: "sell", label: "Switch to Sell / Short" },
  { keys: "L", action: "limit", label: "Limit order" },
  { keys: "M", action: "market", label: "Market order" },
  { keys: "/", action: "focus-size", label: "Focus the size field" },
  { keys: "Ctrl/Cmd + K", action: "palette", label: "Search and commands" },
  { keys: "?", action: "help", label: "Show this help" },
  { keys: "Esc", action: "escape", label: "Close popovers and dialogs" },
];
/** Map a key event to an action. Plain keys are ignored while typing in a field; Ctrl/Cmd+K works everywhere. */
export function shortcutAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; targetTag?: string; editable?: boolean }): ShortcutAction | null {
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "k") return "palette";
  if (k === "Escape") return "escape";
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const typing = e.editable || ["INPUT", "TEXTAREA", "SELECT"].includes((e.targetTag ?? "").toUpperCase());
  if (typing) return null;
  switch (k.toLowerCase()) {
    case "b": return "buy"; case "s": return "sell"; case "l": return "limit"; case "m": return "market";
    case "/": return "focus-size"; case "?": return "help"; default: return null;
  }
}
