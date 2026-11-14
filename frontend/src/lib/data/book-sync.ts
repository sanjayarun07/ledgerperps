import type { Level } from "./indexer-parse";
import type { BookSide } from "./types";

/**
 * Client side of the indexer's book protocol (docs/ws-schemas.md, "Book sequence numbers and gap detection"):
 *  - keep last_seq; a delta must be last_seq + 1
 *  - seq <= last_seq  -> duplicate, ignore
 *  - seq >  last_seq+1 -> gap: DISCARD the local book, ask for a resnapshot, BUFFER deltas until the snapshot arrives,
 *                         then drop buffered deltas with seq <= snapshot.seq and apply the rest in order
 *  - resync (reorg)   -> discard everything; seq may go backwards; a fresh snapshot follows
 * Pure state machine (no I/O): `onSnapshot/onDelta` return whether the caller must send a `resnapshot` request.
 */
export type SyncState = "empty" | "syncing" | "synced";
export interface DeltaMsg { seq: number; side: "bid" | "ask"; price: bigint; size: bigint }

export class BookSync {
  state: SyncState = "empty";
  lastSeq = -1;
  private bids = new Map<bigint, bigint>();
  private asks = new Map<bigint, bigint>();
  private buffer: DeltaMsg[] = [];
  /** counters for diagnostics / tests */
  gaps = 0; duplicates = 0; resnapshotsRequested = 0;

  /** Returns true when the caller should send {"op":"resnapshot"}. */
  onDelta(d: DeltaMsg): boolean {
    if (this.state === "synced") {
      if (d.seq <= this.lastSeq) { this.duplicates++; return false; }
      if (d.seq === this.lastSeq + 1) { this.applyDelta(d); this.lastSeq = d.seq; return false; }
      // gap
      this.gaps++;
      this.discard();
      this.state = "syncing";
      this.buffer.push(d);
      this.resnapshotsRequested++;
      return true;
    }
    // empty/syncing: no snapshot to apply onto yet; hold deltas (bounded) until one arrives
    if (this.buffer.length < 10_000) this.buffer.push(d);
    return false;
  }

  /** Returns true if the buffered deltas after the snapshot are themselves gapped (caller must resnapshot again). */
  onSnapshot(seq: number, bids: Level[], asks: Level[]): boolean {
    this.bids = new Map(bids.filter(([, s]) => s > 0n));
    this.asks = new Map(asks.filter(([, s]) => s > 0n));
    this.lastSeq = seq;
    const pending = this.buffer.filter((d) => d.seq > seq).sort((a, b) => a.seq - b.seq);
    this.buffer = [];
    this.state = "synced";
    for (const d of pending) {
      if (d.seq <= this.lastSeq) { this.duplicates++; continue; }
      if (d.seq !== this.lastSeq + 1) { // buffered stream has a hole: start over
        this.gaps++;
        this.discard();
        this.state = "syncing";
        this.resnapshotsRequested++;
        return true;
      }
      this.applyDelta(d);
      this.lastSeq = d.seq;
    }
    return false;
  }

  /** Reorg / reconnect: forget everything. The server sends a fresh snapshot (we also request one). */
  onResync() { this.discard(); this.buffer = []; this.state = "empty"; this.resnapshotsRequested++; }
  reset() { this.discard(); this.buffer = []; this.state = "empty"; }

  private discard() { this.bids.clear(); this.asks.clear(); this.lastSeq = -1; }
  private applyDelta(d: DeltaMsg) {
    const m = d.side === "bid" ? this.bids : this.asks;
    if (d.size === 0n) m.delete(d.price); else m.set(d.price, d.size); // size is the NEW TOTAL at the level; 0 removes it
  }

  /** Sorted best-first, capped at `depth` levels; null while not synced (the caller must not display a half-built book). */
  view(depth: number): { bids: BookSide; asks: BookSide; seq: number } | null {
    if (this.state !== "synced") return null;
    const side = (m: Map<bigint, bigint>, desc: boolean): BookSide => {
      const px = [...m.keys()].sort((a, b) => (a === b ? 0 : (a < b) !== desc ? -1 : 1)).slice(0, depth);
      return { px, sz: px.map((p) => m.get(p)!) };
    };
    return { bids: side(this.bids, true), asks: side(this.asks, false), seq: this.lastSeq };
  }
}
