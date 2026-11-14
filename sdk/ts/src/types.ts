import type { Address, Hex } from "viem";

/** Time in force. Matches PerpBase.TIF. */
export enum Tif {
  GTC = 0,
  IOC = 1,
  FOK = 2,
  PostOnly = 3,
}

/** Matches PerpBase.State. */
export enum MarketState {
  Normal = 0,
  ReduceOnly = 1,
  OracleDegraded = 2,
  Paused = 3,
  Recovery = 4,
}

/** Matches PerpBase.CancelReason. */
export enum CancelReason {
  User = 0,
  Expired = 1,
  SelfTrade = 2,
  InvalidReduceOnly = 3,
  MakerMargin = 4,
  Filled = 5,
  Liquidation = 6,
  Replaced = 7,
  /** Resting order's price was outside index +/- bandBps when it would have matched (WASH-1); the maker order is cancelled, matching continues. */
  PriceBand = 8,
}

/** Plain-language text for an `OrderCanceled` reason (unknown future values fall back to a generic message). */
export function cancelReasonText(r: number): string {
  switch (r) {
    case CancelReason.User: return "Order cancelled by you";
    case CancelReason.Expired: return "Order cancelled: it expired";
    case CancelReason.SelfTrade: return "Order cancelled: it would have traded against your own order";
    case CancelReason.InvalidReduceOnly: return "Order cancelled: it would have increased your position";
    case CancelReason.MakerMargin: return "Order cancelled: not enough margin to keep it open";
    case CancelReason.Filled: return "Order filled";
    case CancelReason.Liquidation: return "Order cancelled by a liquidation";
    case CancelReason.Replaced: return "Order replaced";
    case CancelReason.PriceBand: return "Order cancelled: its price was too far from the oracle price";
    default: return `Order cancelled (reason ${r})`;
  }
}

/** On-chain OrderParams. ALL numbers are RAW integer units: price 1e6, size 1e8. */
export interface OrderParams {
  market: number;
  isBuy: boolean;
  /** raw price (1e6 USDC per 1 base unit). Must be a multiple of the market tick. */
  price: bigint;
  /** raw size (1e8 per base unit). Must be a multiple of the market lot. */
  size: bigint;
  tif: Tif;
  reduceOnly: boolean;
  /** client order id; 0 = none; unique per account while non-zero (never reusable). */
  cloid: bigint;
  /** unix seconds; 0 = none. */
  expiry: bigint;
}

/** Order input with defaults: tif=GTC, reduceOnly=false, cloid=0, expiry=0. */
export type OrderInput = Pick<OrderParams, "market" | "isBuy" | "price" | "size"> &
  Partial<Pick<OrderParams, "tif" | "reduceOnly" | "cloid" | "expiry">>;

export interface MarketConfig {
  id: number;
  exists: boolean;
  state: MarketState;
  feed: Hex;
  tick: bigint;
  lot: bigint;
  minNotional: bigint;
  maxOrderSize: bigint;
  maxOI: bigint;
  oi: bigint;
  maxAge: number;
  bandBps: number;
  maxSpreadBps: number;
  fundingInterval: number;
  premiumDivisor: number;
  fundingCap: bigint;
  fundingIndex: bigint;
  lastFunding: bigint;
  lastIndexPrice: bigint;
  lastTradePrice: bigint;
  tiers: { upToNotional: bigint; imrBps: number; mmrBps: number }[];
}

export interface AccountState {
  equity: bigint;
  initialMargin: bigint;
  maintenanceMargin: bigint;
  reservedOrderMargin: bigint;
  available: bigint;
}

export interface IsoState {
  isolated: boolean;
  margin: bigint;
  equity: bigint;
  initialMargin: bigint;
  maintenanceMargin: bigint;
  reserved: bigint;
}

export interface Position {
  market: number;
  size: bigint;
  basis: bigint;
  lastFundingIdx: bigint;
  isolated: boolean;
  isoMargin: bigint;
  isoReserved: bigint;
}

export interface BookLevel {
  price: bigint;
  size: bigint;
}
export interface BookSnapshot {
  market: number;
  /** best (highest) first */
  bids: BookLevel[];
  /** best (lowest) first */
  asks: BookLevel[];
}

export interface RestingOrder {
  id: bigint;
  acct: Hex;
  size: bigint;
  reserve: bigint;
  price: bigint;
  expiry: bigint;
  cloid: bigint;
  market: number;
  isBuy: boolean;
  reduceOnly: boolean;
}

export interface Conditional {
  id: bigint;
  acct: Hex;
  size: bigint;
  trigger: bigint;
  limit: bigint;
  sibling: bigint;
  market: number;
  isBuy: boolean;
  above: boolean;
  reduceOnly: boolean;
  active: boolean;
}

export interface TwapStatus {
  id: bigint;
  acct: Hex;
  total: bigint;
  filled: bigint;
  nextTime: bigint;
  interval: number;
  slippageBps: number;
  slices: number;
  done: number;
  failed: number;
  market: number;
  isBuy: boolean;
  reduceOnly: boolean;
  active: boolean;
}

export interface FillEvent {
  tradeId: bigint;
  market: number;
  makerOrderId: bigint;
  maker: Hex;
  taker: Hex;
  takerIsBuy: boolean;
  price: bigint;
  size: bigint;
  takerFee: bigint;
  makerFee: bigint;
  blockNumber?: bigint;
  txHash?: Hex;
}

export interface OracleStatus {
  price: bigint;
  updatedAt: bigint;
  /** seconds between chain time and the oracle's last update */
  ageSec: number;
  maxAge: number;
  fresh: boolean;
}

/** Deployment manifest written by contracts/scripts/deploy.js. */
export interface Deployment {
  env?: string;
  chainId: number;
  usdc: Address;
  oracle: Address;
  exchange: Address;
  feeds: Record<string, Hex>;
  marketIds: Record<string, number>;
}

export interface TxResult {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface PlaceResult extends TxResult {
  /** order id assigned by the exchange (OrderAccepted) */
  orderId: bigint;
  /** total size filled immediately as taker */
  filled: bigint;
  fills: FillEvent[];
}

export interface SignedOrder {
  owner: Address;
  sub: number;
  params: OrderParams;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
  /** address that produced the signature (owner or an approved agent) */
  signer: Address;
}
