/**
 * Backstop TAKER example bot (SIMULATED / local dev only). Watches `backstopAuction(market)` and takes the backstop's inventory when the
 * Dutch-auction price beats what the order book would pay for it, after the take fee and a minimum edge.
 *
 * Not a keeper job: taking inventory is trading (it needs margin and carries price risk), so it lives here as a bot example.
 *   - the auction sells the backstop's inventory at INDEX x (1 -/+ discount): a LONG backstop is bought from at a discount, a SHORT backstop is sold to at a premium
 *   - "profitable" here means an immediate book exit exists: buy from the auction at p, sell into the best bid b > p (or the mirror image)
 *   - default is a DRY RUN (log only). Set SEND=1 to send; it still refuses anything but a loopback RPC on chainId 31337
 *   - the contract protects you with `limitPx`, so a price move between read and send reverts instead of filling worse
 */
import { fromPrice, fromSize, type BackstopAuction, type PerpClient } from "@perps/sdk";
import { printBanner } from "./banner.js";
import { RPC_URL, TAKER_INDEX, clientFor, getDeployment, sleep, ts } from "./config.js";
import { assertLocalDev } from "./local.js";

export interface TakeInput {
  auction: BackstopAuction;
  /** best bid / ask of the book (1e6 prices), undefined if that side is empty */
  bestBid?: bigint;
  bestAsk?: bigint;
  /** takeBackstop fee, bps of notional */
  feeBps: number;
  /** required edge over fee, bps of the auction price */
  minEdgeBps: number;
  /** cap on size taken per call (1e8 units) */
  maxSize: bigint;
  /** market lot (1e8 units); the size taken must be a multiple of it */
  lot: bigint;
}
export interface TakeDecision {
  take: boolean;
  reason: string;
  size: bigint;
  /** worst price to accept (`limitPx`): max when buying, min when selling; 1 bps of slack against rounding */
  limitPx: bigint;
  /** net edge in bps of price after the fee, when computable */
  edgeBps?: number;
}

/** Pure decision function (unit-tested). */
export function evaluateTake(i: TakeInput): TakeDecision {
  const none = (reason: string, edgeBps?: number): TakeDecision => ({ take: false, reason, size: 0n, limitPx: 0n, edgeBps });
  const a = i.auction;
  if (!a.active || a.size === 0n || a.price === 0n) return none("auction inactive");
  // takerSells: the backstop is SHORT, we sell to it at `price` and would buy back from the book at the best ask
  const exit = a.takerSells ? i.bestAsk : i.bestBid;
  if (exit === undefined || exit === 0n) return none("no book liquidity to exit into");
  const grossBps = a.takerSells ? Number(((a.price - exit) * 10_000n) / a.price) : Number(((exit - a.price) * 10_000n) / a.price);
  const edgeBps = grossBps - i.feeBps;
  if (edgeBps < i.minEdgeBps) return none(`edge ${edgeBps} bps < min ${i.minEdgeBps} bps`, edgeBps);
  let size = a.size < i.maxSize ? a.size : i.maxSize;
  size = (size / i.lot) * i.lot;
  if (size === 0n) return none("size below one lot", edgeBps);
  const slack = (a.price * 1n) / 10_000n + 1n;
  return { take: true, reason: "profitable", size, limitPx: a.takerSells ? a.price - slack : a.price + slack, edgeBps };
}

async function tick(c: PerpClient, market: number, name: string, send: boolean, minEdgeBps: number, maxSize: bigint): Promise<void> {
  const [auction, feeBps, cfg, book] = await Promise.all([c.backstopAuction(market), c.backstopTakeFeeBps(), c.marketConfig(market), c.bookSnapshot(market, 1)]);
  const d = evaluateTake({ auction, bestBid: book.bids[0]?.price, bestAsk: book.asks[0]?.price, feeBps, minEdgeBps, maxSize, lot: cfg.lot });
  const q = auction.active ? `${auction.takerSells ? "backstop SHORT: we sell" : "backstop LONG: we buy"} ${fromSize(auction.size)} @ ${fromPrice(auction.price)} (disc ${auction.discBps} bps)` : "inactive";
  console.log(`[${ts()}] ${name} auction ${q} | ${d.take ? `TAKE ${fromSize(d.size)} limit ${fromPrice(d.limitPx)} edge ${d.edgeBps} bps` : `skip: ${d.reason}`}`);
  if (!d.take) return;
  if (!send) return console.log(`[${ts()}] DRY RUN: not sending (set SEND=1)`);
  try {
    const r = await c.takeBackstop(market, d.size, d.limitPx);
    console.log(`[${ts()}] takeBackstop sent tx ${r.hash.slice(0, 12)} gas ${r.gasUsed}`);
  } catch (e) {
    console.log(`[${ts()}] takeBackstop failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printBanner("backstop taker");
  const d = await getDeployment();
  const c = clientFor(TAKER_INDEX, d);
  await assertLocalDev(c, RPC_URL, "backstop taker");
  const name = process.env.MARKET ?? "BTC-USD";
  const market = d.marketIds[name]!;
  const send = process.env.SEND === "1";
  const minEdge = Number(process.env.MIN_EDGE_BPS ?? 5);
  const maxSize = BigInt(process.env.MAX_SIZE ?? "100000000"); // 1.0 in 1e8 units
  const rounds = Number(process.env.ROUNDS ?? 0); // 0 = run forever
  for (let r = 0; rounds === 0 || r < rounds; r++) {
    try {
      await tick(c, market, name, send, minEdge, maxSize);
    } catch (e) {
      console.log(`[${ts()}] tick failed: ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(Number(process.env.POLL_MS ?? 2000));
  }
}
