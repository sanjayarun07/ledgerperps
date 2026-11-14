import { describe, expect, it } from "vitest";
import { LogScanner, type ScanLog } from "./logscan";

const log = (block: number, idx: number, eventName = "Fill", args: Record<string, unknown> = {}): ScanLog => ({ eventName, args: { tradeId: BigInt(block * 100 + idx), ...args }, blockNumber: BigInt(block), logIndex: idx, transactionHash: "0x00" });

/** Fake chain: logs live in `chainLogs`; records every getLogs range so tests can assert no rescans from block 0. */
function harness(opts: ConstructorParameters<typeof LogScanner>[1] = {}) {
  const st = { head: 0n, chainLogs: [] as ScanLog[], ranges: [] as [bigint, bigint][], maxSpan: 1e12 as number };
  const s = new LogScanner({
    getHead: async () => st.head,
    fetchLogs: async (from, to) => {
      if (to - from + 1n > BigInt(st.maxSpan)) throw new Error("query exceeds max block range");
      st.ranges.push([from, to]);
      return st.chainLogs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
  }, { minIntervalMs: 0, ...opts });
  return { st, s };
}

describe("LogScanner", () => {
  it("scans in bounded chunks and does not rescan from block 0 on later syncs", async () => {
    const { st, s } = harness({ chunk: 100n, initialLookback: 1_000_000n });
    st.head = 250n;
    st.chainLogs = [log(5, 0), log(120, 0), log(250, 0)];
    await s.sync();
    expect(st.ranges).toEqual([[0n, 99n], [100n, 199n], [200n, 250n]]);
    expect(s.get("Fill")).toHaveLength(3);
    expect(s.cursor).toBe(250n);

    st.ranges.length = 0;
    st.head = 260n; st.chainLogs.push(log(255, 0));
    await s.sync();
    // only (cursor - overlap, head]: no request starts anywhere near 0
    expect(st.ranges).toHaveLength(1);
    expect(st.ranges[0][0]).toBeGreaterThanOrEqual(240n);
    expect(st.ranges[0][1]).toBe(260n);
    expect(s.get("Fill").map((l) => l.blockNumber)).toEqual([5n, 120n, 250n, 255n]); // overlap blocks are replaced, not duplicated
  });

  it("makes no request when the head has not moved", async () => {
    const { st, s } = harness();
    st.head = 10n; st.chainLogs = [log(3, 0)];
    await s.sync();
    const n = s.requests;
    await s.sync(); await s.sync();
    expect(s.requests).toBe(n);
  });

  it("limits the first scan to the lookback window and reports where history starts", async () => {
    const { st, s } = harness({ initialLookback: 1000n, chunk: 400n });
    st.head = 1_000_000n; st.chainLogs = [log(5, 0), log(999_500, 0)];
    await s.sync();
    expect(st.ranges[0][0]).toBe(999_000n);
    expect(s.get("Fill").map((l) => l.blockNumber)).toEqual([999_500n]); // block 5 is outside the window by design
    expect(s.oldestBlock).toBe(999_000n);
  });

  it("evicts the oldest logs per kind beyond the cap", async () => {
    const { st, s } = harness({ capPerKind: 3, chunk: 1000n });
    st.head = 10n; st.chainLogs = [1, 2, 3, 4, 5].map((b) => log(b, 0));
    await s.sync();
    expect(s.get("Fill").map((l) => l.blockNumber)).toEqual([3n, 4n, 5n]);
    expect(s.oldestBlock).toBe(3n);
  });

  it("halves the range when the node rejects it, then continues", async () => {
    const { st, s } = harness({ chunk: 1000n, minChunk: 50n });
    st.maxSpan = 300; st.head = 999n; st.chainLogs = [log(10, 0), log(900, 0)];
    await s.sync();
    expect(s.get("Fill")).toHaveLength(2);
    expect(st.ranges.every(([a, b]) => b - a + 1n <= 300n)).toBe(true);
  });

  it("surfaces the error when even the minimum range is rejected, and retries from the failed chunk next time", async () => {
    const { st, s } = harness({ chunk: 100n, minChunk: 50n });
    st.maxSpan = 10; st.head = 500n;
    await expect(s.sync()).rejects.toThrow(/max block range/);
    expect(s.cursor).toBe(-1n);
    st.maxSpan = 1e12; st.chainLogs = [log(7, 0)];
    await s.sync();
    expect(s.get("Fill")).toHaveLength(1);
  });

  it("heals a shallow reorg inside the overlap and resets if the chain restarted below the cursor", async () => {
    const { st, s } = harness({ reorgOverlap: 2n });
    st.head = 20n; st.chainLogs = [log(19, 0, "Fill", { price: 1n }), log(20, 0, "Fill", { price: 2n })];
    await s.sync();
    st.head = 21n; st.chainLogs = [log(19, 0, "Fill", { price: 1n }), log(20, 0, "Fill", { price: 99n }), log(21, 0, "Fill", { price: 3n })]; // block 20 was replaced
    await s.sync();
    expect(s.get("Fill").map((l) => l.args.price)).toEqual([1n, 99n, 3n]);
    // hardhat restarted: head far below the cursor
    st.head = 3n; st.chainLogs = [log(2, 0, "Fill", { price: 7n })];
    await s.sync();
    expect(s.get("Fill").map((l) => l.args.price)).toEqual([7n]);
  });

  it("filters by decoded args, case-insensitively for hex and across number/bigint", async () => {
    const { st, s } = harness();
    st.head = 5n; st.chainLogs = [log(1, 0, "Fill", { market: 0, maker: "0xAbC" }), log(2, 0, "Fill", { market: 1, maker: "0xabc" })];
    await s.sync();
    expect(s.get("Fill", { market: 1n })).toHaveLength(1);
    expect(s.get("Fill", { maker: "0xABC" })).toHaveLength(2);
  });

  it("shares one in-flight sync between concurrent callers", async () => {
    const { st, s } = harness();
    st.head = 5n; st.chainLogs = [log(1, 0)];
    await Promise.all([s.sync(), s.sync(), s.sync()]);
    expect(s.requests).toBe(1);
  });
});
