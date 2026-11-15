import { describe, expect, it } from "vitest";
import { Hedger, HyperliquidRefVenue, SimulatedVenue, divergenceBps, planHedge, toRaw, type HedgeConfig } from "../src/hedge.js";

const cfg: HedgeConfig = { thresholdRaw: toRaw(0.001), maxClipRaw: toRaw(0.01), minClipRaw: toRaw(0.0001), maxDivergenceBps: 100, cooldownMs: 0 };

describe("planHedge", () => {
  it("sells when the bot is long and buys when short", () => {
    expect(planHedge(toRaw(0.005), 0n, cfg)).toEqual({ isBuy: false, size: toRaw(0.005) });
    expect(planHedge(toRaw(-0.005), 0n, cfg)).toEqual({ isBuy: true, size: toRaw(0.005) });
  });
  it("does nothing inside the threshold or when already flat", () => {
    expect(planHedge(toRaw(0.001), 0n, cfg)).toBeNull();
    expect(planHedge(toRaw(0.005), toRaw(-0.005), cfg)).toBeNull();
  });
  it("caps one order at maxClip and only trades the residual", () => {
    expect(planHedge(toRaw(0.05), 0n, cfg)!.size).toBe(toRaw(0.01));
    expect(planHedge(toRaw(0.005), toRaw(-0.002), cfg)).toEqual({ isBuy: false, size: toRaw(0.003) });
  });
  it("skips diffs below the venue minimum", () => {
    expect(planHedge(toRaw(0.00005), 0n, { ...cfg, thresholdRaw: 0n })).toBeNull();
  });
});

describe("divergenceBps", () => {
  it("measures the gap in bps and treats bad prices as infinite", () => {
    expect(divergenceBps(50_500, 50_000)).toBeCloseTo(100, 6);
    expect(divergenceBps(0, 50_000)).toBe(Infinity);
  });
});

describe("Hedger with the simulated venue", () => {
  it("converges to a flat net exposure and reports fees in PnL", async () => {
    const v = new SimulatedVenue(async () => 50_000, 2.5);
    const h = new Hedger(v, "BTC", cfg);
    expect(await h.step(toRaw(0.025), 50_000)).toBeUndefined(); // clip 0.01
    expect(await h.step(toRaw(0.025), 50_000)).toBeUndefined();
    expect(await h.step(toRaw(0.025), 50_000)).toBeUndefined();
    expect(await v.position("BTC")).toBeCloseTo(-0.025, 8);
    expect(await h.step(toRaw(0.025), 50_000)).toBeUndefined(); // already hedged, no order
    expect(v.fills).toBe(3);
    expect(await v.pnl({ BTC: 50_000 })).toBeLessThan(0); // only fees on a flat mark
  });
  it("pulls quotes when the venue and oracle disagree", async () => {
    const v = new SimulatedVenue(async () => 50_000);
    const why = await new Hedger(v, "BTC", cfg).step(0n, 51_000);
    expect(why).toMatch(/differ by/);
    expect(v.fills).toBe(0);
  });
  it("pulls quotes when the venue is unreachable", async () => {
    const v = new SimulatedVenue(async () => { throw new Error("down"); });
    expect(await new Hedger(v, "BTC", cfg).step(0n, 50_000)).toMatch(/unreachable/);
  });
  it("a reference-only venue never trades", async () => {
    const fake = (async () => new Response(JSON.stringify({ BTC: "50010" }))) as unknown as typeof fetch;
    const v = new HyperliquidRefVenue("http://x", fake);
    const h = new Hedger(v, "BTC", cfg);
    expect(await h.step(toRaw(0.02), 50_000)).toBeUndefined();
    await expect(v.marketOrder()).rejects.toThrow(/read-only/);
  });
});
