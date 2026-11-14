import { publicClient as pc } from "../client";
import { EXCHANGE, exchangeAbi, INDEXER_URL } from "../config";
import { chainSource } from "./chain";
import { IndexerFeed } from "./indexer-ws";
import {
  envelope, parseApiError, parseBackstopEvents, parseBadDebt, parseBook, parseLiquidationRows, parseCandles, parseConditionals, parseFills, parseFundingSettlements, parseLiquidations, parseOrders,
  parsePositions, parseStatus, parseTransfers, parseTwaps, type Envelope,
} from "./indexer-parse";
import type { Book, Candle, DataSource, IndexerStatus, SolvencyInfo, Trade, Twap } from "./types";

/**
 * Indexer-backed data source against the DOCUMENTED /v1 REST + WS API (services/indexer/docs/openapi.yaml, ws-schemas.md).
 *
 * The indexer is DERIVED data, never authoritative. So:
 *  - live account state (collateral, margin, positions, resting orders, mark, market config, funding estimate) stays on the chain;
 *  - the indexer serves history (trades, candles, fills, funding settlements, transfers, order history, twaps, conditionals,
 *    bad-debt events) and the live book (REST snapshot, then WS snapshot + deltas with gap detection);
 *  - any failure (network, 4xx/5xx, 429, malformed payload) falls back to the chain source FOR THAT CALL and is recorded in
 *    `fallbackLog` so the UI can say so. Chain-only mode is exactly the pre-existing behaviour.
 */
export class IndexerError extends Error {
  constructor(message: string, public status: number, public code: string | null, public retryAfter: number | null) { super(message); }
}

const BASE = `${INDEXER_URL.replace(/\/+$/, "")}/v1`;
export const WS_URL = `${INDEXER_URL.replace(/\/+$/, "").replace(/^http/, "ws")}/v1/ws`;
const TIMEOUT_MS = 5000;

/** Diagnostics for the UI badge: the most recent fallback and its reason. */
export const fallbackLog: { at: number; what: string; why: string } | { at: 0; what: ""; why: "" } = { at: 0, what: "", why: "" };
const fallbackListeners = new Set<() => void>();
export const onFallback = (fn: () => void) => { fallbackListeners.add(fn); return () => fallbackListeners.delete(fn); };
function noteFallback(what: string, e: unknown) {
  Object.assign(fallbackLog, { at: Date.now(), what, why: e instanceof Error ? e.message : String(e) });
  for (const l of fallbackListeners) l();
}

export async function getJson(path: string, params: Record<string, string | number | boolean | undefined> = {}, fetchImpl: typeof fetch = fetch): Promise<Envelope> {
  const q = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${BASE}${path}${q ? `?${q}` : ""}`, { cache: "no-store", signal: ctl.signal });
    let body: unknown = null;
    try { body = await r.json(); } catch { /* non-JSON error body */ }
    if (!r.ok) {
      const e = parseApiError(body);
      const ra = Number(r.headers.get("retry-after"));
      throw new IndexerError(e ? `${e.code}: ${e.message}` : `HTTP ${r.status}`, r.status, e?.code ?? null, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    return envelope(body);
  } finally { clearTimeout(t); }
}

const get = (path: string, params?: Record<string, string | number | boolean | undefined>) => getJson(path, params);

async function orChain<T>(what: string, fromIndexer: () => Promise<T>, fromChain: () => Promise<T>): Promise<T> {
  try { return await fromIndexer(); }
  catch (e) { noteFallback(what, e); return fromChain(); }
}

// ---- WS singleton (browser only) -----------------------------------------------------------------------------------
let feed: IndexerFeed | null = null;
export function getFeed(): IndexerFeed | null {
  if (!INDEXER_URL || typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  return (feed ??= new IndexerFeed(WS_URL));
}

/** Interval -> indexer interval name (only 1m / 5m / 1h exist); other intervals are aggregated from a finer one. */
const NATIVE: Record<number, string> = { 60: "1m", 300: "5m", 3600: "1h" };
export function aggregateCandles(src: Candle[], target: number): Candle[] {
  const out: Candle[] = [];
  for (const c of [...src].sort((a, b) => a.time - b.time)) {
    const t = Math.floor(c.time / target) * target;
    const last = out[out.length - 1];
    if (last && last.time === t) { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume; }
    else out.push({ ...c, time: t });
  }
  return out;
}
export const baseIntervalFor = (target: number): number | null => [3600, 300, 60].find((b) => target % b === 0) ?? null;

export const indexerSource: DataSource = {
  ...chainSource,
  name: "indexer(+chain fallback)",

  getBook(m, depth) {
    return orChain<Book>("book", async () => {
      const live = getFeed()?.book(m);
      if (live) return { bids: { px: live.bids.px.slice(0, depth), sz: live.bids.sz.slice(0, depth) }, asks: { px: live.asks.px.slice(0, depth), sz: live.asks.sz.slice(0, depth) }, blockNumber: null, seq: live.seq, source: "indexer-ws" };
      const e = await get(`/markets/${m}/book`, { depth });
      const b = parseBook(e.data);
      const side = (l: [bigint, bigint][]) => ({ px: l.map((x) => x[0]), sz: l.map((x) => x[1]) });
      return { bids: side(b.bids), asks: side(b.asks), blockNumber: e.indexedBlock === null ? null : BigInt(e.indexedBlock), seq: b.seq, source: "indexer-rest" };
    }, () => chainSource.getBook(m, depth));
  },
  getTrades(m, limit) {
    return orChain<Trade[]>("trades", async () => parseFills((await get(`/markets/${m}/trades`, { limit })).data), () => chainSource.getTrades(m, limit));
  },
  getCandles(m, intervalSecs) {
    return orChain<Candle[]>("candles", async () => {
      const base = baseIntervalFor(intervalSecs);
      if (!base) throw new Error(`no indexer interval divides ${intervalSecs}s`);
      const e = await get(`/markets/${m}/candles`, { interval: NATIVE[base], limit: 1000 });
      const c = parseCandles(e.data);
      return base === intervalSecs ? c : aggregateCandles(c, intervalSecs);
    }, () => chainSource.getCandles(m, intervalSecs));
  },
  getUserFills(acct) {
    return orChain<Trade[]>("fills", async () => parseFills((await get(`/accounts/${acct}/fills`, { limit: 200 })).data), () => chainSource.getUserFills(acct));
  },
  getFundingHistory(acct) {
    return orChain("funding", async () => parseFundingSettlements((await get(`/accounts/${acct}/funding`, { limit: 200 })).data), () => chainSource.getFundingHistory(acct));
  },
  getLedger(acct) {
    return orChain("transfers", async () => {
      const [t, l] = await Promise.all([get(`/accounts/${acct}/transfers`, { limit: 200 }), get(`/liquidations`, { acct, limit: 100 })]);
      return [...parseTransfers(t.data, acct), ...parseLiquidations(l.data)].sort((a, b) => (a.block < b.block ? 1 : a.block > b.block ? -1 : 0));
    }, () => chainSource.getLedger(acct));
  },
  getConditionals(acct) {
    return orChain("conditionals", async () => parseConditionals((await get(`/accounts/${acct}/conditionals`, { limit: 200 })).data).filter((c) => c.active), () => chainSource.getConditionals(acct));
  },
  getTwaps(acct) {
    return orChain<Twap[]>("twaps", async () => {
      const list = parseTwaps((await get(`/accounts/${acct}/twaps`, { limit: 100 })).data);
      // next slice time is not part of the indexer schema: take it from the chain for schedules that are still active
      return Promise.all(list.map(async (t) => {
        if (!t.active) return t;
        try { const s = (await pc.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "twapStatus", args: [t.id] })) as { nextTime: bigint | number }; return { ...t, nextTime: Number(s.nextTime) }; }
        catch { return t; }
      }));
    }, () => chainSource.getTwaps(acct));
  },
  async getPositionStats(acct) {
    try { return parsePositions((await get(`/accounts/${acct}/positions`, { include_closed: true })).data); }
    catch (e) { noteFallback("positions", e); return null; }
  },
  async getOrderHistory(acct) {
    try { return parseOrders((await get(`/accounts/${acct}/orders`, { limit: 100 })).data); }
    catch (e) { noteFallback("order history", e); return null; }
  },
  async getSolvency() {
    // balances/debt counters are authoritative on chain; the event feed comes from the indexer when available
    const base = await chainSource.getSolvency();
    try {
      let events = parseBadDebt((await get(`/bad-debt`, { limit: 50 })).data);
      try { events = [...events, ...parseBackstopEvents((await get(`/backstop/events`, { limit: 50 })).data)].sort((a, b) => (a.block < b.block ? 1 : -1)); }
      catch (e) { noteFallback("backstop events", e); events = base.events; }
      try { events = [...events, ...parseLiquidationRows((await get(`/liquidations`, { limit: 50 })).data)].sort((a, b) => (a.block < b.block ? 1 : -1)); }
      catch (e) { noteFallback("liquidations", e); }
      return { ...base, events, source: "indexer+chain" } satisfies SolvencyInfo;
    } catch (e) { noteFallback("bad-debt events", e); return base; }
  },
  async getIndexerStatus(): Promise<IndexerStatus> {
    try { return parseStatus((await get("/status")).data); }
    catch (e) { return { ok: false, synced: false, lagBlocks: null, indexedBlock: null, chainHead: null, halted: null, error: e instanceof Error ? e.message : String(e) }; }
  },
};
