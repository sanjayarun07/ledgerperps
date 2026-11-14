/** SIMULATED LIQUIDITY - NOT REAL. One market-maker bot for one market. */
import { PerpClient, PerpError, Tif, fromPrice, fromSize, newCloid, notionalFloor, type MarketConfig } from "@perps/sdk";
import { computeQuotes, planActions, stopReason, type Action, type DesiredQuote, type ExistingQuote, type QuoteConfig, type Side } from "./quotes.js";
import { ts } from "./config.js";

export interface BotOptions {
  name: string;
  market: number;
  marketName: string;
  quote: QuoteConfig;
  bidSub: number;
  askSub: number;
  /** stop quoting if the oracle's last update is older than this (<= contract maxAge) */
  oracleStaleSec: number;
  /** on-chain expiry for quotes (seconds); quotes die by themselves if the bot dies */
  quoteTtlSec: number;
  /** stop quoting a subaccount if free collateral drops below this raw USDC */
  minAvailable: bigint;
  /** GTC (default) or PostOnly (use only once PostOnly orders rest on the deployed contract) */
  tif?: Tif;
  log?: (msg: string) => void;
}

export interface BotStats {
  ticks: number;
  placed: number;
  replaced: number;
  cancelled: number;
  pulls: number;
  errors: number;
  lastMid: bigint;
  lastReason?: string;
  quoting: boolean;
}

export class MarketMakerBot {
  readonly stats: BotStats = { ticks: 0, placed: 0, replaced: 0, cancelled: 0, pulls: 0, errors: 0, lastMid: 0n, quoting: false };
  private placedAt = new Map<bigint, number>();
  private cfg?: MarketConfig;
  private log: (m: string) => void;
  private twoSub: boolean;
  // oracle liveness watchdog (wall-clock): chain time races ahead of wall time on an automining dev node
  // (every block advances it >= 1s), so oracle age in CHAIN seconds is meaningless for a liveness check there.
  private oracleSeenAt = 0n;
  private oracleChangedWallMs = Date.now();

  get name(): string {
    return this.o.name;
  }

  constructor(private client: PerpClient, private o: BotOptions) {
    this.twoSub = o.bidSub !== o.askSub;
    this.log = o.log ?? ((m) => console.log(`${ts()} [${o.name}/${o.marketName}] ${m}`));
  }

  private subFor(side: Side): number {
    return side === "bidSub" ? this.o.bidSub : this.o.askSub;
  }
  private subs(): number[] {
    return this.twoSub ? [this.o.bidSub, this.o.askSub] : [this.o.bidSub];
  }

  /**
   * Cancel this market's quotes on both side-sets. Safe in every market state. `cancelAll` on-chain is per
   * SUBACCOUNT (not per market), so by default only this market's orders are cancelled one by one; pass
   * `everything=true` (shutdown) to use the single cancelAll call.
   */
  async pullAll(reason: string, everything = false): Promise<void> {
    let any = false;
    for (const s of this.subs()) {
      const open = (await this.client.openOrders(s)).filter((x) => x.market === this.o.market);
      if (open.length) {
        any = true;
        if (everything) await this.client.cancelAll({ sub: s });
        else for (const r of open) await this.client.cancelOrder(r.id).catch((e) => this.log(`pull: cancel ${r.id} skipped (${(e as Error).message.split("\n")[0]})`));
        this.stats.cancelled += open.length;
      }
    }
    this.placedAt.clear();
    if (any) {
      this.stats.pulls++;
      this.log(`PULLED all quotes: ${reason}`);
    }
    this.stats.quoting = false;
    this.stats.lastReason = reason;
  }

  /** One decision cycle. Never throws on expected on-chain conditions. */
  async tick(): Promise<void> {
    const c = this.client;
    const o = this.o;
    this.stats.ticks++;
    try {
      this.cfg = await c.marketConfig(o.market, true);
      let oracle;
      let markOk = true;
      try {
        oracle = await c.oracleStatus(o.market);
        await c.markPrice(o.market);
      } catch (e) {
        markOk = false;
        oracle = oracle ?? { price: 0n, ageSec: 1e9, fresh: false, updatedAt: 0n, maxAge: this.cfg.maxAge };
        if (!(e instanceof PerpError)) throw e;
      }
      if (oracle.updatedAt !== this.oracleSeenAt) {
        this.oracleSeenAt = oracle.updatedAt;
        this.oracleChangedWallMs = Date.now();
      }
      // "observed" liveness: seconds of WALL time since the oracle's updatedAt last changed (ManualOracle demo feed).
      const observedAgeSec = Math.floor((Date.now() - this.oracleChangedWallMs) / 1000);
      const stop = stopReason({ marketState: this.cfg.state, oracleFresh: oracle.fresh, oracleAgeSec: observedAgeSec, staleSec: o.oracleStaleSec, markOk });
      if (stop) {
        await this.pullAll(stop);
        return;
      }
      // collateral gate
      for (const s of this.subs()) {
        const st = await c.accountState(s);
        if (st.available < o.minAvailable) {
          await this.pullAll(`sub ${s} available collateral ${st.available} below floor`);
          return;
        }
      }
      const mid = oracle.price;
      this.stats.lastMid = mid;
      const pos = async (s: number) => (await c.getPosition(c.acct(s), o.market)).size;
      const posBid = await pos(o.bidSub);
      const posAsk = this.twoSub ? await pos(o.askSub) : posBid;
      const net = this.twoSub ? posBid + posAsk : posBid;
      const desired = computeQuotes(o.quote, {
        mid, netInventory: net, posBidSub: posBid, posAskSub: posAsk, twoSub: this.twoSub,
        tick: this.cfg.tick, lot: this.cfg.lot, minNotional: this.cfg.minNotional,
        bandBps: this.cfg.bandBps,
      });
      // existing quotes
      const nowMs = Date.now();
      const existing: ExistingQuote[] = [];
      for (const s of this.subs()) {
        for (const r of await c.openOrders(s)) {
          if (r.market !== o.market) continue;
          const from: Side = this.twoSub ? (s === o.bidSub ? "bidSub" : "askSub") : r.isBuy ? "bidSub" : "askSub";
          if (!this.placedAt.has(r.id)) this.placedAt.set(r.id, nowMs);
          existing.push({ id: r.id, from, isBuy: r.isBuy, price: r.price, size: r.size, reduceOnly: r.reduceOnly, placedAtMs: this.placedAt.get(r.id)! });
        }
      }
      // forget ids that no longer rest (filled / expired / cancelled)
      const live = new Set(existing.map((e) => e.id));
      for (const id of [...this.placedAt.keys()]) if (!live.has(id)) this.placedAt.delete(id);

      const actions = planActions(o.quote, existing, desired, nowMs);
      this.stats.quoting = true;
      this.stats.lastReason = undefined;
      if (actions.length === 0) return;
      // cancels first (frees margin and removes anything that could sit across a refreshed opposite quote)
      for (const a of actions) if (a.kind === "cancel") await this.doCancel(a, existing);
      // stale replacements: cancel the old one, then place fresh (two steps keep PostOnly failures from leaving stale quotes)
      for (const a of actions) {
        if (a.kind !== "replace") continue;
        const old = existing.find((e) => e.id === a.id)!;
        await this.doCancel({ kind: "cancel", id: a.id, from: old.from, reason: a.reason }, existing);
      }
      for (const a of actions) {
        if (a.kind === "place") await this.doPlace(a.to);
        else if (a.kind === "replace") await this.doPlace(a.to, true);
      }
      this.log(
        `mid=${fromPrice(mid)} net=${fromSize(net)} desired=${desired.length} actions: ` +
          `${actions.filter((a) => a.kind === "place").length} place, ${actions.filter((a) => a.kind === "replace").length} replace, ${actions.filter((a) => a.kind === "cancel").length} cancel`,
      );
    } catch (e) {
      this.stats.errors++;
      const pe = e instanceof PerpError ? e : undefined;
      this.log(`tick error: ${pe ? pe.message : (e as Error).message?.split("\n")[0]}`);
      if (pe && (pe.errorName === "OracleDegraded" || pe.errorName === "MarketRestricted")) {
        try {
          await this.pullAll(pe.errorName);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async doCancel(a: Extract<Action, { kind: "cancel" }>, existing: ExistingQuote[]) {
    try {
      await this.client.cancelOrder(a.id);
      this.stats.cancelled++;
      this.placedAt.delete(a.id);
    } catch (e) {
      // already filled/expired/removed by a taker in between: fine
      this.log(`cancel ${a.id} skipped: ${e instanceof PerpError ? e.message : (e as Error).message.split("\n")[0]}`);
    }
    void existing;
  }

  private async doPlace(q: DesiredQuote, isReplace = false) {
    const o = this.o;
    const sub = this.subFor(q.from);
    const expiry = (await this.client.chainTime()) + BigInt(o.quoteTtlSec);
    // Never take liquidity (and so never self-trade): skip any quote that would cross the current best opposite level.
    // NOTE: PostOnly would be the natural guard, but the deployed contract's PostOnly orders never rest
    // (known contract bug), so quotes are GTC protected by this pre-check; set QUOTE_TIF=postonly once fixed.
    const top = await this.client.bestPrice(o.market, !q.isBuy);
    if (top !== 0n && (q.isBuy ? top <= q.price : top >= q.price)) {
      this.log(`skip ${q.isBuy ? "bid" : "ask"} ${fromPrice(q.price)}: would cross best ${q.isBuy ? "ask" : "bid"} ${fromPrice(top)}`);
      return;
    }
    try {
      const r = await this.client.placeOrder(
        { market: o.market, isBuy: q.isBuy, price: q.price, size: q.size, tif: o.tif ?? Tif.GTC, reduceOnly: q.reduceOnly, cloid: newCloid(), expiry },
        { sub },
      );
      this.placedAt.set(r.orderId, Date.now());
      if (isReplace) this.stats.replaced++;
      else this.stats.placed++;
    } catch (e) {
      if (e instanceof PerpError && (e.errorName === "PostOnlyCross" || e.errorName === "ReduceOnlyViolation")) {
        this.log(`skip ${q.isBuy ? "bid" : "ask"} ${fromPrice(q.price)} x ${fromSize(q.size)} (${e.errorName}; notional ${notionalFloor(q.size, q.price)})`);
        return;
      }
      throw e;
    }
  }

  summary(): string {
    const s = this.stats;
    return `${this.o.name}/${this.o.marketName} ticks=${s.ticks} placed=${s.placed} replaced=${s.replaced} cancelled=${s.cancelled} pulls=${s.pulls} errors=${s.errors} quoting=${s.quoting}${s.lastReason ? ` (${s.lastReason})` : ""}`;
  }
}
