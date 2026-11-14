import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, exchangeAbi, manualOracleAbi } from "./abi.js";
import { decodePerpError } from "./errors.js";
import { signOrder, withDefaults, type SignOrderArgs } from "./signing.js";
import {
  MarketState,
  Tif,
  type AccountState,
  type BookSnapshot,
  type Conditional,
  type Deployment,
  type FillEvent,
  type IsoState,
  type MarketConfig,
  type OracleStatus,
  type OrderInput,
  type PlaceResult,
  type Position,
  type RestingOrder,
  type SignedOrder,
  type TwapStatus,
  type TxResult,
} from "./types.js";
import { assertValidOrder, slippagePrice } from "./units.js";

export interface PerpClientConfig {
  publicClient: PublicClient;
  /** Needed for writes. Its account is the tx sender (owner key, or an agent key). */
  walletClient?: WalletClient;
  exchange: Address;
  usdc?: Address;
  oracle?: Address;
  /** Master (fund-owning) address. Defaults to the wallet account; set it when the wallet is an AGENT key. */
  owner?: Address;
  /** default subaccount index (uint8) */
  sub?: number;
}

export interface TxOptions {
  /** subaccount override */
  sub?: number;
  /** gas override; default = estimate * 1.25 */
  gas?: bigint;
}

export interface PlaceOptions extends TxOptions {
  /** skip client-side tick/lot/min-notional validation (the contract still enforces it) */
  skipValidation?: boolean;
}

export interface MarketOrderInput {
  market: number;
  isBuy: boolean;
  size: bigint;
  /** max adverse slippage vs the reference price, default 50 bps */
  slippageBps?: number;
  /** reference price override (raw 1e6); default best opposite level, else mark */
  refPrice?: bigint;
  reduceOnly?: boolean;
  cloid?: bigint;
}

/** Random non-zero uint64 client order id (cloids are single-use per account, forever). */
export function newCloid(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  b[0] &= 0x7f;
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v === 0n ? 1n : v;
}

/** Subaccount key: keccak256(abi.encode(owner, sub)) - same as PerpBase.acctKey. */
export function acctKey(owner: Address, sub: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint8" }], [owner, sub]));
}

export function localChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: "perps-local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export class PerpClient {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly exchange: Address;
  readonly usdc?: Address;
  readonly oracle?: Address;
  /** master address whose funds trade */
  readonly owner: Address;
  /** address that sends transactions */
  readonly sender?: Address;
  readonly defaultSub: number;
  private cfgCache = new Map<number, MarketConfig>();
  private chainIdCache?: number;

  constructor(c: PerpClientConfig) {
    this.publicClient = c.publicClient;
    this.walletClient = c.walletClient;
    this.exchange = c.exchange;
    this.usdc = c.usdc;
    this.oracle = c.oracle;
    this.sender = c.walletClient?.account?.address;
    const owner = c.owner ?? this.sender;
    if (!owner) throw new Error("PerpClient needs a walletClient account or an explicit owner");
    this.owner = owner;
    this.defaultSub = c.sub ?? 0;
  }

  /** Convenience constructor from an RPC url + private key + deployment manifest. */
  static fromPrivateKey(o: {
    rpcUrl: string;
    privateKey: Hex;
    deployment: Deployment;
    owner?: Address;
    sub?: number;
  }): PerpClient {
    const chain = localChain(o.deployment.chainId, o.rpcUrl);
    const transport = http(o.rpcUrl);
    const account = privateKeyToAccount(o.privateKey);
    return new PerpClient({
      publicClient: createPublicClient({ chain, transport }) as PublicClient,
      walletClient: createWalletClient({ chain, transport, account }),
      exchange: o.deployment.exchange,
      usdc: o.deployment.usdc,
      oracle: o.deployment.oracle,
      owner: o.owner,
      sub: o.sub,
    });
  }

  /** Read-only client (no wallet). `owner` is required. */
  static readOnly(o: { rpcUrl: string; deployment: Deployment; owner: Address; sub?: number }): PerpClient {
    const chain = localChain(o.deployment.chainId, o.rpcUrl);
    return new PerpClient({
      publicClient: createPublicClient({ chain, transport: http(o.rpcUrl) }) as PublicClient,
      exchange: o.deployment.exchange,
      usdc: o.deployment.usdc,
      oracle: o.deployment.oracle,
      owner: o.owner,
      sub: o.sub,
    });
  }

  // ------------------------------------------------------------------ plumbing
  acct(sub: number = this.defaultSub, owner: Address = this.owner): Hex {
    return acctKey(owner, sub);
  }

  async chainId(): Promise<number> {
    return (this.chainIdCache ??= await this.publicClient.getChainId());
  }

  private read<T = any>(functionName: string, args: readonly unknown[] = [], address: Address = this.exchange, abi: readonly unknown[] = exchangeAbi): Promise<T> {
    return (this.publicClient as any).readContract({ address, abi, functionName, args });
  }

  private async send(
    functionName: string,
    args: readonly unknown[],
    opts: { gas?: bigint; address?: Address; abi?: readonly unknown[] } = {},
  ): Promise<{ result: TxResult; logs: any[] }> {
    const w = this.walletClient;
    if (!w?.account) throw new Error("this PerpClient has no wallet; cannot send transactions");
    const address = opts.address ?? this.exchange;
    const abi = opts.abi ?? exchangeAbi;
    try {
      let gas = opts.gas;
      if (gas === undefined) {
        const est: bigint = await (this.publicClient as any).estimateContractGas({ address, abi, functionName, args, account: w.account });
        gas = (est * 125n) / 100n;
      }
      const hash: Hex = await (w as any).writeContract({ address, abi, functionName, args, account: w.account, chain: w.chain, gas });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain (${functionName})`);
      const logs: any[] = parseEventLogs({ abi: exchangeAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === this.exchange.toLowerCase()), strict: false });
      return { result: { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed }, logs };
    } catch (e) {
      throw decodePerpError(e) ?? e;
    }
  }

  /** LOCAL DEMO ONLY: ManualOracle.set (owner-only). Does not exist on Chainlink/Pyth adapters. */
  async setManualOraclePrice(feed: Hex, price: bigint): Promise<TxResult> {
    if (!this.oracle) throw new Error("oracle address not configured");
    return (await this.send("set", [feed, price], { address: this.oracle, abi: manualOracleAbi })).result;
  }
  /** LOCAL DEMO ONLY: ManualOracle.owner(). */
  async manualOracleOwner(): Promise<Address> {
    if (!this.oracle) throw new Error("oracle address not configured");
    return this.read("owner", [], this.oracle, manualOracleAbi);
  }

  // ------------------------------------------------------------------ collateral
  /** USDC.approve(exchange, amount) (default: unlimited). */
  async approveUsdc(amount: bigint = maxUint256): Promise<TxResult> {
    if (!this.usdc) throw new Error("usdc address not configured");
    return (await this.send("approve", [this.exchange, amount], { address: this.usdc, abi: erc20Abi })).result;
  }
  async usdcBalance(who: Address = this.owner): Promise<bigint> {
    if (!this.usdc) throw new Error("usdc address not configured");
    return this.read("balanceOf", [who], this.usdc, erc20Abi);
  }
  async usdcAllowance(who: Address = this.owner): Promise<bigint> {
    if (!this.usdc) throw new Error("usdc address not configured");
    return this.read("allowance", [who, this.exchange], this.usdc, erc20Abi);
  }
  /** LOCAL DEMO ONLY: MockUSDC.mint is permissionless. Does not exist on real USDC. */
  async mintMockUsdc(to: Address, amount: bigint): Promise<TxResult> {
    if (!this.usdc) throw new Error("usdc address not configured");
    return (await this.send("mint", [to, amount], { address: this.usdc, abi: erc20Abi })).result;
  }
  /** Deposit `amount` raw USDC from the sender into `to`'s subaccount (default: own). Requires prior approval. */
  async deposit(amount: bigint, o: TxOptions & { to?: Address } = {}): Promise<TxResult> {
    return (await this.send("deposit", [o.to ?? this.owner, o.sub ?? this.defaultSub, amount], o)).result;
  }
  /** Owner only (agents cannot withdraw). Pays out to msg.sender. */
  async withdraw(amount: bigint, o: TxOptions = {}): Promise<TxResult> {
    return (await this.send("withdraw", [o.sub ?? this.defaultSub, amount], o)).result;
  }
  /** Move free collateral between two subaccounts of the sender. */
  async transferInternal(fromSub: number, toSub: number, amount: bigint, o: Pick<TxOptions, "gas"> = {}): Promise<TxResult> {
    return (await this.send("transferInternal", [fromSub, toSub, amount], o)).result;
  }

  // ------------------------------------------------------------------ orders
  private async buildParams(o: OrderInput, opts: PlaceOptions) {
    const p = withDefaults(o);
    if (!opts.skipValidation) assertValidOrder(await this.marketConfig(p.market), p);
    return p;
  }

  private summarize(res: { result: TxResult; logs: any[] }, acct: Hex): PlaceResult {
    const accepted = res.logs.find((l) => l.eventName === "OrderAccepted" && l.args.acct === acct);
    const fills: FillEvent[] = res.logs.filter((l) => l.eventName === "Fill" && l.args.taker === acct).map((l) => ({ ...(l.args as any), txHash: res.result.hash }));
    return { ...res.result, orderId: accepted ? accepted.args.id : 0n, filled: fills.reduce((s, f) => s + f.size, 0n), fills };
  }

  /** Place a limit order (any TIF). All numeric inputs are raw units (see units.ts helpers). */
  async placeOrder(o: OrderInput, opts: PlaceOptions = {}): Promise<PlaceResult> {
    const p = await this.buildParams(o, opts);
    const sub = opts.sub ?? this.defaultSub;
    return this.summarize(await this.send("placeOrder", [this.owner, sub, p], opts), this.acct(sub));
  }

  /** Market order implemented as IOC at a slippage-bounded limit price. */
  async marketOrder(m: MarketOrderInput, opts: PlaceOptions = {}): Promise<PlaceResult> {
    const cfg = await this.marketConfig(m.market);
    const ref = m.refPrice ?? (await this.referencePrice(m.market, m.isBuy));
    const price = slippagePrice(m.isBuy, ref, m.slippageBps ?? 50, cfg.tick);
    return this.placeOrder({ market: m.market, isBuy: m.isBuy, price, size: m.size, tif: Tif.IOC, reduceOnly: m.reduceOnly, cloid: m.cloid }, opts);
  }

  /** Best opposite-side price, else the exchange mark. */
  async referencePrice(market: number, isBuy: boolean): Promise<bigint> {
    const top = await this.bestPrice(market, !isBuy);
    return top > 0n ? top : this.markPrice(market);
  }

  async cancelOrder(orderId: bigint, o: Pick<TxOptions, "gas"> = {}): Promise<TxResult> {
    return (await this.send("cancelOrder", [orderId], o)).result;
  }
  /** Cancels every resting order of the subaccount (bounded by MAX_OPEN_ORDERS = 32). */
  async cancelAll(o: TxOptions = {}): Promise<TxResult> {
    return (await this.send("cancelAll", [this.owner, o.sub ?? this.defaultSub], o)).result;
  }
  /** Atomic cancel + new order (loses time priority). */
  async replaceOrder(oldId: bigint, o: OrderInput, opts: PlaceOptions = {}): Promise<PlaceResult> {
    const p = await this.buildParams(o, opts);
    const acct = (await this.getOrder(oldId))?.acct ?? this.acct(opts.sub);
    return this.summarize(await this.send("replaceOrder", [oldId, p], opts), acct);
  }

  // ------------------------------------------------------------------ EIP-712 signed orders
  /** Sign an order with this client's wallet account (owner or agent). Does not send a transaction. */
  async signOrder(order: OrderInput, o: { sub?: number; nonce?: bigint; deadline?: bigint } = {}): Promise<SignedOrder> {
    const w = this.walletClient;
    if (!w?.account) throw new Error("no wallet to sign with");
    return signOrder({
      owner: this.owner,
      sub: o.sub ?? this.defaultSub,
      order,
      chainId: await this.chainId(),
      exchange: this.exchange,
      signer: { walletClient: w, account: w.account },
      nonce: o.nonce,
      // use CHAIN time (dev chains drift ahead of wall-clock when many blocks are mined)
      deadline: o.deadline ?? (await this.chainTime()) + 600n,
    });
  }
  /** Relay a signed order. Anyone can relay; the contract checks the signature against owner / approved agents. */
  async placeSigned(s: SignedOrder, opts: TxOptions = {}): Promise<PlaceResult> {
    return this.summarize(await this.send("placeSigned", [s.owner, s.sub, s.params, s.nonce, s.deadline, s.signature], opts), this.acct(s.sub, s.owner));
  }
  async isNonceUsed(owner: Address, nonce: bigint): Promise<boolean> {
    return this.read("nonceUsed", [owner, nonce]);
  }
  /** Standalone helper re-exported for relayers / signers without a PerpClient. */
  static signOrder(a: SignOrderArgs): Promise<SignedOrder> {
    return signOrder(a);
  }

  // ------------------------------------------------------------------ agent keys
  /** Authorise a trading-only key until unix-seconds `expiry`. Agents can trade/cancel but never withdraw or transfer. */
  async approveAgent(agent: Address, expiry: bigint, o: TxOptions = {}): Promise<TxResult> {
    return (await this.send("approveAgent", [o.sub ?? this.defaultSub, agent, expiry], o)).result;
  }
  /** Like approveAgent but expires `ttlSecs` after CHAIN time (dev chains drift far ahead of wall-clock). */
  async approveAgentFor(agent: Address, ttlSecs: number, o: TxOptions = {}): Promise<TxResult> {
    return this.approveAgent(agent, (await this.chainTime()) + BigInt(ttlSecs), o);
  }
  async revokeAgent(agent: Address, o: TxOptions = {}): Promise<TxResult> {
    return (await this.send("revokeAgent", [o.sub ?? this.defaultSub, agent], o)).result;
  }
  async agentExpiry(agent: Address, sub: number = this.defaultSub): Promise<bigint> {
    return this.read("agentExpiry", [this.acct(sub), agent]);
  }

  // ------------------------------------------------------------------ conditional / bracket
  /**
   * Stop/TP order stored on-chain and fired by anyone (`executeConditional`) once mark crosses `trigger`.
   * `above=true` fires when mark >= trigger. Executes as IOC at `limit`.
   * Returns the conditional id.
   */
  async placeConditional(c: { market: number; isBuy: boolean; above: boolean; trigger: bigint; limit: bigint; size: bigint; reduceOnly?: boolean }, o: TxOptions = {}): Promise<bigint> {
    const { logs, result } = await this.send("placeConditional", [this.owner, o.sub ?? this.defaultSub, c.market, c.isBuy, c.above, c.trigger, c.limit, c.size, c.reduceOnly ?? true], o);
    void result;
    return (logs.find((l: any) => l.eventName === "CondPlaced") as any).args.id;
  }
  /** TP+SL OCO pair for the current position (reverts ReduceOnlyViolation when flat). */
  async placeBracket(b: { market: number; tpTrigger: bigint; tpLimit: bigint; slTrigger: bigint; slLimit: bigint; size: bigint }, o: TxOptions = {}): Promise<{ tpId: bigint; slId: bigint } & TxResult> {
    const { logs, result } = await this.send("placeBracket", [this.owner, o.sub ?? this.defaultSub, b.market, b.tpTrigger, b.tpLimit, b.slTrigger, b.slLimit, b.size], o);
    const ids = logs.filter((l: any) => l.eventName === "CondPlaced").map((l: any) => l.args.id as bigint);
    return { ...result, tpId: ids[0]!, slId: ids[1]! };
  }
  async cancelConditional(id: bigint): Promise<TxResult> {
    return (await this.send("cancelConditional", [id])).result;
  }
  /** Keeper call (permissionless): fires the conditional if the mark has crossed its trigger. */
  async executeConditional(id: bigint): Promise<TxResult> {
    return (await this.send("executeConditional", [id])).result;
  }
  async getConditional(id: bigint): Promise<Conditional> {
    const r = await this.read<readonly any[]>("conds", [id]);
    return { id, acct: r[0], size: r[1], trigger: r[2], limit: r[3], sibling: r[4], market: r[5], isBuy: r[6], above: r[7], reduceOnly: r[8], active: r[9] };
  }

  // ------------------------------------------------------------------ TWAP
  /** Parent TWAP; slices are IOC children fired by permissionless keepers via executeTwapSlice (timing NOT guaranteed). */
  async placeTwap(t: { market: number; isBuy: boolean; total: bigint; slices: number; intervalSecs: number; slippageBps?: number; reduceOnly?: boolean }, o: TxOptions = {}): Promise<bigint> {
    const { logs } = await this.send("placeTwap", [this.owner, o.sub ?? this.defaultSub, t.market, t.isBuy, t.total, t.slices, t.intervalSecs, t.slippageBps ?? 50, t.reduceOnly ?? false], o);
    return (logs.find((l: any) => l.eventName === "TwapPlaced") as any).args.id;
  }
  async cancelTwap(id: bigint): Promise<TxResult> {
    return (await this.send("cancelTwap", [id])).result;
  }
  /** Keeper call. Reverts BadParam("too early") before nextTime. */
  async executeTwapSlice(id: bigint): Promise<TxResult> {
    return (await this.send("executeTwapSlice", [id])).result;
  }
  async twapStatus(id: bigint): Promise<TwapStatus> {
    const t: any = await this.read("twapStatus", [id]);
    return { id, acct: t.acct, total: t.total, filled: t.filled, nextTime: t.nextTime, interval: Number(t.interval), slippageBps: Number(t.slippageBps), slices: Number(t.slices), done: Number(t.done), failed: Number(t.failed), market: Number(t.market), isBuy: t.isBuy, reduceOnly: t.reduceOnly, active: t.active };
  }

  // ------------------------------------------------------------------ isolated margin
  /** Switch a market to isolated (or back to cross). Only when flat, no resting orders in that market. */
  async setIsolated(market: number, on: boolean, o: TxOptions = {}): Promise<TxResult> {
    return (await this.send("setIsolated", [o.sub ?? this.defaultSub, market, on], o)).result;
  }
  /** Owner only: move free cross collateral into the isolated bucket. */
  async addIsoMargin(market: number, amount: bigint, o: TxOptions = {}): Promise<TxResult> {
    return (await this.send("addIsoMargin", [o.sub ?? this.defaultSub, market, amount], o)).result;
  }
  async removeIsoMargin(market: number, amount: bigint, o: TxOptions = {}): Promise<TxResult> {
    return (await this.send("removeIsoMargin", [o.sub ?? this.defaultSub, market, amount], o)).result;
  }
  async isoState(market: number, sub: number = this.defaultSub, owner: Address = this.owner): Promise<IsoState> {
    const r = await this.read<readonly any[]>("isoState", [this.acct(sub, owner), market]);
    return { isolated: r[0], margin: r[1], equity: r[2], initialMargin: r[3], maintenanceMargin: r[4], reserved: r[5] };
  }

  // ------------------------------------------------------------------ keeper calls (permissionless)
  /** Liquidate `acct`'s position in `market`; the sender's subaccount 0 receives the keeper fee share. Reverts NotLiquidatable if healthy. */
  async liquidate(acct: Hex, market: number): Promise<TxResult> {
    return (await this.send("liquidate", [acct, market])).result;
  }
  /** Cross: equity < maintenance margin; isolated market: iso equity < iso MM. False if no position. */
  async isLiquidatable(acct: Hex, market: number): Promise<boolean> {
    const p = await this.getPosition(acct, market);
    if (p.size === 0n) return false;
    if (p.isolated) {
      const r = await this.read<readonly any[]>("isoState", [acct, market]);
      return (r[2] as bigint) < (r[4] as bigint);
    }
    const s = await this.accountStateByKey(acct);
    return s.equity < s.maintenanceMargin;
  }
  /** Funding sample/settle. Call at least once per fundingInterval per market. */
  async pokeFunding(market: number): Promise<TxResult> {
    return (await this.send("pokeFunding", [market])).result;
  }
  async adlScore(acct: Hex, market: number): Promise<bigint> {
    return this.read("adlScore", [acct, market]);
  }
  async adlDebt(market: number): Promise<bigint> {
    return this.read("adlDebt", [market]);
  }
  /** `targets` MUST be sorted by descending adlScore (ties: descending key) - the contract reverts "not ranked". */
  async adl(targets: Hex[], market: number): Promise<TxResult> {
    return (await this.send("adl", [targets, market])).result;
  }
  /**
   * Permissionless. Records the loss of a FLAT, NEGATIVE bucket (isolated margin of `market`, or cross collateral when the account
   * holds no cross position): insurance first, the rest becomes unresolved bad debt / `adlDebt(market)`. Pays no reward. Reverts
   * `BadParam("nothing to write off")` for healthy or non-negative buckets. Emits `BadDebtUnresolved` when insurance is short.
   */
  async writeOff(acct: Hex, market: number): Promise<TxResult> {
    return (await this.send("writeOff", [acct, market])).result;
  }
  /** Repay `amount` of the market's ADL debt with fresh USDC (requires approval). */
  async recapitalize(market: number, amount: bigint): Promise<TxResult> {
    return (await this.send("recapitalize", [market, amount])).result;
  }

  /**
   * Permissionless and idempotent. Records the backstop's mark-to-market deficit (insurance first, the rest as unresolved bad debt /
   * `adlDebt` / `bsDebt`) or, with positive equity, repays earlier draws. `withdraw`, `liquidate`, `adl` and `settleDelisted` also sync
   * internally. Call it periodically and after oracle updates while the backstop holds inventory. Emits `BackstopSynced`.
   */
  async syncBackstop(): Promise<TxResult> {
    return (await this.send("syncBackstop", [])).result;
  }
  /** Backstop equity (signed, micro-USDC) as `syncBackstop` would see it now. Negative = an unrecorded deficit. */
  async backstopEquity(): Promise<bigint> {
    return this.read("backstopEquity");
  }
  /** ADL eligibility view: a target needs `eq > mm` (slack) or `adl` skips it with `AdlSkipped`. `adlScore` is 0 when `eq <= 0`. */
  async adlHealth(acct: Hex, market: number): Promise<{ equity: bigint; maintenance: bigint; slack: bigint }> {
    const r = await this.read<readonly [bigint, bigint]>("adlHealth", [acct, market]);
    const slack = r[0] > r[1] ? r[0] - r[1] : 0n;
    return { equity: r[0], maintenance: r[1], slack };
  }
  /** Insurance drawn for backstop deficits and not yet refunded (micro-USDC). */
  async bsInsDrawn(): Promise<bigint> {
    return this.read("bsInsDrawn");
  }
  /** Part of `unresolvedBadDebt` that arose from backstop deficits (micro-USDC). */
  async bsDebt(): Promise<bigint> {
    return this.read("bsDebt");
  }
  async unresolvedBadDebt(): Promise<bigint> {
    return this.read("unresolvedBadDebt");
  }
  /** ADL premium ceiling (bps of mark) while `bsDebt > 0`; default 10000. */
  async adlHardPremBps(): Promise<number> {
    return Number(await this.read<number>("adlHardPremBps"));
  }
  /** Withdrawal limiter threshold (micro-USDC): active while `unresolvedBadDebt` exceeds it. Default 100e6. */
  async wdGateThreshold(): Promise<bigint> {
    return this.read("wdGateThreshold");
  }
  /** Deposited (not earned) collateral of `acct` still withdrawable while the limiter is active. */
  async principal(acct: Hex): Promise<bigint> {
    return this.read("principal", [acct]);
  }
  /** True while the withdrawal limiter is active (`unresolvedBadDebt > wdGateThreshold`). Withdrawals above `principal(acct)` revert `WithdrawGated`. */
  async withdrawGateActive(): Promise<boolean> {
    const [d, t] = await Promise.all([this.unresolvedBadDebt(), this.wdGateThreshold()]);
    return d > t;
  }

  // ------------------------------------------------------------------ admin (role-gated; included for local demos/ops)
  async setMarketState(market: number, state: MarketState): Promise<TxResult> {
    return (await this.send("setMarketState", [market, state])).result;
  }

  /** Admin (DEFAULT_ADMIN_ROLE) may set any value <= 10000; the GUARDIAN may only LOWER it. Ceiling on the ADL premium while backstop debt is outstanding. */
  async setAdlHardPremBps(bps: number): Promise<TxResult> {
    return (await this.send("setAdlHardPremBps", [bps])).result;
  }
  /** Admin: any value (max uint256 disables the limiter). GUARDIAN: may only LOWER (tighten) it. Micro-USDC. */
  async setWithdrawGate(threshold: bigint): Promise<TxResult> {
    return (await this.send("setWithdrawGate", [threshold])).result;
  }

  // ------------------------------------------------------------------ reads
  async marketCount(): Promise<number> {
    return Number(await this.read<number>("marketCount"));
  }

  /** Full market config + live state. Tick/lot are cached; call with fresh=true to bypass. */
  async marketConfig(id: number, fresh = false): Promise<MarketConfig> {
    if (!fresh && this.cfgCache.has(id)) {
      const cached = this.cfgCache.get(id)!;
      return cached;
    }
    const m = await this.read<any>("getMarket", [id]);
    const cfg: MarketConfig = {
      id,
      exists: m.exists,
      state: m.state as MarketState,
      feed: m.feed,
      tick: m.tick,
      lot: m.lot,
      minNotional: m.minNotional,
      maxOrderSize: m.maxOrderSize,
      maxOI: m.maxOI,
      oi: m.oi,
      maxAge: Number(m.maxAge),
      bandBps: Number(m.bandBps),
      maxSpreadBps: Number(m.maxSpreadBps),
      fundingInterval: Number(m.fundingInterval),
      premiumDivisor: Number(m.premiumDivisor),
      fundingCap: m.fundingCap,
      fundingIndex: m.fundingIndex,
      lastFunding: m.lastFunding,
      lastIndexPrice: m.lastIndexPrice,
      lastTradePrice: m.lastTradePrice,
      tiers: m.tiers.map((t: any) => ({ upToNotional: t.upToNotional, imrBps: Number(t.imrBps), mmrBps: Number(t.mmrBps) })),
    };
    this.cfgCache.set(id, cfg);
    return cfg;
  }
  /** All markets, fresh (state/OI are live). */
  async markets(): Promise<MarketConfig[]> {
    const n = await this.marketCount();
    return Promise.all(Array.from({ length: n }, (_, i) => this.marketConfig(i, true)));
  }
  /** Exchange mark. Reverts with PerpError OracleDegraded when the oracle is stale/missing. */
  async markPrice(market: number): Promise<bigint> {
    try {
      return await this.read<bigint>("markPrice", [market]);
    } catch (e) {
      throw decodePerpError(e) ?? e;
    }
  }
  async bestPrice(market: number, isBuy: boolean): Promise<bigint> {
    return this.read<bigint>("bestPrice", [market, isBuy]);
  }
  async bookSnapshot(market: number, depth = 10): Promise<BookSnapshot> {
    const [b, a] = await Promise.all([this.read<readonly [readonly bigint[], readonly bigint[]]>("bookSnapshot", [market, true, BigInt(depth)]), this.read<readonly [readonly bigint[], readonly bigint[]]>("bookSnapshot", [market, false, BigInt(depth)])]);
    const lv = (r: readonly [readonly bigint[], readonly bigint[]]) => r[0].map((price, i) => ({ price, size: r[1][i]! })).filter((l) => l.price > 0n);
    return { market, bids: lv(b), asks: lv(a) };
  }
  async accountState(sub: number = this.defaultSub, owner: Address = this.owner): Promise<AccountState> {
    return this.accountStateByKey(this.acct(sub, owner));
  }
  async accountStateByKey(acct: Hex): Promise<AccountState> {
    const r = await this.read<readonly bigint[]>("accountState", [acct]);
    return { equity: r[0]!, initialMargin: r[1]!, maintenanceMargin: r[2]!, reservedOrderMargin: r[3]!, available: r[4]! };
  }
  async collateral(sub: number = this.defaultSub, owner: Address = this.owner): Promise<bigint> {
    return this.read("collateral", [this.acct(sub, owner)]);
  }
  async withdrawable(sub: number = this.defaultSub): Promise<bigint> {
    return this.read("withdrawable", [this.acct(sub)]);
  }
  async getPosition(acct: Hex, market: number): Promise<Position> {
    const r = await this.read<readonly any[]>("positions", [acct, market]);
    return { market, size: r[0], basis: r[1], lastFundingIdx: r[2], isolated: r[3], isoMargin: r[4], isoReserved: r[5] };
  }
  /** All non-flat positions of a subaccount. */
  async positions(sub: number = this.defaultSub, owner: Address = this.owner): Promise<Position[]> {
    const acct = this.acct(sub, owner);
    const n = await this.marketCount();
    const all = await Promise.all(Array.from({ length: n }, (_, i) => this.getPosition(acct, i)));
    return all.filter((p) => p.size !== 0n || p.isoMargin !== 0n);
  }
  async getOrder(id: bigint): Promise<RestingOrder | undefined> {
    const r = await this.read<readonly any[]>("orders", [id]);
    if (r[1] === 0n) return undefined;
    return { id, acct: r[0], size: r[1], reserve: r[2], price: r[3], expiry: r[4], cloid: r[7], market: Number(r[8]), isBuy: r[9], reduceOnly: r[10] };
  }
  async openOrders(sub: number = this.defaultSub, owner: Address = this.owner): Promise<RestingOrder[]> {
    const ids = await this.read<readonly bigint[]>("openOrderIds", [this.acct(sub, owner)]);
    const os = await Promise.all(ids.map((id) => this.getOrder(id)));
    return os.filter((o): o is RestingOrder => !!o);
  }
  /** Oracle (index) price and freshness vs the market's maxAge, using pending-block time. */
  async oracleStatus(market: number): Promise<OracleStatus> {
    if (!this.oracle) throw new Error("oracle address not configured");
    const cfg = await this.marketConfig(market);
    const [price, updatedAt] = (await this.read<readonly bigint[]>("latest", [cfg.feed], this.oracle, manualOracleAbi)) as readonly [bigint, bigint];
    const now = await this.chainTime();
    const ageSec = Number(now - updatedAt);
    return { price, updatedAt, ageSec, maxAge: cfg.maxAge, fresh: price > 0n && ageSec >= 0 && ageSec <= cfg.maxAge };
  }
  /** Seconds timestamp the next block would have (pending), falling back to latest. */
  async chainTime(): Promise<bigint> {
    try {
      return (await this.publicClient.getBlock({ blockTag: "pending" })).timestamp;
    } catch {
      return (await this.publicClient.getBlock()).timestamp;
    }
  }

  /** Historical Fill events (optionally only those involving `acct` as maker or taker). */
  async getFills(o: { fromBlock?: bigint; toBlock?: bigint; acct?: Hex } = {}): Promise<FillEvent[]> {
    const logs = await (this.publicClient as any).getContractEvents({ address: this.exchange, abi: exchangeAbi, eventName: "Fill", fromBlock: o.fromBlock ?? 0n, toBlock: o.toBlock ?? "latest" });
    return logs
      .map((l: any) => ({ ...l.args, market: Number(l.args.market), blockNumber: l.blockNumber, txHash: l.transactionHash }) as FillEvent)
      .filter((f: FillEvent) => !o.acct || f.maker === o.acct || f.taker === o.acct);
  }
  /** Subscribes to Fill events via polling/WS (viem watchContractEvent). Returns unwatch. */
  watchFills(cb: (f: FillEvent) => void): () => void {
    return (this.publicClient as any).watchContractEvent({
      address: this.exchange,
      abi: exchangeAbi,
      eventName: "Fill",
      onLogs: (logs: any[]) => logs.forEach((l) => cb({ ...l.args, market: Number(l.args.market), blockNumber: l.blockNumber, txHash: l.transactionHash })),
    });
  }
}
