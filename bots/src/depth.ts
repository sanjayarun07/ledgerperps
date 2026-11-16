/**
 * Thick-book planning for the testnet market maker. SIMULATED LIQUIDITY - NOT REAL. Pure functions (no I/O) so they can be unit-tested.
 *
 * Why this exists: one account may rest at most MAX_OPEN_ORDERS (32) orders on-chain, so a deep book needs several subaccounts.
 * A "tier" is one MarketMakerBot with its own (bidSub, askSub) pair and its own spacing/size/refresh settings: a near tier with tight
 * spacing and small clips, a middle tier, and a far tier with wide spacing and big clips. Together they form one ladder.
 */
import { BPS, notionalFloor, type MarketConfig } from "@perps/sdk";
import { BAND_SAFETY_PCT, type QuoteConfig } from "./quotes.js";

export const MAX_OPEN_ORDERS = 32; // PerpBase.MAX_OPEN_ORDERS (per account/subaccount)

export interface LadderTier {
  name: string;
  /** distance of level 0 from the oracle mid, bps */
  halfSpreadBps: number;
  levels: number;
  stepBps: number;
  /** clip size per level, USD notional */
  levelUsd: number;
  /** replace a resting quote that is further than this from its target (must be < halfSpreadBps) */
  refreshBps: number;
  maxQuoteAgeSec: number;
}

/** Default BTC ladder: ~24 levels per side from 4 bps to ~390 bps, about $184k per side at scale 1. */
export const THICK_BTC: LadderTier[] = [
  { name: "near", halfSpreadBps: 4, levels: 8, stepBps: 3, levelUsd: 2_000, refreshBps: 3, maxQuoteAgeSec: 300 },
  { name: "mid", halfSpreadBps: 40, levels: 8, stepBps: 15, levelUsd: 6_000, refreshBps: 12, maxQuoteAgeSec: 900 },
  { name: "far", halfSpreadBps: 180, levels: 8, stepBps: 30, levelUsd: 15_000, refreshBps: 40, maxQuoteAgeSec: 2400 },
];

export interface DepthTier {
  tier: LadderTier;
  bidSub: number;
  askSub: number;
  quote: QuoteConfig;
}

export interface PlanInput {
  tiers: LadderTier[];
  /** first subaccount id used (tier k uses subBase+2k for bids and subBase+2k+1 for asks) */
  subBase: number;
  /** oracle price, raw 1e6 */
  px: bigint;
  lot: bigint;
  minNotional: bigint;
  maxOrderSize: bigint;
  /** multiplies every clip size (e.g. 0.25 for a quarter of the depth) */
  scale?: number;
  skewBps?: number;
}

/** Raw size (1e8) for `usd` of notional: rounded UP to a lot, never below 1.2x the market minimum, never above the max order size. */
export function sizeForUsd(usd: number, px: bigint, lot: bigint, minNotional: bigint, maxOrderSize: bigint): bigint {
  const want = (BigInt(Math.round(usd * 1e6)) * 10n ** 8n) / px;
  let sz = ((want + lot - 1n) / lot) * lot;
  while (notionalFloor(sz, px) < (minNotional * 12n) / 10n) sz += lot;
  if (sz > maxOrderSize) sz = (maxOrderSize / lot) * lot;
  return sz;
}

export function buildDepthPlan(p: PlanInput): DepthTier[] {
  const scale = p.scale ?? 1;
  if (!(scale > 0)) throw new Error("scale must be > 0");
  return p.tiers.map((t, k) => {
    if (t.refreshBps >= t.halfSpreadBps) throw new Error(`tier ${t.name}: refreshBps must be < halfSpreadBps`);
    const levelSize = sizeForUsd(t.levelUsd * scale, p.px, p.lot, p.minNotional, p.maxOrderSize);
    return {
      tier: t,
      bidSub: p.subBase + 2 * k,
      askSub: p.subBase + 2 * k + 1,
      quote: {
        halfSpreadBps: t.halfSpreadBps, levels: t.levels, levelStepBps: t.stepBps, levelSize,
        maxInventory: levelSize * BigInt(t.levels), skewBps: p.skewBps ?? 10, keepMinSize: true,
        refreshBps: t.refreshBps, maxQuoteAgeMs: t.maxQuoteAgeSec * 1000,
      },
    };
  });
}

/** How many levels per side survive the band rule (quotes beyond BAND_SAFETY_PCT of bandBps are not placed). */
export function levelsInsideBand(t: LadderTier, bandBps: number): number {
  const limit = (bandBps * Number(BAND_SAFETY_PCT)) / 100;
  let n = 0;
  for (let l = 0; l < t.levels; l++) if (t.halfSpreadBps + l * t.stepBps <= limit) n++;
  return n;
}

export type Level = "ok" | "warn" | "error";
export interface Check { level: Level; msg: string }

export interface PreflightInput {
  market: MarketConfig;
  plan: DepthTier[];
  px: bigint;
  oracle: { fresh: boolean; ageSec: number };
  /** independent spot price in USD (e.g. Coinbase) if reachable */
  refPriceUsd?: number;
  ethBalance: bigint; // wei
  /** total free USDC across the subaccounts the plan will use, raw 1e6 */
  availableUsdc: bigint;
  /** estimated ETH cost of one transaction (default 0.00003) */
  ethPerTx?: number;
  hours?: number;
}

const imrFor = (m: MarketConfig, notional: bigint): number => {
  for (const t of m.tiers) if (notional <= t.upToNotional) return t.imrBps;
  return m.tiers[m.tiers.length - 1]!.imrBps;
};

export interface Requirement { restingMargin: bigint; positionMargin: bigint; total: bigint; perSide: bigint; orders: number }

/** Conservative collateral needed for the whole plan: margin reserved for every resting order plus margin if one full side fills. */
export function requiredCollateral(m: MarketConfig, plan: DepthTier[], px: bigint): Requirement {
  let resting = 0n, position = 0n, perSide = 0n, orders = 0;
  for (const d of plan) {
    const n = Math.min(d.tier.levels, levelsInsideBand(d.tier, m.bandBps));
    const sideNotional = notionalFloor(d.quote.levelSize, px) * BigInt(n);
    const imr = BigInt(imrFor(m, sideNotional));
    resting += (2n * sideNotional * imr) / BPS;
    position += (sideNotional * imr) / BPS;
    perSide += sideNotional;
    orders += 2 * n;
  }
  return { restingMargin: resting, positionMargin: position, total: resting + position, perSide, orders };
}

/** Rough ETH needed: every resting order is cancelled and replaced about once per max quote age, plus the initial placement. */
export function estimateTxs(plan: DepthTier[], bandBps: number, hours: number): number {
  let tx = 0;
  for (const d of plan) {
    const n = Math.min(d.tier.levels, levelsInsideBand(d.tier, bandBps));
    const perHour = 3600 / d.tier.maxQuoteAgeSec;
    tx += 2 * n * (1 + 2 * perHour * hours); // cancel + place per refresh, both sides; first term = initial placement
  }
  return Math.round(tx);
}

export function preflight(i: PreflightInput): Check[] {
  const c: Check[] = [];
  const add = (level: Level, msg: string) => c.push({ level, msg });
  const m = i.market;
  const usd = (x: bigint) => `$${(Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  // ---- oracle
  if (m.state !== 0) add("error", `market state ${m.state} is not Normal`);
  if (!i.oracle.fresh) add("error", "oracle is stale or degraded on-chain: the exchange will refuse marks");
  else if (i.oracle.ageSec > m.maxAge * 0.5) add("warn", `oracle is ${i.oracle.ageSec}s old (contract limit ${m.maxAge}s): a slow feed risks OracleDegraded`);
  else add("ok", `oracle fresh (${i.oracle.ageSec}s old, limit ${m.maxAge}s), price $${(Number(i.px) / 1e6).toFixed(2)}`);
  if (i.refPriceUsd !== undefined) {
    const dev = (Math.abs(Number(i.px) / 1e6 - i.refPriceUsd) / i.refPriceUsd) * 1e4;
    if (dev > 200) add("error", `oracle differs from the reference price by ${dev.toFixed(0)} bps: this is not "actual price" paper trading`);
    else if (dev > 50) add("warn", `oracle differs from the reference price by ${dev.toFixed(0)} bps (feed lag)`);
    else add("ok", `oracle within ${dev.toFixed(1)} bps of the reference price $${i.refPriceUsd.toFixed(2)}`);
  } else add("warn", "no independent reference price reachable: price accuracy not cross-checked");

  // ---- geometry
  const outerHalf = Math.max(...i.plan.map((d) => d.tier.halfSpreadBps));
  if (2 * Math.min(...i.plan.map((d) => d.tier.halfSpreadBps)) >= m.maxSpreadBps)
    add("error", `inside spread ${2 * Math.min(...i.plan.map((d) => d.tier.halfSpreadBps))} bps >= maxSpreadBps ${m.maxSpreadBps}: the mark would fall back to the index`);
  for (const d of i.plan) {
    const t = d.tier;
    if (2 * t.levels > MAX_OPEN_ORDERS) add("error", `tier ${t.name}: up to ${2 * t.levels} resting orders per subaccount (bids + reduce-only asks) exceeds the on-chain limit ${MAX_OPEN_ORDERS}`);
    const inside = levelsInsideBand(t, m.bandBps);
    if (inside === 0) add("error", `tier ${t.name}: no level fits inside ${(m.bandBps * Number(BAND_SAFETY_PCT)) / 100} bps (80% of the ${m.bandBps} bps price band)`);
    else if (inside < t.levels) add("warn", `tier ${t.name}: only ${inside} of ${t.levels} levels fit inside the price band, the rest will not be quoted`);
    if (d.quote.levelSize % m.lot !== 0n) add("error", `tier ${t.name}: clip size is not a lot multiple`);
    if (d.quote.levelSize > m.maxOrderSize) add("error", `tier ${t.name}: clip size exceeds maxOrderSize`);
    if (notionalFloor(d.quote.levelSize, i.px) < m.minNotional) add("error", `tier ${t.name}: clip notional is below the market minimum`);
  }
  if (!c.some((x) => x.level === "error" && /tier|spread/.test(x.msg))) add("ok", `ladder geometry valid: ${i.plan.length} tiers, inside spread ${2 * Math.min(...i.plan.map((d) => d.tier.halfSpreadBps))} bps, outermost ${outerHalf + 0} bps start`);

  // ---- capital
  const req = requiredCollateral(m, i.plan, i.px);
  add("ok", `plan rests ${req.orders} orders, ${usd(req.perSide)} per side; conservative collateral needed ${usd(req.total)} (resting ${usd(req.restingMargin)} + position ${usd(req.positionMargin)})`);
  if (i.availableUsdc < req.total) {
    const f = Number(i.availableUsdc) / Number(req.total);
    add("error", `free collateral ${usd(i.availableUsdc)} is below ${usd(req.total)}: use DEPTH_SCALE<=${f >= 0.01 ? (Math.floor(f * 100) / 100).toString() : f.toPrecision(1)} or fund more (Circle test USDC cannot be minted: deploy with USE_MOCK_USDC=yes for free test collateral)`);
  } else add("ok", `free collateral ${usd(i.availableUsdc)} covers the plan`);

  // ---- gas
  const hours = i.hours ?? 24;
  const txs = estimateTxs(i.plan, m.bandBps, hours);
  const eth = txs * (i.ethPerTx ?? 0.00003);
  const have = Number(i.ethBalance) / 1e18;
  if (have < eth) add("warn", `about ${txs} transactions over ${hours}h needs roughly ${eth.toFixed(3)} ETH; wallet has ${have.toFixed(3)} (rough estimate)`);
  else add("ok", `ETH ${have.toFixed(3)} covers about ${txs} transactions over ${hours}h (rough estimate ${eth.toFixed(3)} ETH)`);

  // ---- open interest
  const oiCapUsd = (Number(m.maxOI) / 1e8) * (Number(i.px) / 1e6);
  if (Number(req.perSide) / 1e6 > oiCapUsd) add("warn", `depth per side ${usd(req.perSide)} exceeds the open-interest cap (~$${oiCapUsd.toFixed(0)}): takers cannot trade all of it. Raise maxOI via setMarketParams if you want it usable`);
  else add("ok", `open-interest cap ~$${oiCapUsd.toFixed(0)} is above one side of depth`);
  return c;
}

export const hasErrors = (cs: Check[]) => cs.some((c) => c.level === "error");
