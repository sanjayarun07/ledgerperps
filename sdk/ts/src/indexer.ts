/**
 * Indexer REST/WS client, matched to the live Rust indexer (services/indexer) on 2026-11-16.
 *
 * Verified against a running indexer: the response shapes of /markets, /markets/{id}, /markets/{id}/book, /trades, /candles,
 * /accounts/{acct}/orders, /accounts/{acct}/fills, /accounts/{owner}/positions and /status, and the WebSocket
 * subscribe format ({op:"subscribe", channel, market|acct}). Message shapes for the WS "orders" channel and some
 * optional query parameters are read from the server source, not exercised here.
 *
 * The indexer is derived from chain events and is NOT authoritative for balances or margin: verify on-chain
 * (PerpClient reads) before acting on money. Large integers arrive as decimal strings in raw on-chain units
 * (price 1e6, size 1e8, USDC 1e6). Account routes that take `acct` use the hashed key from `acctKey(owner, sub)`.
 */
import type { Address, Hex } from "viem";

/** Decimal-string encoded integer in raw on-chain units. */
export type RawInt = string;

export interface IndexerMarket {
  id: number;
  name: string; // "BTC-USD"
  config: { tick: number | RawInt; lot: number | RawInt; min_notional: number | RawInt; max_order_size: RawInt; max_oi: RawInt; funding_interval: number; name: string };
  funding_index: RawInt;
  funding_rate: RawInt;
  last_price: RawInt | null;
  open_interest: RawInt;
  state: number;
  state_name: string;
  stats_24h?: { high: RawInt; low: RawInt; open: RawInt; volume_base: RawInt; volume_quote: RawInt };
  trade_count?: number;
}
/** [price, size] pairs. Bids high to low, asks low to high. */
export type IndexerBookLevel = [RawInt, RawInt];
export interface IndexerBook { market: number; seq: number; bids: IndexerBookLevel[]; asks: IndexerBookLevel[] }
export interface IndexerTrade {
  trade_id: string; market: number; price: RawInt; size: RawInt; notional: RawInt; taker_side: "buy" | "sell";
  maker: Hex; taker: Hex; maker_order_id: number; taker_order_id: number; maker_fee: RawInt; taker_fee: RawInt;
  block: number; log_index: number; tx_hash: Hex; ts: number;
}
/** A trade as seen by one account (adds which side that account was on). */
export interface IndexerFill extends IndexerTrade { role?: "maker" | "taker" }
export interface IndexerOrder {
  id: number; acct: Hex; market: number; side: "buy" | "sell"; price: RawInt; size: RawInt; filled: RawInt; remaining: RawInt;
  avg_fill_price: RawInt | null; status: string; cancel_reason: string | null; cloid: string; tif: string; reduce_only: boolean;
  truncated: boolean; parent: number | null; tx_hash: Hex; created_block: number; created_ts: number; updated_block: number; updated_ts: number;
}
export interface IndexerPosition {
  acct: Hex; market: number; size: RawInt; entry_price: RawInt; basis: RawInt; fees_paid: RawInt; funding_paid: RawInt;
  realized_pnl: RawInt; realized_pnl_error_bound: RawInt; approximate: boolean; updated_block: number;
}
export interface IndexerCandle { t: number; o: RawInt; h: RawInt; l: RawInt; c: RawInt; v: RawInt; qv: RawInt; n: number }
export type CandleInterval = "1m" | "5m" | "1h";

/** A page of rows plus the cursor for the next page (null when there are no more). */
export interface Page<T> { data: T[]; next_cursor: string | null; indexed_block: number }

export type IndexerWsMessage =
  | { type: "subscribed"; channel: string; [k: string]: unknown }
  | { type: "snapshot"; channel: "book"; market: number; seq: number; bids: IndexerBookLevel[]; asks: IndexerBookLevel[] }
  | { type: "delta"; channel: "book"; market: number; seq: number; side: string; price: RawInt; size: RawInt }
  | { type: "trade"; channel: "trades"; market: number; data: unknown }
  | { type: "fill"; channel: "fills"; acct: Hex; role: "maker" | "taker"; data: unknown }
  | { type: "candle"; channel: "candles"; market: number; interval: CandleInterval; data: IndexerCandle }
  | { type: "order"; channel: "orders"; acct: Hex; data: unknown }
  | { type: "error"; code: string; message?: string };

export type IndexerSubscription =
  | { channel: "book"; market: number }
  | { channel: "trades"; market: number }
  | { channel: "candles"; market: number; interval?: CandleInterval }
  | { channel: "orders"; acct: Hex }
  | { channel: "fills"; acct: Hex };

export class IndexerError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`indexer HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "IndexerError";
  }
}

export interface IndexerClientOptions {
  baseUrl: string; // e.g. http://localhost:18700
  fetch?: typeof fetch;
  /** WebSocket constructor (global WebSocket in node >= 22 / browsers). */
  WebSocketImpl?: typeof WebSocket;
}

export class IndexerClient {
  private f: typeof fetch;
  constructor(private o: IndexerClientOptions) {
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async raw<T>(path: string, q?: Record<string, string | number | undefined>): Promise<T> {
    const u = new URL(`${this.o.baseUrl.replace(/\/$/, "")}/v1${path}`);
    for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const r = await this.f(u);
    const text = await r.text();
    if (!r.ok) throw new IndexerError(r.status, text);
    return JSON.parse(text) as T;
  }
  /** Every route wraps its payload as {data, indexed_block}. */
  private async get<T>(path: string, q?: Record<string, string | number | undefined>): Promise<T> {
    return (await this.raw<{ data: T }>(path, q)).data;
  }

  status() { return this.get<Record<string, unknown>>("/status"); }
  markets() { return this.get<IndexerMarket[]>("/markets"); }
  market(id: number) { return this.get<IndexerMarket>(`/markets/${id}`); }
  book(market: number, depth = 20) { return this.get<IndexerBook>(`/markets/${market}/book`, { depth }); }
  trades(market: number, limit = 100, cursor?: string) { return this.raw<Page<IndexerTrade>>(`/markets/${market}/trades`, { limit, cursor }); }
  /** interval must be 1m, 5m or 1h. */
  async candles(market: number, interval: CandleInterval = "1m", limit = 200): Promise<IndexerCandle[]> {
    return (await this.get<{ candles: IndexerCandle[] }>(`/markets/${market}/candles`, { interval, limit })).candles;
  }
  /** Positions of an owner. `sub` selects a subaccount (route takes the owner address, not the hashed key). */
  positions(owner: Address, sub?: number) { return this.get<IndexerPosition[]>(`/accounts/${owner}/positions`, { sub }); }
  /** `acct` is the hashed key: acctKey(owner, sub). `status` filters, for example "filled". */
  orders(acct: Hex, o: { status?: string; limit?: number; cursor?: string } = {}) { return this.raw<Page<IndexerOrder>>(`/accounts/${acct}/orders`, o); }
  fills(acct: Hex, o: { limit?: number; cursor?: string; market?: number } = {}) { return this.raw<Page<IndexerFill>>(`/accounts/${acct}/fills`, o); }

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
