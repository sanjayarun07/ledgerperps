"use client";
import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { publicClient } from "./client";
import { EXCHANGE, USDC, exchangeAbi, usdcAbi } from "./config";
import { dataSource as ds } from "./data";
import { getFeed } from "./data/indexer";
import type { Book } from "./data/types";

const FAST = 2000;
const opts = { refetchInterval: FAST, staleTime: 1000 } as const;

export const useMarketInfo = (m: number) => useQuery({ queryKey: ["market", m], queryFn: () => ds.getMarket(m), ...opts });
export const useMark = (m: number) => useQuery({ queryKey: ["mark", m], queryFn: () => ds.getMarkPrice(m), ...opts });
/**
 * Order book. With an indexer: WS snapshot+delta (BookSync handles sequence gaps and resnapshots) renders instantly; REST/chain polling is
 * the fallback and keeps running (slowly) so the book never goes blank if the socket is down. Chain-only: bookSnapshot polling.
 */
const noopSub = () => () => {};
export function useBook(m: number, depth = 16): { data: Book | undefined; isLoading: boolean } {
  const feed = getFeed();
  const live = useSyncExternalStore(feed ? (cb) => feed.onBook(cb) : noopSub, () => (feed ? feed.book(m) : null), () => null);
  useEffect(() => (feed ? feed.subscribe({ channel: "book", market: m }) : undefined), [feed, m]);
  const q = useQuery({ queryKey: ["book", m, depth], queryFn: () => ds.getBook(m, depth), ...opts, refetchInterval: live ? false : FAST, enabled: !live });
  if (live) {
    return {
      isLoading: false,
      data: { bids: { px: live.bids.px.slice(0, depth), sz: live.bids.sz.slice(0, depth) }, asks: { px: live.asks.px.slice(0, depth), sz: live.asks.sz.slice(0, depth) }, blockNumber: null, seq: live.seq, source: "indexer-ws" },
    };
  }
  return { data: q.data, isLoading: q.isLoading };
}
export const useTrades = (m: number) => useQuery({ queryKey: ["trades", m], queryFn: () => ds.getTrades(m, 60), ...opts, refetchInterval: 3000 });
export const useCandles = (m: number, iv: number) => useQuery({ queryKey: ["candles", m, iv], queryFn: () => ds.getCandles(m, iv), ...opts, refetchInterval: 4000 });
export const useFunding = (m: number) => useQuery({ queryKey: ["funding", m], queryFn: () => ds.getFunding(m), ...opts });
export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: () => ds.getHealth(), ...opts, refetchInterval: 4000 });
export const useWithdrawGate = (a?: Hex) => useQuery({ queryKey: ["wdgate", a], queryFn: () => ds.getWithdrawGate(a!), enabled: !!a, ...opts, refetchInterval: 4000 });
export const useSolvency = () => useQuery({ queryKey: ["solvency"], queryFn: () => ds.getSolvency(), ...opts, refetchInterval: 4000 });
export const useAdlScores = (a?: Hex) => useQuery({ queryKey: ["adlscores", a], queryFn: () => ds.getAdlScores(a!), enabled: !!a, ...opts, refetchInterval: 4000 });
export const usePositionStats = (a?: Hex) => useQuery({ queryKey: ["posstats", a], queryFn: () => ds.getPositionStats(a!), enabled: !!a, ...opts, refetchInterval: 5000 });
export const useOrderHistory = (a?: Hex) => useQuery({ queryKey: ["orderhist", a], queryFn: () => ds.getOrderHistory(a!), enabled: !!a, ...opts, refetchInterval: 5000 });
export const useIndexerStatus = () => useQuery({ queryKey: ["indexerstatus"], queryFn: () => ds.getIndexerStatus(), ...opts, refetchInterval: 3000 });
export const useSystem = () => useQuery({ queryKey: ["system"], queryFn: () => ds.getSystem(), ...opts });

const acctOpts = (acct?: Hex) => ({ ...opts, enabled: !!acct });
export const useAccountState = (a?: Hex) => useQuery({ queryKey: ["account", a], queryFn: () => ds.getAccount(a!), ...acctOpts(a) });
export const usePositions = (a?: Hex) => useQuery({ queryKey: ["positions", a], queryFn: () => ds.getPositions(a!), ...acctOpts(a) });
export const useOpenOrders = (a?: Hex) => useQuery({ queryKey: ["orders", a], queryFn: () => ds.getOpenOrders(a!), ...acctOpts(a) });
export const useConditionals = (a?: Hex) => useQuery({ queryKey: ["conds", a], queryFn: () => ds.getConditionals(a!), ...acctOpts(a), refetchInterval: 4000 });
export const useTwaps = (a?: Hex) => useQuery({ queryKey: ["twaps", a], queryFn: () => ds.getTwaps(a!), ...acctOpts(a), refetchInterval: 3000 });
export const useUserFills = (a?: Hex) => useQuery({ queryKey: ["userfills", a], queryFn: () => ds.getUserFills(a!), ...acctOpts(a), refetchInterval: 5000 });
export const useFundingHistory = (a?: Hex) => useQuery({ queryKey: ["fundinghist", a], queryFn: () => ds.getFundingHistory(a!), ...acctOpts(a), refetchInterval: 6000 });
export const useLedger = (a?: Hex) => useQuery({ queryKey: ["ledger", a], queryFn: () => ds.getLedger(a!), ...acctOpts(a), refetchInterval: 6000 });
export const useAgents = (a?: Hex) => useQuery({ queryKey: ["agents", a], queryFn: () => ds.getAgents(a!), ...acctOpts(a), refetchInterval: 6000 });

export const useUsdc = (owner?: Address) =>
  useQuery({
    queryKey: ["usdc", owner],
    enabled: !!owner,
    ...opts,
    queryFn: async () => {
      const [bal, allowance] = await Promise.all([
        publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [owner!] }) as Promise<bigint>,
        publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "allowance", args: [owner!, EXCHANGE] }) as Promise<bigint>,
      ]);
      return { bal, allowance };
    },
  });

export const useEthBalance = (a?: Address) => useQuery({ queryKey: ["eth", a], enabled: !!a, ...opts, queryFn: () => publicClient.getBalance({ address: a! }) });

/**
 * Chain time = timestamp of the latest block (what the contract's block.timestamp will be close to), NOT the browser clock.
 * It only advances when blocks are mined, which is exactly what funding / TWAP / session-key expiry are measured against.
 * `fromChain` is false only before the first block has been read (the wall clock is then a placeholder).
 */
export function useChainClock(): { now: number; block: bigint | null; fromChain: boolean } {
  const sys = useSystem().data;
  return sys ? { now: sys.blockTime, block: sys.blockNumber, fromChain: true } : { now: Math.floor(Date.now() / 1000), block: null, fromChain: false };
}

import { stats24h } from "./terminal";
/** 24h stats derived from 1h candles (indexer candles or chain Fill events) against CHAIN time. null = no trades in the window / unavailable. */
export function useStats24h(m: number) {
  const c = useCandles(m, 3600);
  const clock = useChainClock();
  return { loading: c.isLoading, stats: c.data ? stats24h(c.data, clock.now) : null, available: c.data !== undefined };
}

const oracleLatestAbi = [{ type: "function", name: "latest", stateMutability: "view", inputs: [{ name: "feed", type: "bytes32" }], outputs: [{ name: "price", type: "uint256" }, { name: "updatedAt", type: "uint256" }] }] as const;
/** Index (oracle) price, read from the exchange's oracle for this market's feed. null when the feed is empty or older than the market's max age. */
export const useIndexPrice = (m: number) =>
  useQuery({
    queryKey: ["index", m], ...opts,
    queryFn: async (): Promise<bigint | null> => {
      try {
        const [mk, oracle, blk] = await Promise.all([
          publicClient.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "getMarket", args: [m] }) as Promise<{ feed: Hex; maxAge: number | bigint }>,
          publicClient.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "oracle" }) as Promise<Address>,
          publicClient.getBlock(),
        ]);
        const [p, t] = (await publicClient.readContract({ address: oracle, abi: oracleLatestAbi, functionName: "latest", args: [mk.feed] })) as [bigint, bigint];
        if (p === 0n || t > blk.timestamp || blk.timestamp - t > BigInt(mk.maxAge)) return null;
        return p;
      } catch { return null; }
    },
  });
