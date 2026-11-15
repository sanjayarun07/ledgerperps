import { describe, expect, it } from "vitest";
import { buildOrderParams, sizeForLeverage, slippagePrice, TIF, validateBracket, validateTicket, validateTwap, type TicketInput } from "./order";
import { estimateLiqPrice, healthFraction, unrealizedPnl, entryPrice, mmrBpsFor } from "./risk";
import { fmtDuration, fmtPrice, fmtRatePct, fmtSigned, fmtSize, fmtUsd, formatFixed, notionalCeil, notionalFloor, parseDecimal } from "./units";

// BTC rules from the local deploy: tick 0.1 USDC, lot 0.0001 BTC, min notional 10 USDC
const R = { tick: 100000n, lot: 10000n, minNotional: 10_000_000n, maxOrderSize: 10n ** 12n };
const base: TicketInput = { type: "limit", isBuy: true, priceStr: "50000", sizeStr: "0.01", tif: "GTC", reduceOnly: false, slippageBps: 50, refPrice: 50_000_000_000n, position: 0n };

describe("units", () => {
  it("formats and parses", () => {
    expect(formatFixed(50_000_123_456n, 6, 2, 2, true)).toBe("50,000.12");
    expect(formatFixed(-1_500_000n, 6, 2, 2)).toBe("-1.50");
    expect(formatFixed(-1n, 6, 2, 2)).toBe("0.00"); // no negative zero
    expect(fmtSize(150_000_000n)).toBe("1.5");
    expect(fmtSize(1n, 8)).toBe("0.00000001");
    expect(fmtPrice(999_999n, 2)).toBe("1.00");
    expect(fmtUsd(1_234_567_890n)).toBe("1,234.57");
    expect(fmtSigned(5_000_000n, 6, 2)).toBe("+5.00");
    expect(parseDecimal("1.5", 8)).toBe(150_000_000n);
    expect(parseDecimal(".5", 6)).toBe(500_000n);
    expect(parseDecimal("1.1234567", 6)).toBeNull();
    expect(parseDecimal("-1", 6)).toBeNull();
    expect(parseDecimal("", 6)).toBeNull();
    expect(parseDecimal("1e3", 6)).toBeNull();
  });
  it("notional matches contract (size*price/1e8)", () => {
    expect(notionalFloor(40_000_000n, 50_000_000_000n)).toBe(20_000_000_000n); // 0.4 BTC @ 50k = 20,000
    expect(notionalFloor(-40_000_000n, 50_000_000_000n)).toBe(20_000_000_000n);
    expect(notionalCeil(1n, 1n)).toBe(1n);
    expect(notionalFloor(1n, 1n)).toBe(0n);
  });
  it("rate and duration", () => {
    expect(fmtRatePct(400_000_000n)).toBe("0.0400%"); // 0.04% cap
    expect(fmtDuration(3725)).toBe("01:02:05");
    expect(fmtDuration(-4)).toBe("00:00:00");
  });
});

describe("ticket validation", () => {
  it("accepts a valid limit order", () => {
    const v = validateTicket(base, R);
    expect(v.ok).toBe(true);
    expect(v.price).toBe(50_000_000_000n);
    expect(v.size).toBe(1_000_000n);
    expect(v.notional).toBe(500_000_000n);
  });
  it("rejects off-tick, off-lot, tiny notional, too many decimals", () => {
    expect(validateTicket({ ...base, priceStr: "50000.05" }, R).errors.join()).toMatch(/tick/);
    expect(validateTicket({ ...base, sizeStr: "0.00015" }, R).errors.join()).toMatch(/lot/);
    expect(validateTicket({ ...base, sizeStr: "0.0001" }, R).errors.join()).toMatch(/minimum notional/); // 5 USDC
    expect(validateTicket({ ...base, priceStr: "1.1234567" }, R).ok).toBe(false);
    expect(validateTicket({ ...base, sizeStr: "" }, R).errors[0]).toMatch(/Enter a size/);
    expect(validateTicket({ ...base, sizeStr: "99999999" }, R).errors.join()).toMatch(/max order/);
  });
  it("reduce-only needs an opposite position and skips min notional", () => {
    expect(validateTicket({ ...base, reduceOnly: true }, R).errors.join()).toMatch(/open position/);
    expect(validateTicket({ ...base, reduceOnly: true, position: 100n }, R).errors.join()).toMatch(/opposite/);
    const ok = validateTicket({ ...base, reduceOnly: true, isBuy: false, position: 1_000_000n, sizeStr: "0.0001" }, R);
    expect(ok.ok).toBe(true);
  });
  it("market orders derive a slippage-bounded price on the tick grid", () => {
    const buy = validateTicket({ ...base, type: "market", priceStr: "", bookTop: 50_000_000_000n, slippageBps: 50 }, R);
    expect(buy.price).toBe(50_250_000_000n);
    expect(buy.price! % R.tick).toBe(0n);
    expect(slippagePrice(50_000_123_456n, true, 50, 100000n)! % 100000n).toBe(0n);
    expect(slippagePrice(50_000_000_000n, false, 100, 100000n)).toBe(49_500_000_000n);
    expect(slippagePrice(50_000_000_000n, true, 0, 100000n)).toBe(50_000_000_000n);
  });
});

describe("order param building", () => {
  it("maps tif and forces IOC for market", () => {
    const p = buildOrderParams({ market: 1, isBuy: false, price: 3n, size: 4n, type: "limit", tif: "PostOnly", reduceOnly: true });
    expect(p).toEqual({ market: 1, isBuy: false, price: 3n, size: 4n, tif: TIF.PostOnly, reduceOnly: true, cloid: 0n, expiry: 0n });
    expect(buildOrderParams({ market: 0, isBuy: true, price: 1n, size: 1n, type: "market", tif: "GTC", reduceOnly: false }).tif).toBe(TIF.IOC);
    expect(TIF).toEqual({ GTC: 0, IOC: 1, FOK: 2, PostOnly: 3 });
  });
  it("bracket and twap validation", () => {
    expect(validateBracket({ isLong: true, mark: 50_000_000_000n, tp: 55_000_000_000n, sl: 45_000_000_000n, tick: 100000n })).toEqual([]);
    expect(validateBracket({ isLong: true, mark: 50_000_000_000n, tp: 45_000_000_000n, sl: 55_000_000_000n, tick: 100000n }).length).toBe(2);
    expect(validateBracket({ isLong: false, mark: 50_000_000_000n, tp: 45_000_000_000n, sl: 55_000_000_000n, tick: 100000n })).toEqual([]);
    expect(validateTwap({ sizeStr: "1", slices: 10, intervalSecs: 60, slippageBps: 50 }, R).ok).toBe(true);
    expect(validateTwap({ sizeStr: "0.0002", slices: 10, intervalSecs: 60, slippageBps: 50 }, R).errors.join()).toMatch(/slice/);
    expect(validateTwap({ sizeStr: "1", slices: 1, intervalSecs: 60, slippageBps: 5000 }, R).errors.length).toBe(2);
  });
});

describe("risk", () => {
  it("uPnL and entry", () => {
    const pos = { size: 100_000_000n, basis: 100_000_000n * 50_000_000_000n / 1n }; // size*price for 1 BTC @ 50k
    expect(entryPrice(pos)).toBe(50_000_000_000n);
    expect(unrealizedPnl(pos, 51_000_000_000n)).toBe(1_000_000_000n);
    const short = { size: -100_000_000n, basis: -100_000_000n * 50_000_000_000n };
    expect(unrealizedPnl(short, 49_000_000_000n)).toBe(1_000_000_000n);
    expect(unrealizedPnl({ size: -1n, basis: -1n }, 0n)).toBe(0n); // (0 - -1)/1e8 floors to 0
    expect(unrealizedPnl({ size: 1n, basis: 1n }, 0n)).toBe(-1n); // floors against the user
  });
  it("liq price for the SPEC worked example (1 BTC long, 6,000 collateral, 5% MM)", () => {
    // equity 6000 at mark 50k, mm = 2500 (5%). Liq when 6000 + (p-50000) = 0.05 p  => p = 44000/0.95 = 46315.789...
    const p = estimateLiqPrice({ size: 100_000_000n, mark: 50_000_000_000n, equity: 6_000_000_000n, mm: 2_500_000_000n, mmrBps: 500n })!;
    expect(Number(p) / 1e6).toBeCloseTo(46315.789, 2);
  });
  it("liq price for a short is above mark; flat has none; no-solution is null", () => {
    const p = estimateLiqPrice({ size: -100_000_000n, mark: 50_000_000_000n, equity: 6_000_000_000n, mm: 2_500_000_000n, mmrBps: 500n })!;
    expect(Number(p) / 1e6).toBeCloseTo(56000 / 1.05, 2); // 6000 - (p-50000) = .05p => p = 56000/1.05
    expect(estimateLiqPrice({ size: 0n, mark: 1n, equity: 1n, mm: 0n, mmrBps: 500n })).toBeNull();
    // equity huge relative to size: long would need negative price
    expect(estimateLiqPrice({ size: 1_000_000n, mark: 50_000_000_000n, equity: 10_000_000_000_000n, mm: 25_000_000n, mmrBps: 500n })).toBeNull();
  });
  it("tier pick and health", () => {
    const tiers = [{ upToNotional: 100n, mmrBps: 500 }, { upToNotional: 1000n, mmrBps: 1000 }];
    expect(mmrBpsFor(50n, tiers)).toBe(500n);
    expect(mmrBpsFor(500n, tiers)).toBe(1000n);
    expect(mmrBpsFor(5000n, tiers)).toBe(1000n);
    expect(healthFraction(100n, 0n)).toBe(1);
    expect(healthFraction(100n, 50n)).toBe(0.5);
    expect(healthFraction(-5n, 1n)).toBe(0);
  });
});

describe("beginner-friendly validation messages", () => {
  const R2 = { ...R, unit: "BTC" };
  const b = { type: "limit" as const, isBuy: true, priceStr: "50000", sizeStr: "0.0010", tif: "GTC" as const, reduceOnly: false, slippageBps: 50, refPrice: 50_000_000_000n, position: 0n };
  it("lot error names the lot, the unit and a concrete valid size", () => {
    const e = validateTicket({ ...b, sizeStr: "0.00105" }, R2).errors.join();
    expect(e).toMatch(/multiple of the lot \(0\.0001 BTC\); try 0\.001/);
  });
  it("tick error suggests the nearest valid price", () => {
    expect(validateTicket({ ...b, priceStr: "50000.07" }, R2).errors.join()).toMatch(/tick \(0\.10 USDC\); try 50000\.10/);
  });
  it("min-notional error says the value and how big the order must be", () => {
    const e = validateTicket({ ...b, sizeStr: "0.0001" }, R2).errors.join();
    expect(e).toMatch(/5\.00 USDC is below the minimum notional \(10\.00 USDC\); try at least 0\.0002 BTC/);
  });
  it("max-size error and reduce-only errors tell the user what to do", () => {
    expect(validateTicket({ ...b, sizeStr: "99999999" }, R2).errors.join()).toMatch(/max order size .* try/);
    expect(validateTicket({ ...b, reduceOnly: true, position: 100n }, R2).errors.join()).toMatch(/you are long, so choose Sell/);
    expect(validateTicket({ ...b, reduceOnly: true }, R2).errors.join()).toMatch(/Turn reduce-only off/);
  });
  it("a valid order has no messages", () => { expect(validateTicket(b, R2).errors).toEqual([]); });
});

import { healthState, leverageWarning } from "./risk";
describe("health states", () => {
  const u = (n: number) => BigInt(n) * 1_000_000n;
  it("maps equity / maintenance margin to Safe, Watch, At risk, Liquidatable", () => {
    expect(healthState(u(1000), 0n).key).toBe("safe");
    expect(healthState(u(1000), u(100)).key).toBe("safe");
    expect(healthState(u(250), u(100)).key).toBe("watch");
    expect(healthState(u(120), u(100)).key).toBe("risk");
    expect(healthState(u(100), u(100)).key).toBe("liquidatable");
    expect(healthState(-u(5), u(100)).key).toBe("liquidatable");
    for (const k of [healthState(u(1), u(1)), healthState(u(5), u(1))]) expect(k.explain.length).toBeGreaterThan(10);
  });
  it("warns on high leverage only", () => {
    expect(leverageWarning(1, 10)).toBeNull();
    expect(leverageWarning(4, 10)).toMatch(/4\.0x/);
    expect(leverageWarning(9, 10)).toMatch(/High leverage/);
  });
});

describe("sizeForLeverage", () => {
  const base = { equity: 1_000_000_000n, price: 100_000_000_000n, lot: 10_000n }; // 1000 USDC equity, price 100000
  it("sizes a flat account to leverage x equity", () => {
    // 3x of 1000 USDC = 3000 USDC notional at 100000 = 0.03 BTC
    expect(sizeForLeverage({ ...base, leverage: 3, isBuy: true, position: 0n })).toBe(3_000_000n);
    expect(sizeForLeverage({ ...base, leverage: 3, isBuy: false, position: 0n })).toBe(3_000_000n);
  });
  it("accounts for an existing position and returns null when already past the target", () => {
    expect(sizeForLeverage({ ...base, leverage: 3, isBuy: true, position: 1_000_000n })).toBe(2_000_000n);
    expect(sizeForLeverage({ ...base, leverage: 1, isBuy: true, position: 5_000_000n })).toBeNull();
  });
  it("is null without equity", () => { expect(sizeForLeverage({ ...base, equity: 0n, leverage: 2, isBuy: true, position: 0n })).toBeNull(); });
});

import { CANCEL_REASONS, cancelReasonText } from "./order";
describe("cancel reasons (WASH-1 PriceBand)", () => {
  it("has PriceBand at code 8 with a plain-language message for every form of the reason", () => {
    expect(CANCEL_REASONS[8]).toBe("PriceBand");
    const msg = "Order cancelled: its price was too far from the oracle price";
    expect(cancelReasonText(8)).toBe(msg);
    expect(cancelReasonText("PriceBand")).toBe(msg);
    expect(cancelReasonText("price_band")).toBe(msg);
    expect(cancelReasonText(0)).toBe("Order cancelled by you");
    expect(cancelReasonText(99)).toMatch(/reason 99/);
    expect(cancelReasonText(null)).toBe("");
  });
});

import { scaleLevels, triggerAbove, validateScale, validateTrigger } from "./order";
describe("advanced order types", () => {
  const r = { tick: 100_000n, lot: 10_000n, minNotional: 10_000_000n, maxOrderSize: 10n ** 10n, unit: "BTC" } as never;
  it("trigger direction: stop buy/tp sell fire upward, stop sell/tp buy fire downward", () => {
    expect(triggerAbove("stop", true)).toBe(true); expect(triggerAbove("stop", false)).toBe(false);
    expect(triggerAbove("tp", true)).toBe(false); expect(triggerAbove("tp", false)).toBe(true);
  });
  it("rejects a stop-sell trigger above the mark and accepts one below", () => {
    const base = { kind: "stop" as const, isBuy: false, exec: "market" as const, limitStr: "", sizeStr: "0.0004", mark: 65_000_000_000n, position: 0n, reduceOnly: false, slippageBps: 50 };
    expect(validateTrigger({ ...base, triggerStr: "66000" }, r).ok).toBe(false);
    const ok = validateTrigger({ ...base, triggerStr: "64000" }, r);
    expect(ok.ok).toBe(true); expect(ok.above).toBe(false); expect(ok.limit! < ok.trigger!).toBe(true);
  });
  it("stop-limit needs a limit price", () => {
    const v = validateTrigger({ kind: "stop", isBuy: true, exec: "limit", triggerStr: "66000", limitStr: "", sizeStr: "0.0004", mark: 65_000_000_000n, position: 0n, reduceOnly: false, slippageBps: 50 }, r);
    expect(v.ok).toBe(false); expect(v.errors.join()).toMatch(/limit price/i);
  });
  it("scale levels are even, on the tick grid, and sizes sum to the total", () => {
    const { prices, sizes } = scaleLevels({ from: 65_000_000_000n, to: 64_000_000_000n, total: 70_000n, n: 3, tick: 100_000n, lot: 10_000n });
    expect(prices).toEqual([65_000_000_000n, 64_500_000_000n, 64_000_000_000n]);
    expect(sizes.reduce((a, b) => a + b, 0n)).toBe(70_000n);
    expect(sizes.every((s) => s % 10_000n === 0n)).toBe(true);
  });
  it("scale validation catches too-small orders and identical prices", () => {
    const v = validateScale({ isBuy: true, fromStr: "65000", toStr: "64900", sizeStr: "0.0003", n: 3, reduceOnly: false, mark: 65_500_000_000n }, r);
    expect(v.ok).toBe(false);
    expect(validateScale({ isBuy: true, fromStr: "65000", toStr: "65000", sizeStr: "0.01", n: 3, reduceOnly: false, mark: 0n }, r).ok).toBe(false);
  });
});
