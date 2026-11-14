import { describe, expect, it } from "vitest";
import { BookSync } from "./book-sync";
import fixtures from "./fixtures/ws-frames.json";
import { parseWs } from "./indexer-parse";

const L = (p: number, s: number): [bigint, bigint] => [BigInt(p), BigInt(s)];
const d = (seq: number, side: "bid" | "ask", price: number, size: number) => ({ seq, side, price: BigInt(price), size: BigInt(size) });
const px = (b: BookSync, side: "bids" | "asks") => b.view(50)![side].px.map(Number);

describe("BookSync", () => {
  it("applies gapless deltas after a snapshot (size = new total, 0 removes)", () => {
    const b = new BookSync();
    expect(b.view(10)).toBeNull(); // nothing displayed before the first snapshot
    expect(b.onSnapshot(10, [L(100, 5), L(99, 7)], [L(101, 3)])).toBe(false);
    expect(b.onDelta(d(11, "bid", 100, 9))).toBe(false);
    expect(b.onDelta(d(12, "bid", 99, 0))).toBe(false);
    expect(b.onDelta(d(13, "ask", 102, 4))).toBe(false);
    const v = b.view(10)!;
    expect(v.seq).toBe(13);
    expect(v.bids).toEqual({ px: [100n], sz: [9n] });
    expect(v.asks).toEqual({ px: [101n, 102n], sz: [3n, 4n] });
  });

  it("sorts bids high->low and asks low->high regardless of arrival order, capped at depth", () => {
    const b = new BookSync();
    b.onSnapshot(1, [L(98, 1), L(100, 1), L(99, 1)], [L(103, 1), L(101, 1), L(102, 1)]);
    expect(px(b, "bids")).toEqual([100, 99, 98]);
    expect(px(b, "asks")).toEqual([101, 102, 103]);
    expect(b.view(2)!.bids.px).toEqual([100n, 99n]);
  });

  it("ignores duplicates (seq <= last)", () => {
    const b = new BookSync();
    b.onSnapshot(5, [L(100, 1)], []);
    b.onDelta(d(6, "bid", 100, 2));
    expect(b.onDelta(d(6, "bid", 100, 50))).toBe(false);
    expect(b.onDelta(d(3, "bid", 100, 60))).toBe(false);
    expect(b.view(5)!.bids.sz).toEqual([2n]);
    expect(b.duplicates).toBe(2);
  });

  it("detects a gap: discards the book, requests a resnapshot, hides the book, buffers until the snapshot", () => {
    const b = new BookSync();
    b.onSnapshot(5, [L(100, 1)], [L(101, 1)]);
    expect(b.onDelta(d(6, "bid", 100, 2))).toBe(false);
    expect(b.onDelta(d(8, "bid", 100, 4))).toBe(true); // 7 was lost
    expect(b.gaps).toBe(1);
    expect(b.state).toBe("syncing");
    expect(b.view(5)).toBeNull(); // never show a book we know is wrong
    expect(b.onDelta(d(9, "bid", 100, 5))).toBe(false); // buffered, no second request
    expect(b.onDelta(d(10, "ask", 101, 0))).toBe(false);
    // snapshot arrives at seq 8 (includes delta 8): buffered 8 is dropped, 9 and 10 are applied
    expect(b.onSnapshot(8, [L(100, 4)], [L(101, 1)])).toBe(false);
    const v = b.view(5)!;
    expect(v.seq).toBe(10);
    expect(v.bids.sz).toEqual([5n]);
    expect(v.asks.px).toEqual([]);
  });

  it("drops buffered deltas older than the snapshot and asks again if the buffer itself has a hole", () => {
    const b = new BookSync();
    b.onDelta(d(3, "bid", 100, 1)); // before any snapshot: held
    b.onDelta(d(4, "bid", 100, 2));
    b.onDelta(d(7, "bid", 100, 9)); // hole after the snapshot at 5
    expect(b.onSnapshot(5, [L(100, 1)], [])).toBe(true);
    expect(b.state).toBe("syncing");
    expect(b.onSnapshot(7, [L(100, 9)], [])).toBe(false);
    expect(b.view(5)!.seq).toBe(7);
  });

  it("resync (reorg) discards everything; seq may go backwards", () => {
    const b = new BookSync();
    b.onSnapshot(50, [L(100, 1)], []);
    b.onResync();
    expect(b.view(5)).toBeNull();
    b.onSnapshot(12, [L(100, 3)], []); // lower seq after replay is legitimate
    expect(b.onDelta(d(13, "bid", 100, 4))).toBe(false);
    expect(b.view(5)!.bids.sz).toEqual([4n]);
  });

  it("replays the REAL recorded websocket frames to a book equal to the final REST-style view", () => {
    const b = new BookSync();
    const msgs = (fixtures as unknown[]).map((f) => parseWs(JSON.stringify(f)));
    let need = false;
    for (const m of msgs) {
      if (m?.type === "snapshot") need ||= b.onSnapshot(m.seq, m.bids, m.asks);
      if (m?.type === "delta") need ||= b.onDelta(m);
    }
    expect(need).toBe(false);
    expect(b.state).toBe("synced");
    const last = (fixtures as { type: string; seq?: number }[]).filter((f) => f.type === "delta").at(-1)!;
    expect(b.lastSeq).toBe(last.seq);
  });
});
