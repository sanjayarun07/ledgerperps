/**
 * Hedging for the market-maker bot. SIMULATED / TESTNET ONLY: nothing here moves real money.
 *
 * Idea: the bot quotes on Ledgerline and ends up with inventory (it bought from sellers, sold to buyers). A hedge
 * venue holds the opposite position so the bot's net price risk stays near zero, and its mid price is used as a
 * sanity reference for the oracle.
 *
 *   SimulatedVenue          in-memory venue: fills at its mid +/- a taker fee. No network. This is what actually hedges.
 *   HyperliquidRefVenue     READ-ONLY: pulls the Hyperliquid testnet mid price (public info API). It cannot place orders:
 *                           signing exchange actions is not implemented, so using it means "reference price only".
 *
 * Pure logic (planHedge, divergenceBps) is unit-tested in test/hedge.test.ts.
 */

const SIZE_SCALE = 1e8; // raw size units on Ledgerline

export interface HedgeVenue {
  readonly name: string;
  /** false for reference-only venues */
  readonly canTrade: boolean;
  /** reference mid price in USD */
  mid(symbol: string): Promise<number>;
  /** signed hedge position in base units (negative = short) */
  position(symbol: string): Promise<number>;
  /** market order of `size` base units; returns the fill price */
  marketOrder(symbol: string, isBuy: boolean, size: number): Promise<{ price: number }>;
}

export interface HedgeConfig {
  /** do not hedge until |net inventory + hedge position| exceeds this (raw 1e8 size) */
  thresholdRaw: bigint;
  /** largest single hedge order (raw 1e8 size) */
  maxClipRaw: bigint;
  /** smallest order the venue accepts (raw 1e8 size); smaller diffs are left unhedged */
  minClipRaw: bigint;
  /** pull quotes if the venue mid and the oracle differ by more than this (bps) */
  maxDivergenceBps: number;
  /** minimum time between hedge orders per market */
  cooldownMs: number;
}

export const toRaw = (units: number): bigint => BigInt(Math.round(units * SIZE_SCALE));
export const toUnits = (raw: bigint): number => Number(raw) / SIZE_SCALE;

/**
 * What to trade on the hedge venue. `net` = bot's signed position on Ledgerline, `hedgePos` = signed hedge position.
 * The hedge is flat-to-target when hedgePos == -net. Returns null when within the threshold or below the minimum clip.
 */
export function planHedge(net: bigint, hedgePos: bigint, cfg: HedgeConfig): { isBuy: boolean; size: bigint } | null {
  const exposure = net + hedgePos; // residual price exposure (long positive)
  const abs = exposure < 0n ? -exposure : exposure;
  if (abs <= cfg.thresholdRaw || abs < cfg.minClipRaw) return null;
  const size = abs > cfg.maxClipRaw ? cfg.maxClipRaw : abs;
  return { isBuy: exposure < 0n, size }; // long exposure => sell on the venue
}

/** |a - b| / b in bps */
export function divergenceBps(a: number, b: number): number {
  if (!(b > 0) || !(a > 0)) return Infinity;
  return (Math.abs(a - b) / b) * 10_000;
}

export class SimulatedVenue implements HedgeVenue {
  readonly name = "simulated-venue";
  readonly canTrade = true;
  private pos = new Map<string, number>();
  private cash = 0; // realized cash flow in USD (buys negative)
  private fees = 0;
  fills = 0;
  /** price source, e.g. the oracle or a perturbed oracle in tests */
  constructor(private priceOf: (symbol: string) => Promise<number>, private takerFeeBps = 2.5) {}
  mid(symbol: string) { return this.priceOf(symbol); }
  async position(symbol: string) { return this.pos.get(symbol) ?? 0; }
  async marketOrder(symbol: string, isBuy: boolean, size: number) {
    const mid = await this.priceOf(symbol);
    const price = mid * (1 + (isBuy ? 1 : -1) * (this.takerFeeBps / 10_000));
    this.pos.set(symbol, (this.pos.get(symbol) ?? 0) + (isBuy ? size : -size));
    this.cash += (isBuy ? -1 : 1) * size * mid;
    this.fees += size * mid * (this.takerFeeBps / 10_000);
    this.fills++;
    return { price };
  }
  /** mark-to-market PnL of the hedge book, USD, net of simulated fees */
  async pnl(marks: Record<string, number>): Promise<number> {
    let v = this.cash - this.fees;
    for (const [s, p] of this.pos) v += p * (marks[s] ?? 0);
    return v;
  }
}

export class HyperliquidRefVenue implements HedgeVenue {
  readonly name = "hyperliquid-testnet (reference price only)";
  readonly canTrade = false;
  private cache?: { at: number; mids: Record<string, string> };
  constructor(private url = process.env.HL_INFO_URL ?? "https://api.hyperliquid-testnet.xyz/info", private fetchImpl: typeof fetch = fetch) {}
  async mid(symbol: string): Promise<number> {
    if (!this.cache || Date.now() - this.cache.at > 2_000) {
      const r = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
      if (!r.ok) throw new Error(`hyperliquid info HTTP ${r.status}`);
      this.cache = { at: Date.now(), mids: (await r.json()) as Record<string, string> };
    }
    const v = Number(this.cache.mids[symbol]);
    if (!(v > 0)) throw new Error(`hyperliquid has no mid for ${symbol}`);
    return v;
  }
  async position(): Promise<number> { return 0; }
  async marketOrder(): Promise<{ price: number }> {
    throw new Error("HyperliquidRefVenue is read-only: order signing is not implemented");
  }
}

/** Per-market hedger: call `step` each tick with the bot's net inventory and the oracle price. */
export class Hedger {
  private lastOrderAt = 0;
  hedged = 0; // orders sent
  constructor(private venue: HedgeVenue, private symbol: string, private cfg: HedgeConfig, private log: (m: string) => void = () => {}) {}

  /** Returns a reason to stop quoting (price divergence / venue unreachable), or undefined. */
  async step(net: bigint, oracleUsd: number, now = Date.now()): Promise<string | undefined> {
    let ref: number;
    try { ref = await this.venue.mid(this.symbol); } catch (e) { return `hedge venue unreachable: ${(e as Error).message.split("\n")[0]}`; }
    const div = divergenceBps(ref, oracleUsd);
    if (div > this.cfg.maxDivergenceBps) return `oracle ${oracleUsd.toFixed(2)} vs ${this.venue.name} ${ref.toFixed(2)} differ by ${div.toFixed(0)} bps`;
    if (!this.venue.canTrade || now - this.lastOrderAt < this.cfg.cooldownMs) return undefined;
    const plan = planHedge(net, toRaw(await this.venue.position(this.symbol)), this.cfg);
    if (!plan) return undefined;
    try {
      const f = await this.venue.marketOrder(this.symbol, plan.isBuy, toUnits(plan.size));
      this.lastOrderAt = now; this.hedged++;
      this.log(`hedge ${plan.isBuy ? "buy" : "sell"} ${toUnits(plan.size)} ${this.symbol} @ ${f.price.toFixed(2)} on ${this.venue.name}`);
    } catch (e) { this.log(`hedge order failed: ${(e as Error).message.split("\n")[0]}`); }
    return undefined;
  }
}
