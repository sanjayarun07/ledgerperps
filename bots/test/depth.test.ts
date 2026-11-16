import { describe, expect, it } from "vitest";
import { toPrice } from "@perps/sdk";
import type { MarketConfig } from "@perps/sdk";
import { computeQuotes } from "../src/quotes.js";
import { THICK_BTC, MAX_OPEN_ORDERS, buildDepthPlan, estimateTxs, hasErrors, levelsInsideBand, preflight, requiredCollateral, sizeForUsd } from "../src/depth.js";

const px = toPrice(64500);
const mkt = {
  id: 0, exists: true, state: 0, feed: "0x00", tick: 100_000n, lot: 10_000n, minNotional: 10_000_000n, maxOrderSize: 100_000_000n, maxOI: 1_000_000_000n, oi: 0n,
  maxAge: 600, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n, fundingIndex: 0n, lastFunding: 0n, lastIndexPrice: px, lastTradePrice: 0n,
  tiers: [{ upToNotional: 100_000_000_000n, imrBps: 1000, mmrBps: 500 }, { upToNotional: 1_000_000_000_000n, imrBps: 2000, mmrBps: 1000 }, { upToNotional: (1n << 128n) - 1n, imrBps: 5000, mmrBps: 2500 }],
} as unknown as MarketConfig;
const plan = (scale = 1) => buildDepthPlan({ tiers: THICK_BTC, subBase: 4, px, lot: mkt.lot, minNotional: mkt.minNotional, maxOrderSize: mkt.maxOrderSize, scale });
const base = { market: mkt, px, oracle: { fresh: true, ageSec: 20 }, refPriceUsd: 64490, ethBalance: 10n ** 18n, availableUsdc: 1_000_000_000_000n };

describe("thick ladder plan", () => {
  it("gives every tier its own subaccount pair and never exceeds the 32-order limit per subaccount (including reduce-only quotes)", () => {
    const p = plan();
    expect(p.map((d) => [d.bidSub, d.askSub])).toEqual([[4, 5], [6, 7], [8, 9]]);
    for (const d of p) {
      // simulate the worst case: bid-set account long (posts reduce-only asks), ask-set account short
      const q = computeQuotes(d.quote, { mid: px, netInventory: 0n, posBidSub: d.quote.levelSize * 3n, posAskSub: -d.quote.levelSize * 3n, twoSub: true, tick: mkt.tick, lot: mkt.lot, minNotional: mkt.minNotional, bandBps: mkt.bandBps });
      for (const sub of ["bidSub", "askSub"] as const) expect(q.filter((x) => x.from === sub).length).toBeLessThanOrEqual(MAX_OPEN_ORDERS);
    }
  });
  it("produces a thick, widening, non-overlapping ladder inside the price band", () => {
    const all = plan().flatMap((d) => computeQuotes(d.quote, { mid: px, netInventory: 0n, posBidSub: 0n, posAskSub: 0n, twoSub: true, tick: mkt.tick, lot: mkt.lot, minNotional: mkt.minNotional, bandBps: mkt.bandBps }));
    const bids = all.filter((x) => x.isBuy).map((x) => x.price).sort((a, b) => (a < b ? 1 : -1));
    const asks = all.filter((x) => !x.isBuy).map((x) => x.price).sort((a, b) => (a < b ? -1 : 1));
    expect(bids.length).toBeGreaterThanOrEqual(20);
    expect(asks.length).toBeGreaterThanOrEqual(20);
    expect(bids[0]! < px && asks[0]! > px).toBe(true);
    expect(new Set(bids).size).toBe(bids.length); // no two bids at the same price
    const lo = (px * 9600n) / 10_000n, hi = (px * 10_400n) / 10_000n;
    for (const b of bids) expect(b >= lo).toBe(true);
    for (const a of asks) expect(a <= hi).toBe(true);
    expect(Number((asks[0]! - bids[0]!) * 10_000n / px)).toBeLessThan(mkt.maxSpreadBps); // inside spread keeps the mark on the book
  });
  it("scale shrinks clip sizes but keeps lot alignment and the minimum notional", () => {
    const small = plan(0.1);
    for (const d of small) { expect(d.quote.levelSize % mkt.lot).toBe(0n); expect((d.quote.levelSize * px) / 10n ** 8n >= mkt.minNotional).toBe(true); }
    expect(small[2]!.quote.levelSize < plan(1)[2]!.quote.levelSize).toBe(true);
  });
  it("sizeForUsd rounds up to a lot, honours the minimum notional and the max order size", () => {
    expect(sizeForUsd(1, px, mkt.lot, mkt.minNotional, mkt.maxOrderSize) % mkt.lot).toBe(0n);
    expect((sizeForUsd(1, px, mkt.lot, mkt.minNotional, mkt.maxOrderSize) * px) / 10n ** 8n >= 12_000_000n).toBe(true);
    expect(sizeForUsd(10_000_000, px, mkt.lot, mkt.minNotional, mkt.maxOrderSize)).toBe(mkt.maxOrderSize);
  });
  it("rejects a tier whose refresh distance is not smaller than its spread", () => {
    expect(() => buildDepthPlan({ tiers: [{ ...THICK_BTC[0]!, refreshBps: 4 }], subBase: 4, px, lot: mkt.lot, minNotional: mkt.minNotional, maxOrderSize: mkt.maxOrderSize })).toThrow();
  });
});

describe("band, capital and gas arithmetic", () => {
  it("counts levels that fit inside 80% of the band", () => {
    expect(levelsInsideBand(THICK_BTC[0]!, 500)).toBe(8);
    expect(levelsInsideBand({ ...THICK_BTC[2]!, levels: 12 }, 500)).toBe(8); // 180 + 30*l <= 400 -> l <= 7
    expect(levelsInsideBand(THICK_BTC[2]!, 100)).toBe(0);
  });
  it("collateral requirement grows with the plan and uses the account's IMR tier", () => {
    const r1 = requiredCollateral(mkt, plan(1), px), r2 = requiredCollateral(mkt, plan(0.5), px);
    expect(r1.orders).toBe(48);
    expect(r1.total > r2.total).toBe(true);
    expect(r1.total).toBeGreaterThan(0n);
  });
  it("estimates transactions from tier refresh ages", () => {
    expect(estimateTxs(plan(), 500, 24)).toBeGreaterThan(estimateTxs(plan(), 500, 1));
  });
});

describe("preflight", () => {
  it("passes a healthy setup", () => { expect(hasErrors(preflight({ ...base, plan: plan() }))).toBe(false); });
  it("fails a stale oracle", () => { expect(hasErrors(preflight({ ...base, plan: plan(), oracle: { fresh: false, ageSec: 4000 } }))).toBe(true); });
  it("fails when the oracle is far from the reference price", () => { expect(hasErrors(preflight({ ...base, plan: plan(), refPriceUsd: 60000 }))).toBe(true); });
  it("fails and suggests a scale when collateral is short", () => {
    const cs = preflight({ ...base, plan: plan(), availableUsdc: 1_000_000_000n });
    expect(hasErrors(cs)).toBe(true);
    expect(cs.some((c) => /DEPTH_SCALE/.test(c.msg))).toBe(true);
  });
  it("fails when a tier could exceed the on-chain order limit", () => {
    const p = buildDepthPlan({ tiers: [{ ...THICK_BTC[0]!, levels: 17 }], subBase: 4, px, lot: mkt.lot, minNotional: mkt.minNotional, maxOrderSize: mkt.maxOrderSize });
    expect(hasErrors(preflight({ ...base, plan: p }))).toBe(true);
  });
  it("fails when the inside spread would push the mark back to the index", () => {
    const p = buildDepthPlan({ tiers: [{ ...THICK_BTC[0]!, halfSpreadBps: 60, refreshBps: 5 }], subBase: 4, px, lot: mkt.lot, minNotional: mkt.minNotional, maxOrderSize: mkt.maxOrderSize });
    expect(hasErrors(preflight({ ...base, plan: p }))).toBe(true);
  });
  it("warns, not errors, when the open-interest cap is below the depth", () => {
    const cs = preflight({ ...base, plan: plan(), market: { ...mkt, maxOI: 100_000_000n } as MarketConfig });
    expect(cs.some((c) => c.level === "warn" && /open-interest/.test(c.msg))).toBe(true);
  });
  it("warns when ETH is low", () => { expect(preflight({ ...base, plan: plan(), ethBalance: 10n ** 15n }).some((c) => c.level === "warn" && /ETH/.test(c.msg))).toBe(true); });
});
