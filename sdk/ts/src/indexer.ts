/**
 * Indexer REST/WS client STUB.
 *
 * !! UNVERIFIED UNTIL THE INDEXER LANDS !!  The Rust indexer (services/indexer) was being built by another agent
 * while this client was written. The endpoint paths, query parameters, JSON shapes and WS protocol below are a
 * HAND-WRITTEN GUESS, not generated from an OpenAPI spec, and have NEVER been exercised against a real indexer.
 * Expect to adjust paths and field names. Large integers are assumed to arrive as decimal strings (JSON-safe).
 */
import type { Hex } from "viem";

/** Decimal-string encoded integer in raw on-chain units (price 1e6, size 1e8, usdc 1e6). */
export type RawInt = string;

export interface IndexerMarket {
  id: number;
  name: string; // "BTC-USD"
  tick: RawInt;
  lot: RawInt;
  markPrice: RawInt;
  indexPrice: RawInt;
  fundingRate: RawInt;
  openInterest: RawInt;
  state: number;
}
export interface IndexerBookLevel { price: RawInt; size: RawInt }
export interface IndexerBook { market: number; bids: IndexerBookLevel[]; asks: IndexerBookLevel[]; blockNumber: number }
export interface IndexerTrade {
  tradeId: string; market: number; price: RawInt; size: RawInt; takerIsBuy: boolean;
  maker: Hex; taker: Hex; blockNumber: number; txHash: Hex; timestamp: number;
}
export interface IndexerOrder {
  id: string; acct: Hex; market: number; isBuy: boolean; price: RawInt; size: RawInt; remaining: RawInt;
  status: "open" | "filled" | "canceled" | "expired"; cloid: string; blockNumber: number;
}
export interface IndexerPosition { market: number; size: RawInt; entryPrice: RawInt; unrealizedPnl: RawInt; isolated: boolean }
export interface IndexerAccount { acct: Hex; collateral: RawInt; equity: RawInt; positions: IndexerPosition[] }
export interface IndexerCandle { t: number; o: RawInt; h: RawInt; l: RawInt; c: RawInt; v: RawInt }

export type IndexerWsMessage =
  | { channel: "book"; market: number; data: IndexerBook }
  | { channel: "trades"; market: number; data: IndexerTrade[] }
  | { channel: "account"; acct: Hex; data: { orders?: IndexerOrder[]; fills?: IndexerTrade[]; account?: IndexerAccount } }
  | { channel: "error"; message: string };

export type IndexerSubscription =
  | { channel: "book"; market: number }
  | { channel: "trades"; market: number }
  | { channel: "account"; acct: Hex };

export class IndexerError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`indexer HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "IndexerError";
  }
}

export interface IndexerClientOptions {
  baseUrl: string; // e.g. http://localhost:8080
  fetch?: typeof fetch;
  /** WebSocket constructor (global WebSocket in node >= 22 / browsers). */
  WebSocketImpl?: typeof WebSocket;
}

/** UNVERIFIED until the indexer lands. */
export class IndexerClient {
  private f: typeof fetch;
  constructor(private o: IndexerClientOptions) {
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async get<T>(path: string, q?: Record<string, string | number | undefined>): Promise<T> {
    const u = new URL(`${this.o.baseUrl.replace(/\/$/, "")}/v1${path}`);
    for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const r = await this.f(u);
    const text = await r.text();
    if (!r.ok) throw new IndexerError(r.status, text);
    return JSON.parse(text) as T;
  }
  markets() { return this.get<IndexerMarket[]>("/markets"); }
  book(market: number, depth = 20) { return this.get<IndexerBook>(`/markets/${market}/book`, { depth }); }
  trades(market: number, limit = 100) { return this.get<IndexerTrade[]>(`/markets/${market}/trades`, { limit }); }
  candles(market: number, interval = "1m", limit = 200) { return this.get<IndexerCandle[]>(`/markets/${market}/candles`, { interval, limit }); }
  account(acct: Hex) { return this.get<IndexerAccount>(`/accounts/${acct}`); }
  orders(acct: Hex, status?: IndexerOrder["status"]) { return this.get<IndexerOrder[]>(`/accounts/${acct}/orders`, { status }); }
  fills(acct: Hex, limit = 100) { return this.get<IndexerTrade[]>(`/accounts/${acct}/fills`, { limit }); }

  /** Opens `${baseUrl}/v1/ws` and sends {op:"subscribe", ...sub}. Returns a closer. */
  subscribe(subs: IndexerSubscription[], onMessage: (m: IndexerWsMessage) => void, onError?: (e: unknown) => void): () => void {
    const WS = this.o.WebSocketImpl ?? (globalThis as any).WebSocket;
    if (!WS) throw new Error("no WebSocket implementation available; pass WebSocketImpl");
    const url = this.o.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/v1/ws";
    const ws = new WS(url);
    ws.onopen = () => subs.forEach((s) => ws.send(JSON.stringify({ op: "subscribe", ...s })));
    ws.onmessage = (ev: MessageEvent) => {
      try { onMessage(JSON.parse(String(ev.data))); } catch (e) { onError?.(e); }
    };
    ws.onerror = (e: unknown) => onError?.(e);
    return () => ws.close();
  }
}
