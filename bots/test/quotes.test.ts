import { describe, expect, it } from "vitest";
import { toPrice, toSize } from "@perps/sdk";
import { computeQuotes, planActions, stopReason, validateQuoteConfig, type ExistingQuote, type QuoteConfig } from "../src/quotes.js";
import { nextPrice } from "../src/oracle-driver.js";
import { isLoopbackUrl } from "../src/local.js";

const cfg: QuoteConfig = { halfSpreadBps: 10, levels: 3, levelStepBps: 5, levelSize: toSize("0.1"), maxInventory: toSize("0.5"), skewBps: 10, refreshBps: 4, maxQuoteAgeMs: 30_000 };
const base = { mid: toPrice(50000), netInventory: 0n, posBidSub: 0n, posAskSub: 0n, twoSub: true, tick: 100_000n, lot: 10_000n, minNotional: 10_000_000n };
const bids = (q: ReturnType<typeof computeQuotes>) => q.filter((x) => x.isBuy);
const asks = (q: ReturnType<typeof computeQuotes>) => q.filter((x) => !x.isBuy);

describe("computeQuotes stays inside the exchange price band (WASH-1)", () => {
  it("drops levels beyond 80% of bandBps so resting quotes are never cancelled with PriceBand", () => {
    const wide: QuoteConfig = { ...cfg, halfSpreadBps: 150, levelStepBps: 150, levels: 5 }; // offsets 150,300,450,600,750 bps
    const q = computeQuotes(wide, { ...base, bandBps: 500 }); // allowed: 400 bps
    expect(bids(q).length).toBe(2);
    expect(asks(q).length).toBe(2);
    const lo = (base.mid * (10_000n - 400n)) / 10_000n;
    const hi = (base.mid * (10_000n + 400n)) / 10_000n;
    for (const x of q) expect(x.price >= lo && x.price <= hi).toBe(true);
    // unknown band => legacy behaviour (all levels)
    expect(bids(computeQuotes(wide, base)).length).toBe(5);
  });
  it("default bot personalities (<= ~50 bps) fit comfortably in the deploy.js band of 500 bps", () => {
    for (const [h, s] of [[8, 6], [14, 8], [22, 12]] as const) {
      const c: QuoteConfig = { ...cfg, halfSpreadBps: h, levelStepBps: s, levels: 3 };
      const withBand = computeQuotes(c, { ...base, bandBps: 500 });
      expect(withBand).toEqual(computeQuotes(c, base));
    }
  });
});

describe("computeQuotes", () => {
  it("quotes both sides symmetrically around the oracle, tick-aligned, never crossed", () => {
    const q = computeQuotes(cfg, base);
    expect(bids(q)).toHaveLength(3);
    expect(asks(q)).toHaveLength(3);
    expect(bids(q)[0]!.price).toBe(toPrice(49950)); // 10 bps
    expect(asks(q)[0]!.price).toBe(toPrice(50050));
    for (const x of q) expect(x.price % base.tick).toBe(0n);
    expect(bids(q).every((b) => b.price < base.mid) && asks(q).every((a) => a.price > base.mid)).toBe(true);
    expect(bids(q)[0]!.from).toBe("bidSub");
    expect(asks(q)[0]!.from).toBe("askSub");
    // strictly monotone ladders
    for (let i = 1; i < 3; i++) {
      expect(bids(q)[i]!.price).toBeLessThan(bids(q)[i - 1]!.price);
      expect(asks(q)[i]!.price).toBeGreaterThan(asks(q)[i - 1]!.price);
    }
  });
  it("skews quotes down and shrinks bids when long", () => {
    const flat = computeQuotes(cfg, base);
    const long = computeQuotes(cfg, { ...base, netInventory: toSize("0.25"), posBidSub: toSize("0.25") });
    expect(bids(long)[0]!.price).toBeLessThan(bids(flat)[0]!.price);
    expect(asks(long)[0]!.price).toBeLessThan(asks(flat)[0]!.price);
    const sum = (x: ReturnType<typeof computeQuotes>) => x.reduce((s, y) => s + y.size, 0n);
    expect(sum(bids(long))).toBeLessThan(sum(bids(flat)));
  });
  it("never lets quotes exceed the inventory limit; stops the risk-increasing side at the limit", () => {
    const atLimit = computeQuotes(cfg, { ...base, netInventory: cfg.maxInventory, posBidSub: cfg.maxInventory });
    expect(bids(atLimit).filter((b) => !b.reduceOnly)).toHaveLength(0);
    expect(asks(atLimit).length).toBeGreaterThan(0);
    // total new-risk bid size <= remaining room
    const near = computeQuotes(cfg, { ...base, netInventory: toSize("0.45"), posBidSub: toSize("0.45") });
    const room = bids(near).reduce((s, b) => s + b.size, 0n);
    expect(room).toBeLessThanOrEqual(toSize("0.05"));
    const short = computeQuotes(cfg, { ...base, netInventory: -cfg.maxInventory, posAskSub: -cfg.maxInventory });
    expect(asks(short).filter((a) => !a.reduceOnly)).toHaveLength(0);
  });
  it("two-sub mode posts reduce-only unwinding quotes from the account holding the position", () => {
    const q = computeQuotes(cfg, { ...base, netInventory: toSize("0.2"), posBidSub: toSize("0.2"), posAskSub: 0n });
    const ro = q.filter((x) => x.reduceOnly);
    expect(ro.length).toBeGreaterThan(0);
    expect(ro.every((x) => !x.isBuy && x.from === "bidSub")).toBe(true);
    expect(ro.reduce((s, x) => s + x.size, 0n)).toBeLessThanOrEqual(toSize("0.2"));
    const single = computeQuotes(cfg, { ...base, twoSub: false, netInventory: toSize("0.2"), posBidSub: toSize("0.2"), posAskSub: toSize("0.2") });
    expect(single.some((x) => x.reduceOnly)).toBe(false);
  });
  it("drops quotes below min notional and rejects configs where refresh >= half spread", () => {
    const tiny = computeQuotes({ ...cfg, levelSize: toSize("0.0001") }, base);
    expect(tiny).toHaveLength(0);
    expect(() => validateQuoteConfig({ ...cfg, refreshBps: 10 })).toThrow();
  });
});

describe("planActions", () => {
  const desired = computeQuotes(cfg, base);
  const mk = (d: (typeof desired)[number], i: number, o: Partial<ExistingQuote> = {}): ExistingQuote => ({ id: BigInt(i + 1), from: d.from, isBuy: d.isBuy, price: d.price, size: d.size, reduceOnly: d.reduceOnly, placedAtMs: 1000, ...o });
  it("keeps fresh matching quotes, places missing ones", () => {
    const ex = desired.slice(1).map((d, i) => mk(d, i));
    const a = planActions(cfg, ex, desired, 2000);
    expect(a.filter((x) => x.kind === "place")).toHaveLength(1);
    expect(a.filter((x) => x.kind !== "place")).toHaveLength(0);
  });
  it("replaces quotes when the oracle moved beyond refreshBps, or when too old", () => {
    const moved = desired.map((d, i) => mk(d, i, { price: d.price + (d.isBuy ? 1n : 1n) * toPrice(50) }));
    expect(planActions(cfg, moved, desired, 2000).every((x) => x.kind === "replace")).toBe(true);
    const old = desired.map((d, i) => mk(d, i));
    const a = planActions(cfg, old, desired, 1000 + cfg.maxQuoteAgeMs + 1);
    expect(a.filter((x) => x.kind === "replace")).toHaveLength(desired.length);
  });
  it("cancels quotes that are no longer wanted", () => {
    const ex = desired.map((d, i) => mk(d, i));
    const a = planActions(cfg, ex, [], 2000);
    expect(a.every((x) => x.kind === "cancel")).toBe(true);
    expect(a).toHaveLength(desired.length);
  });
});

describe("stop conditions", () => {
  const ok = { marketState: 0, oracleFresh: true, oracleAgeSec: 1, staleSec: 20, markOk: true };
  it("quotes only when Normal + fresh oracle", () => {
    expect(stopReason(ok)).toBeUndefined();
    expect(stopReason({ ...ok, marketState: 1 })).toMatch(/not Normal/);
    expect(stopReason({ ...ok, marketState: 2 })).toMatch(/not Normal/);
    expect(stopReason({ ...ok, marketState: 3 })).toMatch(/not Normal/);
    expect(stopReason({ ...ok, oracleFresh: false })).toMatch(/stale/);
    expect(stopReason({ ...ok, oracleAgeSec: 21 })).toMatch(/older than/);
    expect(stopReason({ ...ok, markOk: false })).toMatch(/mark/);
  });
});

describe("oracle driver helpers", () => {
  it("random walk stays within the deviation band and on ticks", () => {
    let p = toPrice(50000);
    const anchor = p;
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) * 6;
    for (let i = 0; i < 5000; i++) {
      p = nextPrice(p, anchor, rnd(), { sigmaBps: 50, revert: 0.02, maxDevPct: 4, tick: 100_000n });
      expect(p % 100_000n).toBe(0n);
      expect(Number(p)).toBeGreaterThanOrEqual(Number(anchor) * 0.96 - 1e5);
      expect(Number(p)).toBeLessThanOrEqual(Number(anchor) * 1.04 + 1e5);
    }
  });
  it("loopback check", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8545")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8545")).toBe(true);
    expect(isLoopbackUrl("https://rpc.example.org")).toBe(false);
  });
});

import { assertLocalDev } from "../src/local.js";
describe("local-dev guard (oracle driver / seed / bots)", () => {
  const fake = (id: number) => ({ chainId: async () => id }) as any;
  it("allows only chainId 31337 on a loopback RPC", async () => {
    await expect(assertLocalDev(fake(31337), "http://127.0.0.1:8545", "t")).resolves.toBeUndefined();
    await expect(assertLocalDev(fake(1), "http://127.0.0.1:8545", "t")).rejects.toThrow(/REFUSING/);
    await expect(assertLocalDev(fake(11155111), "http://localhost:8545", "t")).rejects.toThrow(/REFUSING/);
    // a remote RPC claiming chainId 31337 (e.g. a public fork) is refused WITHOUT being queried
    await expect(assertLocalDev(fake(31337), "https://fork.example.org", "t")).rejects.toThrow(/REFUSING/);
  });
});

describe("keepMinSize (coarse lots, tiny levels)", () => {
  // BTC-like: lot 0.0001, min notional 10 USDC, level 0.0002 (~12 USDC), max inventory 0.0006. A short of 0.0002 scales asks to ~67% = 1 lot (~6.5 USDC) => dropped without keepMinSize.
  const tiny: QuoteConfig = { ...cfg, levels: 1, levelSize: toSize("0.0002"), maxInventory: toSize("0.0006") };
  const px = toPrice(65000);
  const inp = { ...base, mid: px, lot: toSize("0.0001"), tick: 100_000n, twoSub: false, netInventory: -toSize("0.0002") };
  it("drops the ask without the flag (documents the failure mode)", () => {
    expect(asks(computeQuotes(tiny, inp))).toHaveLength(0);
  });
  it("keeps a minimum-size ask with the flag, and never exceeds the inventory room", () => {
    const q = asks(computeQuotes({ ...tiny, keepMinSize: true }, inp));
    expect(q).toHaveLength(1);
    expect(q[0]!.size).toBe(toSize("0.0002")); // 0.0001 BTC is ~6.5 USDC < 10, so two lots
  });
  it("still stops quoting a side when inventory is at the limit", () => {
    const q = computeQuotes({ ...tiny, keepMinSize: true }, { ...inp, netInventory: -toSize("0.0006") });
    expect(asks(q)).toHaveLength(0);
  });
});
