import type { Hex } from "viem";

export interface Tier { upToNotional: bigint; imrBps: number; mmrBps: number }
export interface MarketInfo {
  id: number; state: number; tick: bigint; lot: bigint; minNotional: bigint; maxOrderSize: bigint; maxOI: bigint; oi: bigint;
  maxAge: number; fundingInterval: number; lastFunding: number; fundingIndex: bigint; lastTradePrice: bigint; tiers: Tier[];
}
export interface BookSide { px: bigint[]; sz: bigint[] }
export interface Book {
  bids: BookSide; asks: BookSide;
  /** chain block (chain source) or the indexer's indexed block (REST) when known */
  blockNumber: bigint | null;
  /** indexer book sequence number (REST/WS); absent for the chain source */
  seq?: number;
  source: "chain" | "indexer-rest" | "indexer-ws";
}
export interface Trade {
  tradeId: bigint; market: number; price: bigint; size: bigint; takerIsBuy: boolean; time: number; block: bigint;
  maker: Hex; taker: Hex; takerFee: bigint; makerFee: bigint; txHash: Hex;
}
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface AccountState { equity: bigint; im: bigint; mm: bigint; resv: bigint; avail: bigint; withdrawable: bigint; collateral: bigint }
export interface IsoState { isolated: boolean; margin: bigint; equity: bigint; im: bigint; mm: bigint; resv: bigint }
export interface PositionInfo { market: number; size: bigint; basis: bigint; isolated: boolean; isoMargin: bigint; iso: IsoState }
export interface OpenOrder { id: bigint; market: number; isBuy: boolean; price: bigint; size: bigint; reserve: bigint; reduceOnly: boolean; expiry: bigint; cloid: bigint }
export interface Conditional { id: bigint; market: number; isBuy: boolean; above: boolean; trigger: bigint; limit: bigint; size: bigint; reduceOnly: boolean; sibling: bigint; active: boolean }
export interface Twap { status?: "active" | "done" | "canceled"; id: bigint; market: number; isBuy: boolean; total: bigint; filled: bigint; slices: number; done: number; failed: number; interval: number; nextTime: number; slippageBps: number; reduceOnly: boolean; active: boolean }
export interface FundingPayment { market: number; owed: bigint; block: bigint; time: number }
export interface LedgerEvent { kind: "Deposit" | "Withdraw" | "InternalTransfer" | "Liquidated" | "IsoMargin"; amount: bigint; block: bigint; time: number; txHash: Hex; market?: number }
export interface AgentInfo { agent: Hex; expiry: bigint }
export interface SystemStatus { globalPaused: boolean; markets: { id: number; state: number; markPrice: bigint | null; oracleOk: boolean }[]; blockNumber: bigint; blockTime: number }
export interface AdlScore { market: number; /** null when the mark price is unavailable; 2^256-1 means equity <= 0 (first in line) */ score: bigint | null }
export interface SolvencyEvent {
  kind: "liquidated" | "adl" | "recapitalized" | "bad_debt_unresolved" | "liquidation_bad_debt" | "backstop_deficit" | "backstop_repaid" | "adl_skipped" | "backstop_elevated" | "backstop_relaxed" | "backstop_taken" | "backstop_unwound"; market: number | null; acct: Hex | null;
  amount: bigint; size: bigint | null; price: bigint | null; block: bigint; time: number; txHash: Hex;
}
/** Exchange-wide health from chain views only (null = view unavailable). */
export interface ExchangeHealth { unresolvedBadDebt: bigint; bsDebt: bigint | null; insurance: bigint; backstopEquity: bigint | null; gateThreshold: bigint | null; gateActive: boolean | null }
/** Backstop Phase 2 status for one market from chain views (null = view unavailable, e.g. an older deployment). `softNotional === 0n` = feature off. */
export interface BackstopStatus {
  market: number; softNotional: bigint | null; elevated: boolean | null;
  /** |backstop position| x mark, micro-USDC; null when the position or mark is unavailable */
  inventoryNotional: bigint | null;
  auction: { active: boolean; takerSells: boolean; price: bigint; discBps: bigint; size: bigint } | null;
}
/** Withdrawal limiter state for one account: while `active`, withdrawing more than `principal` reverts `WithdrawGated`. */
export interface WithdrawGate { principal: bigint | null; active: boolean | null; threshold: bigint | null; unresolvedBadDebt: bigint | null }
export interface SolvencyInfo { insurance: bigint; unresolvedBadDebt: bigint; adlDebt: bigint[]; events: SolvencyEvent[]; source: "chain" | "indexer+chain" }
/** Indexer-derived per-position extras (realized PnL, fees, funding). Never authoritative: the chain position is. */
export interface PositionStat { market: number; size: bigint; basis: bigint; entryPrice: bigint | null; realizedPnl: bigint; feesPaid: bigint; fundingPaid: bigint; approximate: boolean }
export interface OrderRow {
  id: bigint; market: number; isBuy: boolean; price: bigint; size: bigint; filled: bigint; remaining: bigint; avgFillPrice: bigint | null;
  status: string; tif: string; reduceOnly: boolean; cancelReason: string | null; time: number; txHash: Hex | null;
}
export interface IndexerStatus { ok: boolean; synced: boolean; lagBlocks: number | null; indexedBlock: number | null; chainHead: number | null; halted: string | null; error?: string }
export interface FundingInfo { rate: bigint; lastFunding: number; interval: number }

/**
 * Thin data-source abstraction. ChainDataSource reads straight from the node (works with no indexer).
 * IndexerDataSource (optional, NEXT_PUBLIC_INDEXER_URL) serves the documented /v1 endpoints and falls back to chain per call.
 */
export interface DataSource {
  readonly name: string;
  getMarket(m: number): Promise<MarketInfo>;
  getMarkPrice(m: number): Promise<bigint | null>;
  getBook(m: number, depth: number): Promise<Book>;
  getTrades(m: number, limit: number): Promise<Trade[]>;
  getCandles(m: number, intervalSecs: number): Promise<Candle[]>;
  getAccount(acct: Hex): Promise<AccountState>;
  getPositions(acct: Hex): Promise<PositionInfo[]>;
  getOpenOrders(acct: Hex): Promise<OpenOrder[]>;
  getConditionals(acct: Hex): Promise<Conditional[]>;
  getTwaps(acct: Hex): Promise<Twap[]>;
  getUserFills(acct: Hex): Promise<Trade[]>;
  getFundingHistory(acct: Hex): Promise<FundingPayment[]>;
  getLedger(acct: Hex): Promise<LedgerEvent[]>;
  getAgents(acct: Hex): Promise<AgentInfo[]>;
  getFunding(m: number): Promise<FundingInfo>;
  getSystem(): Promise<SystemStatus>;
  getAdlScores(acct: Hex): Promise<AdlScore[]>;
  getSolvency(): Promise<SolvencyInfo>;
  getHealth(): Promise<ExchangeHealth>;
  getBackstop(market: number): Promise<BackstopStatus>;
  getWithdrawGate(acct: Hex): Promise<WithdrawGate>;
  /** null = this source cannot provide it (chain-only) */
  getPositionStats(acct: Hex): Promise<PositionStat[] | null>;
  getOrderHistory(acct: Hex): Promise<OrderRow[] | null>;
  getIndexerStatus(): Promise<IndexerStatus | null>;
}
