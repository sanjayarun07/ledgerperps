import { describe, expect, it } from "vitest";
import { toPrice, toSize } from "@perps/sdk";
import { evaluateTake, type TakeInput } from "../src/backstop-taker.js";

const base = (o: Partial<TakeInput> = {}): TakeInput => ({
  auction: { active: true, takerSells: false, price: toPrice(49_900), discBps: 20n, size: toSize("2") },
  bestBid: toPrice(50_000),
  bestAsk: toPrice(50_010),
  feeBps: 5,
  minEdgeBps: 5,
  maxSize: toSize("1"),
  lot: toSize("0.0001"),
  ...o,
});

describe("evaluateTake", () => {
  it("buys a long backstop's inventory below the best bid, capped at maxSize, with a limit above the quote", () => {
    const d = evaluateTake(base());
    expect(d.take).toBe(true);
    expect(d.size).toBe(toSize("1"));
    expect(d.limitPx).toBeGreaterThan(toPrice(49_900));
    expect(d.edgeBps).toBe(15); // (50000-49900)/49900 = 20 bps, minus 5 bps fee
  });
  it("sells to a short backstop above the best ask", () => {
    const d = evaluateTake(base({ auction: { active: true, takerSells: true, price: toPrice(50_150), discBps: 20n, size: toSize("0.3") } }));
    expect(d.take).toBe(true);
    expect(d.size).toBe(toSize("0.3"));
    expect(d.limitPx).toBeLessThan(toPrice(50_150)); // the minimum price we accept when selling
  });
  it("skips an inactive auction, an empty exit side, a thin edge, and sub-lot sizes", () => {
    expect(evaluateTake(base({ auction: { active: false, takerSells: false, price: 0n, discBps: 0n, size: 0n } })).take).toBe(false);
    expect(evaluateTake(base({ bestBid: undefined })).reason).toMatch(/no book liquidity/);
    expect(evaluateTake(base({ auction: { active: true, takerSells: false, price: toPrice(49_990), discBps: 2n, size: toSize("1") } })).reason).toMatch(/edge/);
    expect(evaluateTake(base({ bestBid: toPrice(49_000) })).take).toBe(false); // the book pays less than the auction asks
    expect(evaluateTake(base({ maxSize: toSize("0.00001") })).reason).toMatch(/lot/);
  });
});
