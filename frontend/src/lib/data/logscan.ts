import type { Hex } from "viem";

/**
 * Incremental, bounded log scanner for chain-only mode.
 *
 * The old implementation re-ran getContractEvents(fromBlock: 0) for every event type on every poll. This keeps ONE cursor
 * (the last block that was fully scanned) and on each sync fetches only (cursor - REORG_OVERLAP, head] in bounded
 * chunks. Logs are held in a bounded in-memory window: at most `capPerKind` logs per event name, oldest evicted first.
 * The first scan only looks back `initialLookback` blocks from the head, so a long-lived chain does not cause a huge
 * first request; `oldestBlock` reports how far back the window actually reaches so the UI can say so.
 */
export interface ScanLog { eventName: string; args: Record<string, unknown>; blockNumber: bigint; logIndex: number; transactionHash: Hex }

export interface ScanDeps {
  getHead(): Promise<bigint>;
  /** all exchange logs in [from, to] (inclusive), decoded. May throw if the range is too large for the node. */
  fetchLogs(from: bigint, to: bigint): Promise<ScanLog[]>;
}
export interface ScanOptions { chunk?: bigint; minChunk?: bigint; initialLookback?: bigint; capPerKind?: number; reorgOverlap?: bigint; minIntervalMs?: number; now?: () => number }

export class LogScanner {
  private byKind = new Map<string, ScanLog[]>();
  /** highest block that has been fully scanned (-1 = nothing scanned yet) */
  cursor = -1n;
  /** lowest block that the window is guaranteed to cover */
  oldestBlock: bigint | null = null;
  /** number of getLogs requests issued so far (diagnostics / tests) */
  requests = 0;
  private inflight: Promise<void> | null = null;
  private lastSync = 0;
  private chunk: bigint;
  private readonly o: Required<ScanOptions>;

  constructor(private deps: ScanDeps, opts: ScanOptions = {}) {
    this.o = { chunk: 2000n, minChunk: 64n, initialLookback: 50_000n, capPerKind: 10_000, reorgOverlap: 2n, minIntervalMs: 400, now: Date.now, ...opts };
    this.chunk = this.o.chunk;
  }

  /** Bring the window up to the chain head. Concurrent callers share one in-flight sync; rapid callers reuse the last result. */
  sync(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.o.now() - this.lastSync < this.o.minIntervalMs && this.cursor >= 0n) return Promise.resolve();
    this.inflight = this.run().finally(() => { this.inflight = null; this.lastSync = this.o.now(); });
    return this.inflight;
  }

  private async run(): Promise<void> {
    const head = await this.deps.getHead();
    if (this.cursor >= 0n && head < this.cursor) this.reset(); // chain restarted / reorged below our cursor: start over
    let from: bigint;
    if (this.cursor < 0n) {
      from = head > this.o.initialLookback ? head - this.o.initialLookback : 0n;
      this.oldestBlock = from;
    } else {
      if (head === this.cursor) return;
      from = this.cursor + 1n > this.o.reorgOverlap ? this.cursor + 1n - this.o.reorgOverlap : 0n;
      this.dropFrom(from); // overlap: replace the last few blocks so a shallow reorg is healed
    }
    let lo = from;
    while (lo <= head) {
      let hi = lo + this.chunk - 1n;
      if (hi > head) hi = head;
      let logs: ScanLog[];
      try { this.requests++; logs = await this.deps.fetchLogs(lo, hi); }
      catch (e) {
        if (this.chunk > this.o.minChunk) { this.chunk = this.chunk / 2n < this.o.minChunk ? this.o.minChunk : this.chunk / 2n; continue; } // node rejected the range: halve and retry
        throw e;
      }
      this.add(logs);
      this.cursor = hi; // advance only after a successful chunk, so a failure retries from here next sync
      lo = hi + 1n;
    }
  }

  private reset() { this.byKind.clear(); this.cursor = -1n; this.oldestBlock = null; this.chunk = this.o.chunk; }

  private dropFrom(block: bigint) {
    for (const [k, arr] of this.byKind) {
      let n = arr.length;
      while (n > 0 && arr[n - 1].blockNumber >= block) n--;
      if (n !== arr.length) this.byKind.set(k, arr.slice(0, n));
    }
  }

  private add(logs: ScanLog[]) {
    for (const l of logs) {
      let arr = this.byKind.get(l.eventName);
      if (!arr) this.byKind.set(l.eventName, (arr = []));
      arr.push(l);
    }
    for (const [k, arr] of this.byKind) {
      if (arr.length > this.o.capPerKind) {
        const drop = arr.length - this.o.capPerKind;
        const evictedTo = arr[drop - 1].blockNumber;
        this.byKind.set(k, arr.slice(drop));
        // the window for this kind now starts after the evicted block; report the most conservative bound
        if (this.oldestBlock === null || evictedTo + 1n > this.oldestBlock) this.oldestBlock = evictedTo + 1n;
      }
    }
  }

  /** Logs of one event name from the window (ascending), optionally filtered by decoded args (case-insensitive for hex). */
  get(eventName: string, where?: Record<string, unknown>): ScanLog[] {
    const arr = this.byKind.get(eventName) ?? [];
    if (!where) return arr;
    const eq = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b || (typeof a === "bigint" && typeof b === "number" && Number(a) === b) || (typeof a === "number" && typeof b === "bigint" && a === Number(b)));
    return arr.filter((l) => Object.entries(where).every(([k, v]) => eq(l.args[k], v)));
  }

  get size() { let n = 0; for (const a of this.byKind.values()) n += a.length; return n; }
}
