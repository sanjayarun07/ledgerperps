import { describe, expect, it } from "vitest";
import { fromPrice, fromSize, fromUsdc, notionalFloor, OrderValidationError, assertValidOrder, roundPriceToTick, slippagePrice, toPrice, toSize, toUsdc, validateOrder } from "../src/index.js";

const mkt = { tick: 100_000n, lot: 10_000n, minNotional: 10_000_000n, maxOrderSize: 10n ** 12n };

describe("units", () => {
  it("converts decimals", () => {
    expect(toPrice("50000.1")).toBe(50_000_100_000n);
    expect(toPrice(0.5)).toBe(500_000n);
    expect(toSize("0.25")).toBe(25_000_000n);
    expect(toSize(1e-7)).toBe(10n);
    expect(toUsdc("100.5")).toBe(100_500_000n);
    expect(fromPrice(50_000_100_000n)).toBe("50000.1");
    expect(fromSize(1n)).toBe("0.00000001");
    expect(fromUsdc(1_000_000n)).toBe("1");
  });
  it("rounds to tick", () => {
    expect(roundPriceToTick(50_000_149_999n, 100_000n, "down")).toBe(50_000_100_000n);
    expect(roundPriceToTick(50_000_100_001n, 100_000n, "up")).toBe(50_000_200_000n);
    expect(roundPriceToTick(50_000_150_000n, 100_000n)).toBe(50_000_200_000n);
  });
  it("slippage price rounds in the safe direction", () => {
    // buy 50bps above 50000 = 50250 (exact multiple of tick 0.1)
    expect(slippagePrice(true, toPrice(50000), 50, 100_000n)).toBe(toPrice(50250));
    expect(slippagePrice(false, toPrice(50000), 50, 100_000n)).toBe(toPrice(49750));
    // non-multiples: buy rounds up, sell rounds down
    expect(slippagePrice(true, 50_000_123_457n, 0, 100_000n)).toBe(50_000_200_000n);
    expect(slippagePrice(false, 50_000_123_457n, 0, 100_000n)).toBe(50_000_100_000n);
    expect(() => slippagePrice(true, 0n, 10, 1n)).toThrow();
  });
  it("validates tick/lot/min-notional/max size", () => {
    expect(validateOrder(mkt, { market: 0, isBuy: true, price: toPrice(50000), size: toSize("0.01") })).toEqual([]);
    expect(validateOrder(mkt, { market: 0, isBuy: true, price: 50_000_050_000n, size: toSize("0.01") })[0]).toMatch(/tick/);
    expect(validateOrder(mkt, { market: 0, isBuy: true, price: toPrice(50000), size: 12_345n })[0]).toMatch(/lot/);
    expect(validateOrder(mkt, { market: 0, isBuy: true, price: toPrice(50000), size: toSize("0.0001") })[0]).toMatch(/minNotional/);
    // reduce-only skips min notional (contract clips)
    expect(validateOrder(mkt, { market: 0, isBuy: true, price: toPrice(50000), size: toSize("0.0001"), reduceOnly: true })).toEqual([]);
    expect(() => assertValidOrder(mkt, { market: 0, isBuy: true, price: 0n, size: 0n })).toThrow(OrderValidationError);
    expect(notionalFloor(toSize("1"), toPrice(50000))).toBe(50_000_000_000n);
  });
});

import { CancelReason, cancelReasonText, exchangeAbi } from "../src/index.js";
describe("ABI / enum drift guards (WASH-1, LIQ-2)", () => {
  it("CancelReason.PriceBand is 8 and has a plain-language message", () => {
    expect(CancelReason.PriceBand).toBe(8);
    expect(cancelReasonText(CancelReason.PriceBand)).toMatch(/too far from the oracle price/);
    expect(cancelReasonText(99)).toMatch(/99/);
  });
  it("ABI carries writeOff(bytes32,uint8) and BadDebtUnresolved", () => {
    const w = (exchangeAbi as readonly any[]).find((f) => f.type === "function" && f.name === "writeOff");
    expect(w?.inputs.map((i: any) => i.type)).toEqual(["bytes32", "uint8"]);
    expect((exchangeAbi as readonly any[]).some((f) => f.type === "event" && f.name === "BadDebtUnresolved")).toBe(true);
  });
});

describe("ABI carries the backstop phase-1 surface", () => {
  const abi = exchangeAbi as readonly any[];
  const fn = (n: string) => abi.find((f) => f.type === "function" && f.name === n);
  const ev = (n: string) => abi.find((f) => f.type === "event" && f.name === n);
  it("functions", () => {
    expect(fn("syncBackstop")?.inputs).toEqual([]);
    expect(fn("backstopEquity")?.outputs.map((o: any) => o.type)).toEqual(["int256"]);
    expect(fn("adlHealth")?.outputs.map((o: any) => o.type)).toEqual(["int256", "uint256"]);
    expect(fn("setAdlHardPremBps")?.inputs.map((o: any) => o.type)).toEqual(["uint32"]);
    expect(fn("setWithdrawGate")?.inputs.map((o: any) => o.type)).toEqual(["uint256"]);
    for (const n of ["adlHardPremBps", "bsInsDrawn", "bsDebt", "wdGateThreshold", "principal"]) expect(fn(n), n).toBeTruthy();
  });
  it("events and error", () => {
    for (const n of ["BackstopSynced", "AdlSkipped", "AdlHardPremSet", "WithdrawGateSet"]) expect(ev(n), n).toBeTruthy();
    expect(abi.some((f) => f.type === "error" && f.name === "WithdrawGated")).toBe(true);
  });
});
