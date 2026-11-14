import { describe, expect, it } from "vitest";
import { closeEstimate, impactBps, ticketAmounts, walkBook } from "./ticketMath";

const px = (n: number) => BigInt(Math.round(n * 1e6)), sz = (n: number) => BigInt(Math.round(n * 1e8)), usd = (n: number) => BigInt(Math.round(n * 1e6));

describe("ticket maths keeps position notional and collateral separate", () => {
  it("10x: 10,000 notional commits 1,000 collateral", () => {
    const a = ticketAmounts({ orderNotional: usd(10_000), incNotional: usd(10_000), imrBps: 1000n, fee: usd(5), available: usd(5_000) });
    expect(a.positionNotional).toBe(usd(10_000)); expect(a.collateral).toBe(usd(1_000)); expect(a.availableAfter).toBe(usd(3_995));
  });
  it("an order that only reduces a position commits no new collateral", () => {
    const a = ticketAmounts({ orderNotional: usd(2_000), incNotional: 0n, imrBps: 1000n, fee: usd(1), available: usd(100) });
    expect(a.positionNotional).toBe(usd(2_000)); expect(a.collateral).toBe(0n); expect(a.availableAfter).toBe(usd(99));
  });
  it("collateral rounds up so the estimate is never lower than the contract's requirement", () => {
    expect(ticketAmounts({ orderNotional: 1n, incNotional: 1n, imrBps: 1000n, fee: 0n, available: 10n }).collateral).toBe(1n);
  });
  it("available after the order can go negative (shown as a problem, not hidden)", () => {
    expect(ticketAmounts({ orderNotional: usd(100), incNotional: usd(100), imrBps: 1000n, fee: usd(1), available: usd(5) }).availableAfter).toBe(usd(-6));
  });
});

describe("book walk and price impact", () => {
  const asks = [{ p: px(100), s: sz(1) }, { p: px(101), s: sz(1) }, { p: px(103), s: sz(2) }];
  it("fills across levels at a weighted average", () => {
    const w = walkBook(asks, sz(2));
    expect(w.filled).toBe(sz(2)); expect(w.avg).toBe(px(100.5)); expect(w.worst).toBe(px(101));
  });
  it("reports a partial fill when depth runs out", () => {
    const w = walkBook(asks, sz(10));
    expect(w.filled).toBe(sz(4)); expect(w.worst).toBe(px(103));
  });
  it("empty book gives no average", () => { expect(walkBook([], sz(1)).avg).toBeNull(); });
  it("impact is positive when a buyer pays above the reference, negative if better", () => {
    expect(impactBps(px(100.5), px(100), true)).toBe(50);
    expect(impactBps(px(99.5), px(100), true)).toBe(-50);
    expect(impactBps(px(99.5), px(100), false)).toBe(50);
    expect(impactBps(null, px(100), true)).toBeNull();
  });
});

describe("close estimate", () => {
  it("long closed above entry realises a profit, net of fee, plus released margin", () => {
    const e = closeEstimate({ positionSize: sz(1), entry: px(100), avgExit: px(110), closeSize: sz(1), feeBps: 10n, marginReleased: usd(10) });
    expect(e.pnl).toBe(usd(10)); expect(e.fee).toBe(usd(0.11)); expect(e.proceeds).toBe(usd(10) + usd(10) - usd(0.11));
  });
  it("short closed above entry realises a loss", () => {
    const e = closeEstimate({ positionSize: -sz(1), entry: px(100), avgExit: px(110), closeSize: sz(0.5), feeBps: 0n, marginReleased: usd(5) });
    expect(e.pnl).toBe(usd(-5));
  });
});
