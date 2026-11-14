import { parseEventLogs, type Address, type Hex } from "viem";
import { publicClient as pc } from "../client";
import { EXCHANGE, exchangeAbi, MARKETS } from "../config";
import { abs } from "../units";
import { LogScanner, type ScanLog } from "./logscan";
import type { ExchangeHealth, WithdrawGate, AdlScore, AgentInfo, Candle, Conditional, DataSource, FundingPayment, LedgerEvent, MarketInfo, OpenOrder, PositionInfo, SolvencyEvent, SolvencyInfo, SystemStatus, Trade, Twap } from "./types";

const base = { address: EXCHANGE, abi: exchangeAbi } as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = <T,>(functionName: string, args: readonly unknown[] = []) => pc.readContract({ ...base, functionName, args } as any) as Promise<T>;

const TS_CACHE_MAX = 5000;
const tsCache = new Map<bigint, number>();
async function blockTime(n: bigint): Promise<number> {
  const c = tsCache.get(n);
  if (c !== undefined) return c;
  const b = await pc.getBlock({ blockNumber: n });
  const t = Number(b.timestamp);
  if (tsCache.size >= TS_CACHE_MAX) tsCache.delete(tsCache.keys().next().value as bigint); // bounded (insertion order = oldest first)
  tsCache.set(n, t);
  return t;
}

/** One incremental scanner for every exchange log. getLogs is range-chunked by LogScanner (and halved if the node rejects a range). */
export const scanner = new LogScanner({
  getHead: () => pc.getBlockNumber(),
  async fetchLogs(from, to): Promise<ScanLog[]> {
    const raw = await pc.getLogs({ address: EXCHANGE, fromBlock: from, toBlock: to });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parseEventLogs({ abi: exchangeAbi, logs: raw }) as any[]; // logs not in the ABI are dropped
    return parsed.map((l) => ({ eventName: l.eventName as string, args: (l.args ?? {}) as Record<string, unknown>, blockNumber: l.blockNumber as bigint, logIndex: Number(l.logIndex), transactionHash: l.transactionHash as Hex }));
  },
});

async function times(blocks: bigint[]): Promise<Map<bigint, number>> {
  const uniq = [...new Set(blocks)];
  const ts = await Promise.all(uniq.map(blockTime));
  return new Map(uniq.map((b, i) => [b, ts[i]]));
}

/** Window-bounded event query: syncs the cursor (cheap when nothing changed) and filters in memory. */
async function events(eventName: string, args?: Record<string, unknown>): Promise<ScanLog[]> {
  await scanner.sync();
  return scanner.get(eventName, args);
}
/** How far back chain-only history reaches (null until the first scan). */
export const historyFloor = () => scanner.oldestBlock;

const marketTrades = async (m: number): Promise<Trade[]> => {
  const logs = await events("Fill", { market: m });
  const t = await times(logs.map((l) => l.blockNumber));
  return logs.map((l) => ({
    tradeId: l.args.tradeId as bigint, market: Number(l.args.market), price: l.args.price as bigint, size: l.args.size as bigint, takerIsBuy: l.args.takerIsBuy as boolean,
    time: t.get(l.blockNumber) ?? 0, block: l.blockNumber, maker: l.args.maker as Hex, taker: l.args.taker as Hex,
    takerFee: l.args.takerFee as bigint, makerFee: l.args.makerFee as bigint, txHash: l.transactionHash,
  }));
};

export function bucketCandles(trades: Pick<Trade, "price" | "size" | "time" | "tradeId">[], intervalSecs: number): Candle[] {
  const sorted = [...trades].sort((a, b) => (a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0));
  const out: Candle[] = [];
  for (const t of sorted) {
    const bucket = Math.floor(t.time / intervalSecs) * intervalSecs;
    const px = Number(t.price) / 1e6;
    const vol = Number(t.size) / 1e8;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, px); last.low = Math.min(last.low, px); last.close = px; last.volume += vol;
    } else out.push({ time: bucket, open: px, high: px, low: px, close: px, volume: vol });
  }
  return out;
}

export const chainSource: DataSource = {
  name: "chain",
  async getMarket(m) {
    const x = await read<Record<string, unknown> & { tiers: { upToNotional: bigint; imrBps: number; mmrBps: number }[] }>("getMarket", [m]);
    const g = x as unknown as Record<string, bigint | number>;
    return {
      id: m, state: Number(g.state), tick: g.tick as bigint, lot: g.lot as bigint, minNotional: g.minNotional as bigint,
      maxOrderSize: g.maxOrderSize as bigint, maxOI: g.maxOI as bigint, oi: g.oi as bigint, maxAge: Number(g.maxAge),
      fundingInterval: Number(g.fundingInterval), lastFunding: Number(g.lastFunding), fundingIndex: g.fundingIndex as bigint,
      lastTradePrice: BigInt(g.lastTradePrice), tiers: x.tiers.map((t) => ({ upToNotional: t.upToNotional, imrBps: Number(t.imrBps), mmrBps: Number(t.mmrBps) })),
    } satisfies MarketInfo;
  },
  async getMarkPrice(m) {
    try { return await read<bigint>("markPrice", [m]); } catch { return null; } // reverts when the oracle is stale/degraded
  },
  async getBook(m, depth) {
    const [bids, asks, blockNumber] = await Promise.all([
      read<[bigint[], bigint[]]>("bookSnapshot", [m, true, depth]),
      read<[bigint[], bigint[]]>("bookSnapshot", [m, false, depth]),
      pc.getBlockNumber(),
    ]);
    // bookSnapshot pads unused slots with zero price/size: drop them
    const side = (r: [bigint[], bigint[]]) => { const px: bigint[] = [], sz: bigint[] = []; r[0].forEach((p, i) => { if (p > 0n && r[1][i] > 0n) { px.push(p); sz.push(r[1][i]); } }); return { px, sz }; };
    return { bids: side(bids), asks: side(asks), blockNumber, source: "chain" };
  },
  async getTrades(m, limit) {
    const t = await marketTrades(m);
    return t.slice(-limit).reverse();
  },
  async getCandles(m, intervalSecs) {
    return bucketCandles(await marketTrades(m), intervalSecs);
  },
  async getAccount(acct) {
    const [s, w, c] = await Promise.all([
      read<[bigint, bigint, bigint, bigint, bigint]>("accountState", [acct]),
      read<bigint>("withdrawable", [acct]),
      read<bigint>("collateral", [acct]),
    ]);
    return { equity: s[0], im: s[1], mm: s[2], resv: s[3], avail: s[4], withdrawable: w, collateral: c };
  },
  async getPositions(acct) {
    return Promise.all(MARKETS.map(async ({ id }) => {
      const [p, iso] = await Promise.all([
        read<[bigint, bigint, bigint, boolean, bigint, bigint]>("positions", [acct, id]),
        read<[boolean, bigint, bigint, bigint, bigint, bigint]>("isoState", [acct, id]),
      ]);
      return { market: id, size: p[0], basis: p[1], isolated: p[3], isoMargin: p[4], iso: { isolated: iso[0], margin: iso[1], equity: iso[2], im: iso[3], mm: iso[4], resv: iso[5] } } satisfies PositionInfo;
    }));
  },
  async getOpenOrders(acct) {
    const ids = await read<bigint[]>("openOrderIds", [acct]);
    const os = await Promise.all(ids.map((id) => read<[Hex, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean, boolean]>("orders", [id])));
    return os.map((o, i) => ({ id: ids[i], market: Number(o[8]), isBuy: o[9], price: o[3], size: o[1], reserve: o[2], reduceOnly: o[10], expiry: o[4], cloid: o[7] }) satisfies OpenOrder).filter((o) => o.size > 0n);
  },
  async getConditionals(acct) {
    const logs = await events("CondPlaced", { acct });
    const ids = logs.map((l) => l.args.id as bigint);
    const cs = await Promise.all(ids.map((id) => read<[Hex, bigint, bigint, bigint, bigint, number, boolean, boolean, boolean, boolean]>("conds", [id])));
    return cs.map((c, i) => ({ id: ids[i], market: Number(c[5]), isBuy: c[6], above: c[7], trigger: c[2], limit: c[3], size: c[1], reduceOnly: c[8], sibling: c[4], active: c[9] }) satisfies Conditional).filter((c) => c.active);
  },
  async getTwaps(acct) {
    const logs = await events("TwapPlaced", { acct });
    const ids = logs.map((l) => l.args.id as bigint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ts = await Promise.all(ids.map((id) => read<any>("twapStatus", [id])));
    return ts.map((t, i) => ({
      id: ids[i], market: Number(t.market), isBuy: t.isBuy, total: t.total, filled: t.filled, slices: Number(t.slices), done: Number(t.done), failed: Number(t.failed),
      interval: Number(t.interval), nextTime: Number(t.nextTime), slippageBps: Number(t.slippageBps), reduceOnly: t.reduceOnly, active: t.active,
    }) satisfies Twap).reverse();
  },
  async getUserFills(acct) {
    const all = (await Promise.all(MARKETS.map((m) => marketTrades(m.id)))).flat();
    return all.filter((t) => t.maker === acct || t.taker === acct).sort((a, b) => (a.tradeId < b.tradeId ? 1 : -1));
  },
  async getFundingHistory(acct) {
    const logs = await events("FundingSettled", { acct });
    const t = await times(logs.map((l) => l.blockNumber));
    return logs.map((l) => ({ market: Number(l.args.market), owed: l.args.owed as bigint, block: l.blockNumber, time: t.get(l.blockNumber) ?? 0 }) satisfies FundingPayment).reverse();
  },
  async getLedger(acct) {
    const [dep, wd, tin, tout, liq] = await Promise.all([
      events("Deposit", { acct }), events("Withdraw", { acct }), events("InternalTransfer", { to: acct }), events("InternalTransfer", { from: acct }), events("Liquidated", { acct }),
    ]);
    const rows: Omit<LedgerEvent, "time">[] = [
      ...dep.map((l) => ({ kind: "Deposit" as const, amount: l.args.amount as bigint, block: l.blockNumber as bigint, txHash: l.transactionHash as Hex })),
      ...wd.map((l) => ({ kind: "Withdraw" as const, amount: l.args.amount as bigint, block: l.blockNumber as bigint, txHash: l.transactionHash as Hex })),
      ...tin.map((l) => ({ kind: "InternalTransfer" as const, amount: l.args.amount as bigint, block: l.blockNumber as bigint, txHash: l.transactionHash as Hex })),
      ...tout.map((l) => ({ kind: "InternalTransfer" as const, amount: -(l.args.amount as bigint), block: l.blockNumber as bigint, txHash: l.transactionHash as Hex })),
      ...liq.map((l) => ({ kind: "Liquidated" as const, amount: l.args.size as bigint, market: Number(l.args.market), block: l.blockNumber as bigint, txHash: l.transactionHash as Hex })),
    ];
    const t = await times(rows.map((r) => r.block));
    return rows.map((r) => ({ ...r, time: t.get(r.block) ?? 0 })).sort((a, b) => (a.block < b.block ? 1 : -1));
  },
  async getAgents(acct) {
    const logs = await events("AgentApproved", { acct });
    const agents = [...new Set(logs.map((l) => l.args.agent as Address))];
    const exp = await Promise.all(agents.map((a) => read<bigint>("agentExpiry", [acct, a])));
    return agents.map((a, i) => ({ agent: a, expiry: exp[i] }) satisfies AgentInfo).filter((a) => a.expiry > 0n);
  },
  async getAdlScores(acct) {
    return Promise.all(MARKETS.map(async ({ id }) => {
      try { return { market: id, score: await read<bigint>("adlScore", [acct, id]) } satisfies AdlScore; }
      catch { return { market: id, score: null } satisfies AdlScore; } // markPrice reverts while the oracle is stale
    }));
  },
  async getSolvency() {
    const [insurance, unresolved, debts, a, r, u, liq] = await Promise.all([
      read<bigint>("insurance"), read<bigint>("unresolvedBadDebt"), Promise.all(MARKETS.map(({ id }) => read<bigint>("adlDebt", [id]))),
      events("AdlExecuted"), events("Recapitalized"), events("BadDebtUnresolved"), events("Liquidated"),
    ]);
    const [bs, sk] = await Promise.all([events("BackstopSynced").catch(() => []), events("AdlSkipped").catch(() => [])]);
    const rows: Omit<SolvencyEvent, "time">[] = [
      ...a.map((l) => ({ kind: "adl" as const, market: Number(l.args.market), acct: l.args.target as Hex, amount: l.args.debtCleared as bigint, size: l.args.size as bigint, price: l.args.price as bigint, block: l.blockNumber, txHash: l.transactionHash })),
      ...r.map((l) => ({ kind: "recapitalized" as const, market: Number(l.args.market), acct: null, amount: l.args.amount as bigint, size: null, price: null, block: l.blockNumber, txHash: l.transactionHash })),
      ...u.map((l) => ({ kind: "bad_debt_unresolved" as const, market: null, acct: l.args.acct as Hex, amount: l.args.amount as bigint, size: null, price: null, block: l.blockNumber, txHash: l.transactionHash })),
      ...liq.filter((l) => (l.args.badDebt as bigint) > 0n).map((l) => ({ kind: "liquidation_bad_debt" as const, market: Number(l.args.market), acct: l.args.acct as Hex, amount: l.args.badDebt as bigint, size: l.args.size as bigint, price: l.args.price as bigint, block: l.blockNumber, txHash: l.transactionHash })),
      ...bs.map((l) => { const d = (l.args.fromInsurance as bigint) + (l.args.toDebt as bigint); const r = (l.args.refundedInsurance as bigint) + (l.args.repaidDebt as bigint); return d > 0n ? { kind: "backstop_deficit" as const, market: Number(l.args.market), acct: null, amount: d, size: null, price: null, block: l.blockNumber, txHash: l.transactionHash } : { kind: "backstop_repaid" as const, market: null, acct: null, amount: r, size: null, price: null, block: l.blockNumber, txHash: l.transactionHash }; }),
      ...sk.map((l) => ({ kind: "adl_skipped" as const, market: Number(l.args.market), acct: l.args.target as Hex, amount: l.args.slack as bigint, size: null, price: null, block: l.blockNumber, txHash: l.transactionHash })),
    ];
    const t = await times(rows.map((x) => x.block));
    return { insurance, unresolvedBadDebt: unresolved, adlDebt: debts, events: rows.map((x) => ({ ...x, time: t.get(x.block) ?? 0 })).sort((x, y) => (x.block < y.block ? 1 : -1)).slice(0, 50), source: "chain" } satisfies SolvencyInfo;
  },
  async getHealth() {
    const opt = async <T,>(fn: string): Promise<T | null> => { try { return await read<T>(fn); } catch { return null; } };
    const [unresolved, insurance, bsDebt, eq, thr] = await Promise.all([
      read<bigint>("unresolvedBadDebt"), read<bigint>("insurance"), opt<bigint>("bsDebt"), opt<bigint>("backstopEquity"), opt<bigint>("wdGateThreshold"),
    ]);
    return { unresolvedBadDebt: unresolved, bsDebt, insurance, backstopEquity: eq, gateThreshold: thr, gateActive: thr === null ? null : unresolved > thr } satisfies ExchangeHealth;
  },
  async getWithdrawGate(acct) {
    const opt = async <T,>(fn: string, args: readonly unknown[] = []): Promise<T | null> => { try { return await read<T>(fn, args); } catch { return null; } };
    const [pr, thr, unresolved] = await Promise.all([opt<bigint>("principal", [acct]), opt<bigint>("wdGateThreshold"), opt<bigint>("unresolvedBadDebt")]);
    return { principal: pr, threshold: thr, unresolvedBadDebt: unresolved, active: thr === null || unresolved === null ? null : unresolved > thr } satisfies WithdrawGate;
  },
  async getPositionStats() { return null; },
  async getOrderHistory() { return null; },
  async getIndexerStatus() { return null; },
  async getFunding(m) {
    const [rate, mk] = await Promise.all([read<bigint>("estimatedFundingRate", [m]), this.getMarket(m)]);
    return { rate, lastFunding: mk.lastFunding, interval: mk.fundingInterval };
  },
  async getSystem() {
    const [globalPaused, blk, ms] = await Promise.all([
      read<boolean>("globalPaused"), pc.getBlock(),
      Promise.all(MARKETS.map(async ({ id }) => {
        const [mk, px] = await Promise.all([chainSource.getMarket(id), chainSource.getMarkPrice(id)]);
        return { id, state: mk.state, markPrice: px, oracleOk: px !== null };
      })),
    ]);
    return { globalPaused, markets: ms, blockNumber: blk.number, blockTime: Number(blk.timestamp) } satisfies SystemStatus;
  },
};
export { abs };
