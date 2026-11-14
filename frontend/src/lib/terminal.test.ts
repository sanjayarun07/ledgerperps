import { describe, expect, it } from "vitest";
import { groupLevels, pressure, quoteToBase, shortcutAction, sizeFromPercent, SHORTCUTS, sma, spreadInfo, stats24h } from "./terminal";

describe("sizeFromPercent / quoteToBase", () => {
  const base = { avail: 1_000_000_000n, price: 100_000_000_000n, lot: 10_000n, leverage: 1 }; // 1000 USDC, price 100000
  it("scales with percent and leverage", () => {
    expect(sizeFromPercent({ ...base, pct: 100 })).toBe(1_000_000n); // 0.01 BTC
    expect(sizeFromPercent({ ...base, pct: 50 })).toBe(500_000n);
    expect(sizeFromPercent({ ...base, pct: 25, leverage: 4 })).toBe(1_000_000n);
  });
  it("floors to the lot, caps at maxBase, and rejects empty input", () => {
    expect(sizeFromPercent({ ...base, pct: 33 })! % base.lot).toBe(0n);
    expect(sizeFromPercent({ ...base, pct: 100, maxBase: 300_000n })).toBe(300_000n);
    expect(sizeFromPercent({ ...base, pct: 0 })).toBeNull();
    expect(sizeFromPercent({ ...base, pct: 50, avail: 0n })).toBeNull();
  });
  it("converts quote to base on the lot grid", () => {
    expect(quoteToBase(500_000_000n, 100_000_000_000n, 10_000n)).toBe(500_000n);
    expect(quoteToBase(1n, 100_000_000_000n, 10_000n)).toBeNull();
  });
});
describe("stats24h", () => {
  const c = (time: number, o: number, h: number, l: number, cl: number, v: number) => ({ time, open: o, high: h, low: l, close: cl, volume: v });
  it("derives change, range and volume within 24h of chain time", () => {
    const now = 1_000_000;
    const s = stats24h([c(now - 100000, 1, 999, 0.1, 1, 50), c(now - 7200, 100, 110, 95, 105, 2), c(now - 3600, 105, 120, 100, 110, 1)], now)!;
    expect(s.open).toBe(100); expect(s.last).toBe(110); expect(s.change).toBe(10); expect(s.changePct).toBeCloseTo(10);
    expect(s.high).toBe(120); expect(s.low).toBe(95); expect(s.volumeBase).toBe(3);
    expect(s.volumeQuote).toBeCloseTo(2 * 105 + 110);
  });
  it("is null without trades in the window", () => {
    expect(stats24h([], 5)).toBeNull();
    expect(stats24h([c(0, 1, 1, 1, 1, 1)], 1_000_000)).toBeNull();
  });
});
describe("sma", () => {
  it("averages the trailing window", () => { expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]); });
});
describe("book helpers", () => {
  it("groups asks up and bids down, and sorts best-first", () => {
    const asks = groupLevels([{ p: 101n, s: 1n }, { p: 104n, s: 2n }, { p: 111n, s: 3n }], 10n, "ask");
    expect(asks).toEqual([{ p: 110n, s: 3n }, { p: 120n, s: 3n }].map((x) => x)); // 101,104 -> 110 ; 111 -> 120
    const bids = groupLevels([{ p: 99n, s: 1n }, { p: 91n, s: 2n }, { p: 89n, s: 5n }], 10n, "bid");
    expect(bids).toEqual([{ p: 90n, s: 3n }, { p: 80n, s: 5n }]);
  });
  it("computes pressure that sums to 100 and spread", () => {
    expect(pressure(3n, 1n)).toEqual({ buy: 75, sell: 25 });
    expect(pressure(0n, 0n)).toBeNull();
    expect(spreadInfo(99n * 10n ** 6n, 100n * 10n ** 6n)!.pct).toBeCloseTo(1);
    expect(spreadInfo(undefined, 5n)).toBeNull();
  });
});
describe("shortcuts", () => {
  it("maps keys and ignores plain keys while typing", () => {
    expect(shortcutAction({ key: "b" })).toBe("buy"); expect(shortcutAction({ key: "S" })).toBe("sell");
    expect(shortcutAction({ key: "l" })).toBe("limit"); expect(shortcutAction({ key: "m" })).toBe("market");
    expect(shortcutAction({ key: "/" })).toBe("focus-size"); expect(shortcutAction({ key: "?" })).toBe("help");
    expect(shortcutAction({ key: "b", targetTag: "INPUT" })).toBeNull();
    expect(shortcutAction({ key: "k", metaKey: true, targetTag: "INPUT" })).toBe("palette");
    expect(shortcutAction({ key: "Escape", targetTag: "INPUT" })).toBe("escape");
    expect(shortcutAction({ key: "b", ctrlKey: true })).toBeNull();
  });
  it("every documented shortcut action is reachable", () => {
    const reachable = new Set(["buy", "sell", "limit", "market", "focus-size", "help", "palette", "escape"]);
    for (const s of SHORTCUTS) expect(reachable.has(s.action)).toBe(true);
  });
});
