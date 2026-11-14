import { BookSync } from "./book-sync";
import { parseWs, type WsMsg } from "./indexer-parse";
import type { BookSide } from "./types";

/**
 * WebSocket client for the indexer feed (docs/ws-schemas.md). Responsibilities:
 *  - refcounted subscriptions that are re-sent after every reconnect
 *  - per-market BookSync (snapshot + delta, gap detection, resnapshot)
 *  - exponential backoff with jitter (250 ms .. 10 s)
 *  - forwards trade/order/fill/candle/resync frames to listeners (the UI uses them to refetch REST history; there is NO replay
 *    of missed frames, so after a reconnect/resync listeners are told to backfill from REST)
 * The WebSocket constructor and timers are injectable so the whole thing is unit-testable without a network.
 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsCtor = new (url: string) => WsLike;
export interface FeedOptions { WebSocketImpl?: WsCtor; setTimeoutImpl?: (fn: () => void, ms: number) => unknown; clearTimeoutImpl?: (h: unknown) => void; random?: () => number; maxDepth?: number }

export type FeedStatus = "idle" | "connecting" | "open" | "reconnecting";
export interface BookView { bids: BookSide; asks: BookSide; seq: number }
export type Sub =
  | { channel: "book"; market: number }
  | { channel: "trades"; market: number }
  | { channel: "candles"; market: number; interval: string }
  | { channel: "orders"; acct: string }
  | { channel: "fills"; acct: string };

const subKey = (s: Sub) => JSON.stringify(s);
export const backoffMs = (attempt: number, random: () => number = Math.random) => Math.min(10_000, 250 * 2 ** attempt) * (0.5 + random() * 0.5);

export class IndexerFeed {
  status: FeedStatus = "idle";
  /** how many times the socket (re)opened; the UI refetches REST history when this increases */
  opens = 0;
  lastClose: { code: number; reason?: string } | null = null;
  private ws: WsLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private wanted = new Map<string, { sub: Sub; refs: number }>();
  private books = new Map<number, BookSync>();
  private views = new Map<number, BookView | null>();
  private bookListeners = new Set<() => void>();
  private listeners = new Set<(m: WsMsg | { type: "open" }) => void>();
  private readonly o: Required<FeedOptions>;
  private closedByUser = false;
  private idleTimer: unknown = null;

  constructor(private url: string, opts: FeedOptions = {}) {
    this.o = {
      WebSocketImpl: opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket: WsCtor }).WebSocket,
      setTimeoutImpl: opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutImpl: opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      random: opts.random ?? Math.random, maxDepth: opts.maxDepth ?? 64,
    };
  }

  // ---- public API -----------------------------------------------------------------------------------------------
  subscribe(sub: Sub): () => void {
    if (this.idleTimer !== null) { this.o.clearTimeoutImpl(this.idleTimer); this.idleTimer = null; }
    const k = subKey(sub);
    const cur = this.wanted.get(k);
    if (cur) cur.refs++;
    else {
      this.wanted.set(k, { sub, refs: 1 });
      if (sub.channel === "book" && !this.books.has(sub.market)) { this.books.set(sub.market, new BookSync()); this.views.set(sub.market, null); }
      this.send({ op: "subscribe", ...sub });
    }
    this.connect();
    let done = false;
    return () => {
      if (done) return; done = true;
      const w = this.wanted.get(k);
      if (!w) return;
      if (--w.refs <= 0) {
        this.wanted.delete(k);
        this.send({ op: "unsubscribe", ...sub });
        if (sub.channel === "book") { this.books.delete(sub.market); this.views.delete(sub.market); this.emitBook(); }
      }
      // grace period: React strict-mode / route changes unsubscribe+resubscribe immediately; do not tear down a socket that is still connecting
      if (this.wanted.size === 0 && this.idleTimer === null) this.idleTimer = this.o.setTimeoutImpl(() => { this.idleTimer = null; if (this.wanted.size === 0) this.shutdown(); }, 1000);
    };
  }
  /** Latest consistent book for a market, or null while not synced (never a half-built book). */
  book(market: number): BookView | null { return this.views.get(market) ?? null; }
  onBook(fn: () => void): () => void { this.bookListeners.add(fn); return () => this.bookListeners.delete(fn); }
  onMessage(fn: (m: WsMsg | { type: "open" }) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  bookState(market: number) { return this.books.get(market); }

  // ---- connection -----------------------------------------------------------------------------------------------
  private connect() {
    if (this.ws || this.timer !== null) return;
    this.closedByUser = false;
    this.status = this.attempt === 0 ? "connecting" : "reconnecting";
    let ws: WsLike;
    try { ws = new this.o.WebSocketImpl(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.status = "open"; this.attempt = 0; this.opens++;
      // fresh connection: the server sends a new snapshot per subscribed book, so any local state is stale
      for (const b of this.books.values()) b.reset();
      for (const m of this.books.keys()) this.views.set(m, null);
      for (const { sub } of this.wanted.values()) this.send({ op: "subscribe", ...sub }, true);
      this.emitBook();
      for (const l of this.listeners) l({ type: "open" });
    };
    ws.onmessage = (ev) => this.handle(typeof ev.data === "string" ? ev.data : String(ev.data));
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      this.ws = null;
      this.lastClose = { code: ev.code, reason: ev.reason };
      for (const b of this.books.values()) b.reset();
      for (const m of this.books.keys()) this.views.set(m, null);
      this.emitBook();
      if (!this.closedByUser && this.wanted.size > 0) this.scheduleReconnect(); // 4008 = slow consumer: same path, backoff gives us room
      else this.status = "idle";
    };
  }
  private scheduleReconnect() {
    this.status = "reconnecting";
    const delay = backoffMs(this.attempt++, this.o.random);
    this.timer = this.o.setTimeoutImpl(() => { this.timer = null; this.connect(); }, delay);
  }
  private shutdown() {
    this.closedByUser = true;
    if (this.timer !== null) { this.o.clearTimeoutImpl(this.timer); this.timer = null; }
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onopen = null; try { ws.close(1000); } catch { /* ignore */ } }
    this.status = "idle"; this.attempt = 0;
  }
  private send(msg: unknown, force = false) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return; // not open yet: onopen re-sends every wanted subscription
    if (!force && this.status !== "open") return;
    ws.send(JSON.stringify(msg));
  }

  // ---- frames ---------------------------------------------------------------------------------------------------
  private handle(raw: string) {
    let m: WsMsg | null;
    try { m = parseWs(raw); } catch { return; } // recognised frame with a malformed body: drop it (a later seq gap triggers a resnapshot)
    if (!m) return;
    switch (m.type) {
      case "snapshot": {
        const b = this.books.get(m.market);
        if (!b) return;
        if (b.onSnapshot(m.seq, m.bids, m.asks)) this.resnapshot(m.market);
        this.publish(m.market);
        return;
      }
      case "delta": {
        const b = this.books.get(m.market);
        if (!b) return;
        if (b.onDelta(m)) this.resnapshot(m.market);
        this.publish(m.market);
        return;
      }
      case "resync":
        for (const [mk, b] of this.books) { b.onResync(); this.views.set(mk, null); this.resnapshot(mk); }
        this.emitBook();
        break;
      default: break;
    }
    for (const l of this.listeners) l(m);
  }
  private resnapshot(market: number) { this.send({ op: "resnapshot", channel: "book", market }); }
  private publish(market: number) {
    const b = this.books.get(market);
    this.views.set(market, b ? b.view(this.o.maxDepth) : null);
    this.emitBook();
  }
  private emitBook() { for (const l of this.bookListeners) l(); }
}
