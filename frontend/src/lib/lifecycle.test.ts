import { describe, expect, it } from "vitest";
import { lifecycle, summarizeOrder, type ChainEvent } from "./lifecycle";

const sz = (n: number) => BigInt(Math.round(n * 1e8));
const A = "0xabc", B = "0xdef";
const acc = (size: number): ChainEvent => ({ name: "OrderAccepted", args: { id: 7n, acct: A, size: sz(size) } });
const fill = (size: number, taker = A): ChainEvent => ({ name: "Fill", args: { taker, maker: B, size: sz(size) } });

describe("order outcome from chain events", () => {
  it("counts only the user's own fills", () => {
    const o = summarizeOrder([acc(0.2), fill(0.08), { name: "Fill", args: { taker: B, maker: "0x999", size: sz(5) } }], A);
    expect(o.size).toBe(sz(0.2)); expect(o.filled).toBe(sz(0.08));
  });
  it("tracks rested and canceled remainders", () => {
    const o = summarizeOrder([acc(0.2), fill(0.08), { name: "OrderRested", args: { id: 7n, remaining: sz(0.12) } }], A);
    expect(o.rested).toBe(sz(0.12));
    const t = summarizeOrder([acc(0.2), { name: "OrderTruncated", args: { id: 7n, remaining: sz(0.2) } }], A);
    expect(t.canceled).toBe(sz(0.2));
  });
});

describe("order lifecycle phrases", () => {
  const place = (state: Parameters<typeof lifecycle>[0]["state"], events: ChainEvent[] = []) => lifecycle({ kind: "place", state, outcome: summarizeOrder(events, A), unit: "BTC", block: 12n });
  it("before the receipt an order is never open or filled", () => {
    expect(place("signing").headline).toBe("Approve this order in your wallet");
    for (const s of ["submitted", "included"] as const) { const p = place(s); expect(p.headline).toBe("Order submitted"); expect(p.final).toBe(false); expect(p.status).toBe("submitted"); }
  });
  it("a resting limit order is 'open', not filled", () => {
    const p = place("executed", [acc(0.2), { name: "OrderRested", args: { id: 7n, remaining: sz(0.2) } }]);
    expect(p.status).toBe("open"); expect(p.headline).toBe("Limit order open");
  });
  it("partial fill states the quantities", () => {
    const p = place("executed", [acc(0.2), fill(0.08), { name: "OrderRested", args: { id: 7n, remaining: sz(0.12) } }]);
    expect(p.status).toBe("partial"); expect(p.headline).toBe("0.08 / 0.2 BTC filled");
  });
  it("full fill", () => {
    const p = place("executed", [acc(0.2), fill(0.2)]);
    expect(p.status).toBe("filled"); expect(p.headline).toBe("Order filled"); expect(p.detail).toMatch(/Fills/);
  });
  it("IOC remainder is reported as canceled", () => {
    const p = place("executed", [acc(0.2), fill(0.05), { name: "OrderTruncated", args: { id: 7n, remaining: sz(0.15) } }]);
    expect(p.status).toBe("remainder-canceled"); expect(p.detail).toBe("Remaining quantity canceled.");
    expect(place("executed", [acc(0.2), { name: "OrderTruncated", args: { id: 7n, remaining: sz(0.2) } }]).status).toBe("not-filled");
  });
  it("reverted and failed are different and never imply a position", () => {
    expect(place("reverted").status).toBe("rejected"); expect(place("failed").status).toBe("not-sent");
    expect(place("failed").tx).toMatch(/not sent/);
  });
  it("transaction status is kept separate from order status", () => {
    const p = place("executed", [acc(0.2), { name: "OrderRested", args: { id: 7n, remaining: sz(0.2) } }]);
    expect(p.tx).toBe("Transaction: confirmed in block 12");
  });
  it("cancellation flow", () => {
    const c = (state: Parameters<typeof lifecycle>[0]["state"], events: ChainEvent[] = []) => lifecycle({ kind: "cancel", state, outcome: summarizeOrder(events, A), unit: "BTC" });
    expect(c("submitted").headline).toBe("Cancellation submitted"); expect(c("submitted").final).toBe(false);
    expect(c("executed", [{ name: "OrderCanceled", args: { id: 7n, reason: 0, remaining: sz(0.1) } }]).headline).toBe("Remaining quantity canceled");
    expect(c("executed").status).toBe("nothing-to-cancel");
  });
});

describe("PriceBand cancels of OTHER orders inside my transaction", () => {
  it("are not counted as my order being canceled, but my own are", async () => {
    const { summarizeOrder } = await import("./lifecycle");
    const mine = "0xabc";
    const ev = (id: bigint) => ({ name: "OrderCanceled", args: { id, reason: 8, remaining: 5n } });
    const accepted = { name: "OrderAccepted", args: { id: 7n, acct: mine, size: 100n } };
    expect(summarizeOrder([accepted, ev(3n)], mine).canceled).toBe(0n);
    expect(summarizeOrder([accepted, ev(7n)], mine)).toMatchObject({ canceled: 5n, cancelReason: 8 });
  });
});
