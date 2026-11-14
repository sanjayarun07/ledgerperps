import { describe, expect, it } from "vitest";
import { allowedActions, canPlace, STATE_NAMES } from "./marketRules";

describe("market state -> allowed actions (mirrors the contract rules)", () => {
  it("normal market allows everything", () => {
    const a = allowedActions({ state: 0, oracleOk: true });
    expect(a).toMatchObject({ open: true, reduce: true, cancel: true, addCollateral: true, withdrawWithPosition: true, notice: null, tone: "ok" });
  });
  it("reduce-only and recovery accept only shrinking orders", () => {
    for (const s of [1, 4]) {
      const a = allowedActions({ state: s, oracleOk: true });
      expect(a.open).toBe(false); expect(a.reduce).toBe(true);
      expect(canPlace(a, true).ok).toBe(true); expect(canPlace(a, false).ok).toBe(false);
    }
  });
  it("degraded oracle, paused and delisted block ALL placing (even closes) but never cancel or add collateral", () => {
    for (const s of [2, 3, 5]) {
      const a = allowedActions({ state: s, oracleOk: true });
      expect(a.open).toBe(false); expect(a.reduce).toBe(false); expect(a.cancel).toBe(true); expect(a.addCollateral).toBe(true);
      expect(canPlace(a, true).ok).toBe(false);
    }
  });
  it("withdrawing with a position is blocked only in paused / degraded markets", () => {
    expect(allowedActions({ state: "Paused" }).withdrawWithPosition).toBe(false);
    expect(allowedActions({ state: "OracleDegraded" }).withdrawWithPosition).toBe(false);
    expect(allowedActions({ state: "ReduceOnly" }).withdrawWithPosition).toBe(true);
    expect(allowedActions({ state: "Delisted" }).withdrawWithPosition).toBe(true);
  });
  it("only a delisted market offers settlement", () => {
    expect(STATE_NAMES.filter((s) => allowedActions({ state: s }).settleDelisted)).toEqual(["Delisted"]);
  });
  it("a stale price feed blocks placing in a Normal market and says what the consequence is", () => {
    const a = allowedActions({ state: 0, oracleOk: false, name: "BTC-USD" });
    expect(a.open).toBe(false); expect(a.reduce).toBe(false); expect(a.withdrawWithPosition).toBe(false);
    expect(a.notice).toMatch(/Price feed delayed/); expect(a.notice).toMatch(/BTC-USD/);
  });
  it("a delisted market keeps its frozen price: stale oracle does not matter", () => {
    expect(allowedActions({ state: 5, oracleOk: false }).settleDelisted).toBe(true);
  });
  it("global pause blocks placing everywhere but still allows cancel and collateral", () => {
    const a = allowedActions({ state: 0, oracleOk: true, globalPaused: true });
    expect(a).toMatchObject({ open: false, reduce: false, cancel: true, addCollateral: true, tone: "bad" });
  });
  it("every non-normal state carries a notice", () => {
    for (const s of [1, 2, 3, 4, 5]) expect(allowedActions({ state: s }).notice).toBeTruthy();
  });
});
