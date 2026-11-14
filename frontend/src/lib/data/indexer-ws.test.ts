import { describe, expect, it } from "vitest";
import { backoffMs, IndexerFeed, type WsLike } from "./indexer-ws";

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0; sent: Record<string, unknown>[] = [];
  onopen: WsLike["onopen"] = null; onmessage: WsLike["onmessage"] = null; onclose: WsLike["onclose"] = null; onerror: WsLike["onerror"] = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
const setup = () => {
  FakeWs.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const feed = new IndexerFeed("ws://x/v1/ws", { WebSocketImpl: FakeWs as never, setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl: () => {}, random: () => 1 });
  return { feed, timers, ws: () => FakeWs.all[FakeWs.all.length - 1] };
};
const snap = (seq: number) => ({ type: "snapshot", channel: "book", market: 0, seq, bids: [["100", "5"]], asks: [["101", "3"]] });
const delta = (seq: number, size = "4") => ({ type: "delta", channel: "book", market: 0, seq, side: "bid", price: "100", size });

describe("IndexerFeed", () => {
  it("subscribes after open, builds the book from snapshot+delta, and requests a resnapshot on a gap", () => {
    const { feed, ws } = setup();
    feed.subscribe({ channel: "book", market: 0 });
    ws().open();
    expect(ws().sent).toEqual([{ op: "subscribe", channel: "book", market: 0 }]);
    expect(feed.book(0)).toBeNull();
    ws().recv(snap(10));
    ws().recv(delta(11, "9"));
    expect(feed.book(0)!.bids.sz).toEqual([9n]);
    ws().recv(delta(13)); // gap
    expect(feed.book(0)).toBeNull();
    expect(ws().sent.at(-1)).toEqual({ op: "resnapshot", channel: "book", market: 0 });
    ws().recv(snap(13));
    expect(feed.book(0)!.seq).toBe(13);
  });

  it("reconnects with exponential backoff, re-subscribes, and never shows a stale book while down", () => {
    const { feed, timers, ws } = setup();
    feed.subscribe({ channel: "book", market: 0 });
    feed.subscribe({ channel: "trades", market: 0 });
    ws().open(); ws().recv(snap(5));
    expect(feed.book(0)).not.toBeNull();
    ws().drop(4008); // slow consumer
    expect(feed.book(0)).toBeNull();
    expect(feed.status).toBe("reconnecting");
    expect(timers[0].ms).toBe(250); // random()=1 -> factor 1.0
    timers[0].fn();
    const second = ws();
    expect(FakeWs.all).toHaveLength(2);
    second.drop(1006); // fails to even open
    expect(timers[1].ms).toBe(500);
    timers[1].fn();
    ws().open();
    expect(ws().sent).toEqual([{ op: "subscribe", channel: "book", market: 0 }, { op: "subscribe", channel: "trades", market: 0 }]);
    expect(feed.opens).toBe(2); // first open + the reconnect
    expect(feed.lastClose?.code).toBe(1006);
  });

  it("clears the book on a reorg resync and asks for a fresh snapshot", () => {
    const { feed, ws } = setup();
    feed.subscribe({ channel: "book", market: 0 });
    ws().open(); ws().recv(snap(50));
    ws().recv({ type: "resync", reason: "reorg", fork_block: 7 });
    expect(feed.book(0)).toBeNull();
    expect(ws().sent.at(-1)).toEqual({ op: "resnapshot", channel: "book", market: 0 });
    ws().recv(snap(9)); // seq went backwards: fine
    expect(feed.book(0)!.seq).toBe(9);
  });

  it("forwards trade frames to listeners and ignores unknown or malformed frames", () => {
    const { feed, ws } = setup();
    const seen: string[] = [];
    feed.onMessage((m) => seen.push(m.type));
    feed.subscribe({ channel: "trades", market: 0 });
    ws().open();
    ws().recv({ type: "something_new" });
    ws().onmessage?.({ data: "not json" });
    ws().recv({ type: "snapshot", channel: "book", market: 0, seq: "x" }); // recognised but malformed
    ws().recv({ type: "resync", reason: "reorg", fork_block: 1 });
    expect(seen).toEqual(["open", "resync"]);
  });

  it("refcounts subscriptions and closes the socket when the last one goes", () => {
    const { feed, ws, timers } = setup();
    const a = feed.subscribe({ channel: "book", market: 0 });
    const b = feed.subscribe({ channel: "book", market: 0 });
    ws().open();
    a();
    expect(ws().sent.filter((m) => m.op === "unsubscribe")).toHaveLength(0);
    b();
    expect(ws().sent.at(-1)).toEqual({ op: "unsubscribe", channel: "book", market: 0 });
    expect(feed.status).toBe("open"); // grace period before closing
    timers[timers.length - 1].fn();
    expect(feed.status).toBe("idle");
  });

  it("an immediate unsubscribe+resubscribe (React strict mode) keeps the same socket", () => {
    const { feed, timers } = setup();
    const off = feed.subscribe({ channel: "book", market: 0 });
    off();
    feed.subscribe({ channel: "book", market: 0 });
    timers[0]?.fn(); // the (stale) idle timer fires: wanted is non-empty so nothing closes
    expect(FakeWs.all).toHaveLength(1);
    expect(feed.status).toBe("connecting");
  });

  it("backoff caps at 10s and jitters in [0.5, 1]", () => {
    expect(backoffMs(0, () => 1)).toBe(250);
    expect(backoffMs(20, () => 1)).toBe(10_000);
    expect(backoffMs(20, () => 0)).toBe(5_000);
  });
});
