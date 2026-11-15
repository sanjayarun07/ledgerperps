/**
 * Pure quoting logic (no I/O) so it can be unit-tested. SIMULATED LIQUIDITY - NOT REAL.
 *
 * Two account "side-sets": every BID quote is placed from `bidSub`, every ASK quote from `askSub`.
 * When bidSub != askSub the two sets are different on-chain accounts, so a stale bid and a fresh ask can never
 * self-trade inside one account; every quote is pre-checked against the best opposite level (and optionally PostOnly), so quotes never take
 * liquidity. Because bid-only/ask-only accounts would otherwise grow
 * one-directional positions that never net, each account also posts reduce-only quotes on the opposite side to
 * unwind the position it holds.
 */
import { BPS, notionalFloor } from "@perps/sdk";

export interface QuoteConfig {
  /** distance of level 0 from the (skewed) fair value, in bps */
  halfSpreadBps: number;
  levels: number;
  levelStepBps: number;
  /** raw size per level (should be a lot multiple) */
  levelSize: bigint;
  /** absolute net inventory limit, raw size */
  maxInventory: bigint;
  /** when true, an inventory-scaled quote that rounds below the market's minimum order is raised to the minimum size (if room allows) instead of being dropped; needed when lots are coarse and levels are only a few lots */
  keepMinSize?: boolean;
  /** quote shift (bps) when |net inventory| == maxInventory; long => quotes move down */
  skewBps: number;
  /** replace a resting quote when it is further than this from its target (must be < halfSpreadBps) */
  refreshBps: number;
  /** replace a resting quote older than this */
  maxQuoteAgeMs: number;
}

export interface QuoteInput {
  /** fair value, raw 1e6 (oracle price) */
  mid: bigint;
  /** sum of both side-set accounts' positions (signed, raw 1e8) */
  netInventory: bigint;
  /** position held by the bid-set account / ask-set account (equal accounts: pass both the same and twoSub=false) */
  posBidSub: bigint;
  posAskSub: bigint;
  twoSub: boolean;
  tick: bigint;
  lot: bigint;
  minNotional: bigint;
  /**
   * Market `bandBps` (WASH-1): the exchange cancels a RESTING order (reason PriceBand) when it would match while its price is
   * outside index +/- bandBps. Quotes beyond `BAND_SAFETY` of the band (default 80%) are not placed, so an index move between
   * refreshes cannot push a live quote out of the band. Omit only for tests / unknown markets.
   */
  bandBps?: number;
}

/** Fraction of `bandBps` the bots are willing to use (percent). */
export const BAND_SAFETY_PCT = 80n;

export type Side = "bidSub" | "askSub";
export interface DesiredQuote {
  /** which side-set account places it */
  from: Side;
  isBuy: boolean;
  price: bigint;
  size: bigint;
  reduceOnly: boolean;
  level: number;
}

const floorTo = (v: bigint, s: bigint) => (v / s) * s;
const ceilTo = (v: bigint, s: bigint) => ((v + s - 1n) / s) * s;
const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const abs = (a: bigint) => (a < 0n ? -a : a);

export function validateQuoteConfig(c: QuoteConfig): void {
  if (c.levels < 1) throw new Error("levels must be >= 1");
  if (c.halfSpreadBps <= 0) throw new Error("halfSpreadBps must be > 0");
  if (c.refreshBps >= c.halfSpreadBps)
    throw new Error("refreshBps must be < halfSpreadBps (otherwise a stale quote could sit across a fresh opposite quote)");
  if (c.maxInventory <= 0n || c.levelSize <= 0n) throw new Error("sizes must be positive");
}

export function computeQuotes(c: QuoteConfig, i: QuoteInput): DesiredQuote[] {
  validateQuoteConfig(c);
  if (i.mid <= 0n) return [];
  // inventory skew: long => shift quotes down (sell more eagerly / buy less eagerly)
  const ratioBps = clamp((i.netInventory * BPS) / c.maxInventory, -BPS, BPS);
  const shiftBps = (ratioBps * BigInt(c.skewBps)) / BPS;
  const fair = (i.mid * (BPS - shiftBps)) / BPS;
  // remaining room to add risk on each side
  let bidRoom = clamp(c.maxInventory - i.netInventory, 0n, 2n * c.maxInventory);
  let askRoom = clamp(c.maxInventory + i.netInventory, 0n, 2n * c.maxInventory);
  // size taper: full size at/below flat on the risk-increasing side, linearly to 0 at the limit
  const bidScale = clamp(((c.maxInventory - i.netInventory) * BPS) / c.maxInventory, 0n, BPS);
  const askScale = clamp(((c.maxInventory + i.netInventory) * BPS) / c.maxInventory, 0n, BPS);
  const bidPos = i.twoSub ? i.posAskSub : 0n; // short position of the ask-set account => it posts reduce-only BIDS
  const askPos = i.twoSub ? i.posBidSub : 0n; // long position of the bid-set account => it posts reduce-only ASKS
  let askUnwind = askPos > 0n ? askPos : 0n;
  let bidUnwind = bidPos < 0n ? -bidPos : 0n;

  const out: DesiredQuote[] = [];
  let lastBid = 0n;
  let lastAsk = 0n;
  for (let l = 0; l < c.levels; l++) {
    const off = BigInt(c.halfSpreadBps + l * c.levelStepBps);
    // never quote through fair value, never cross yourself: bid <= mid - tick, ask >= mid + tick
    let bid = floorTo((fair * (BPS - off)) / BPS, i.tick);
    let ask = ceilTo((fair * (BPS + off) + BPS - 1n) / BPS, i.tick);
    bid = min(bid, floorTo(i.mid - i.tick, i.tick));
    if (ask < ceilTo(i.mid + i.tick, i.tick)) ask = ceilTo(i.mid + i.tick, i.tick);
    if (bid <= 0n) continue;
    if (i.bandBps !== undefined) {
      const w = (BigInt(i.bandBps) * BAND_SAFETY_PCT) / 100n; // allowed distance from the oracle, bps
      const lo = ceilTo((i.mid * (BPS - w)) / BPS, i.tick);
      const hi = floorTo((i.mid * (BPS + w)) / BPS, i.tick);
      if (bid < lo || ask > hi) break; // this and all deeper levels would risk a PriceBand cancel
    }
    if (lastBid && bid >= lastBid) bid = lastBid - i.tick;
    if (lastAsk && ask <= lastAsk) ask = lastAsk + i.tick;
    lastBid = bid;
    lastAsk = ask;

    // ---- bids
    let want = floorTo((c.levelSize * bidScale) / BPS, i.lot);
    want = min(want, floorTo(bidRoom, i.lot));
    if (c.keepMinSize && bidScale > 0n) { const m = minSizeFor(bid, i); if (want < m && floorTo(bidRoom, i.lot) >= m) want = m; }
    // reduce-only unwinding bids from the ask-set account come first
    const roBid = min(want, floorTo(bidUnwind, i.lot));
    if (roBid >= i.lot) {
      out.push({ from: "askSub", isBuy: true, price: bid, size: roBid, reduceOnly: true, level: l });
      bidUnwind -= roBid;
      bidRoom -= roBid;
      want -= roBid;
    }
    if (want >= i.lot && notionalFloor(want, bid) >= i.minNotional) {
      out.push({ from: "bidSub", isBuy: true, price: bid, size: want, reduceOnly: false, level: l });
      bidRoom -= want;
    }

    // ---- asks
    let wantA = floorTo((c.levelSize * askScale) / BPS, i.lot);
    wantA = min(wantA, floorTo(askRoom, i.lot));
    if (c.keepMinSize && askScale > 0n) { const m = minSizeFor(ask, i); if (wantA < m && floorTo(askRoom, i.lot) >= m) wantA = m; }
    const roAsk = min(wantA, floorTo(askUnwind, i.lot));
    if (roAsk >= i.lot) {
      out.push({ from: "bidSub", isBuy: false, price: ask, size: roAsk, reduceOnly: true, level: l });
      askUnwind -= roAsk;
      askRoom -= roAsk;
      wantA -= roAsk;
    }
    if (wantA >= i.lot && notionalFloor(wantA, ask) >= i.minNotional) {
      out.push({ from: "askSub", isBuy: false, price: ask, size: wantA, reduceOnly: false, level: l });
      askRoom -= wantA;
    }
  }
  return out;
}

/** Smallest lot-aligned size whose notional at `price` reaches the market minimum. */
function minSizeFor(price: bigint, i: { lot: bigint; minNotional: bigint }): bigint {
  let sz = i.lot;
  while (notionalFloor(sz, price) < i.minNotional) sz += i.lot;
  return sz;
}

// ---------------------------------------------------------------------------------------------------- diffing
export interface ExistingQuote {
  id: bigint;
  from: Side;
  isBuy: boolean;
  price: bigint;
  size: bigint;
  reduceOnly: boolean;
  /** ms epoch when this bot placed it (or first saw it) */
  placedAtMs: number;
}
export type Action =
  | { kind: "cancel"; id: bigint; from: Side; reason: string }
  | { kind: "replace"; id: bigint; to: DesiredQuote; reason: string }
  | { kind: "place"; to: DesiredQuote };

const groupKey = (q: { from: Side; isBuy: boolean; reduceOnly: boolean }) => `${q.from}|${q.isBuy}|${q.reduceOnly}`;

/**
 * Pairs existing quotes with desired ones per (account, side, reduceOnly) group in price-priority order and
 * decides keep / replace / cancel / place. A quote is "stale" if its price is further than refreshBps from its
 * target, it is older than maxQuoteAgeMs, or it is too large (> target) / too small (< 50% of target).
 */
export function planActions(c: QuoteConfig, existing: ExistingQuote[], desired: DesiredQuote[], nowMs: number): Action[] {
  const groups = new Map<string, { ex: ExistingQuote[]; de: DesiredQuote[] }>();
  const g = (k: string) => groups.get(k) ?? (groups.set(k, { ex: [], de: [] }), groups.get(k)!);
  for (const e of existing) g(groupKey(e)).ex.push(e);
  for (const d of desired) g(groupKey(d)).de.push(d);
  const actions: Action[] = [];
  for (const { ex, de } of groups.values()) {
    const isBuy = (ex[0]?.isBuy ?? de[0]?.isBuy)!;
    // best price first
    const cmp = (a: bigint, b: bigint) => (a === b ? 0 : (a > b) === isBuy ? -1 : 1);
    ex.sort((a, b) => cmp(a.price, b.price));
    de.sort((a, b) => cmp(a.price, b.price));
    // globally-nearest pairing: repeatedly match the closest (desired, resting) pair
    const pairs: { di: number; ei: number; dist: bigint }[] = [];
    de.forEach((d, di) => ex.forEach((e, ei) => pairs.push({ di, ei, dist: e.price > d.price ? e.price - d.price : d.price - e.price })));
    pairs.sort((x, y) => (x.dist < y.dist ? -1 : x.dist > y.dist ? 1 : 0));
    const dUsed = new Set<number>();
    const eUsed = new Set<number>();
    for (const pr of pairs) {
      if (dUsed.has(pr.di) || eUsed.has(pr.ei)) continue;
      dUsed.add(pr.di);
      eUsed.add(pr.ei);
      const d = de[pr.di]!;
      const e = ex[pr.ei]!;
      const movedBps = (pr.dist * BPS) / d.price;
      const aged = nowMs - e.placedAtMs > c.maxQuoteAgeMs;
      if (movedBps > BigInt(c.refreshBps)) actions.push({ kind: "replace", id: e.id, to: d, reason: `price moved ${movedBps}bps` });
      else if (aged) actions.push({ kind: "replace", id: e.id, to: d, reason: "quote aged out" });
      else if (e.size > d.size || e.size * 2n < d.size) actions.push({ kind: "replace", id: e.id, to: d, reason: "size changed" });
    }
    de.forEach((d, di) => { if (!dUsed.has(di)) actions.push({ kind: "place", to: d }); });
    const free = ex.filter((_, ei) => !eUsed.has(ei));
    for (const e of free) actions.push({ kind: "cancel", id: e.id, from: e.from, reason: "no longer wanted" });
  }
  return actions;
}

// ---------------------------------------------------------------------------------------------------- gates
export interface GateInput {
  marketState: number; // 0 = Normal
  oracleFresh: boolean;
  /** seconds since the oracle last visibly updated (wall-clock watchdog in the bot) */
  oracleAgeSec: number;
  staleSec: number;
  markOk: boolean;
}
/** Returns a reason to STOP quoting (pull everything), or undefined when quoting is allowed. */
export function stopReason(g: GateInput): string | undefined {
  if (g.marketState !== 0) return `market state ${g.marketState} is not Normal`;
  if (!g.oracleFresh) return "oracle stale/degraded (contract view)";
  if (g.oracleAgeSec > g.staleSec) return `oracle older than ${g.staleSec}s (age ${g.oracleAgeSec}s)`;
  if (!g.markOk) return "mark price unavailable";
  return undefined;
}
export { abs as _abs };
