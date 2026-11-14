/** Starts the SIMULATED market-maker bots (one key per bot, all deployed markets). Ctrl-C pulls quotes. */
import { Tif, toUsdc, type Deployment } from "@perps/sdk";
import { printBanner } from "./banner.js";
import { ASK_SUB, BID_SUB, MM_INDEXES, RPC_URL, clientFor, getDeployment, sleep, ts } from "./config.js";
import { assertLocalDev } from "./local.js";
import { MarketMakerBot } from "./mm.js";
import type { QuoteConfig } from "./quotes.js";

const env = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

/** Personality per bot index so books have several price levels. */
const PROFILES = [
  { halfSpreadBps: 8, levelStepBps: 6 },
  { halfSpreadBps: 14, levelStepBps: 8 },
  { halfSpreadBps: 22, levelStepBps: 12 },
];

export interface RunOptions {
  durationSec?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export async function buildBots(d: Deployment) {
  const bots: MarketMakerBot[] = [];
  const names = Object.keys(d.marketIds).filter((n) => !process.env.MARKETS || process.env.MARKETS.split(",").includes(n));
  const levelUsd = env("LEVEL_NOTIONAL_USD", 5000);
  const maxInvUsd = env("MAX_INV_NOTIONAL_USD", 40_000);
  for (const [bi, idx] of MM_INDEXES.entries()) {
    const client = clientFor(idx, d);
    await assertLocalDev(client, RPC_URL, "market-maker bot");
    const prof = PROFILES[bi % PROFILES.length]!;
    for (const name of names) {
      const market = d.marketIds[name]!;
      const cfg = await client.marketConfig(market, true);
      const px = await client.markPrice(market);
      const toSizeRaw = (usd: number) => {
        const raw = (toUsdc(usd) * 10n ** 8n) / px;
        return (raw / cfg.lot) * cfg.lot;
      };
      const quote: QuoteConfig = {
        halfSpreadBps: env("HALF_SPREAD_BPS", prof.halfSpreadBps),
        levels: env("LEVELS", 3),
        levelStepBps: env("LEVEL_STEP_BPS", prof.levelStepBps),
        levelSize: toSizeRaw(levelUsd),
        maxInventory: toSizeRaw(maxInvUsd),
        skewBps: env("SKEW_BPS", 10),
        refreshBps: env("REFRESH_BPS", Math.max(1, Math.floor(prof.halfSpreadBps / 2))),
        maxQuoteAgeMs: env("MAX_QUOTE_AGE_SEC", 45) * 1000,
      };
      bots.push(
        new MarketMakerBot(client, {
          name: `mm${bi + 1}`, market, marketName: name, quote, bidSub: BID_SUB, askSub: ASK_SUB,
          oracleStaleSec: env("ORACLE_STALE_SEC", 20), quoteTtlSec: env("QUOTE_TTL_SEC", 3600), minAvailable: toUsdc(env("MIN_AVAILABLE_USD", 500)),
          tif: process.env.QUOTE_TIF === "postonly" ? Tif.PostOnly : Tif.GTC,
        }),
      );
    }
  }
  return bots;
}

export async function runBots(d: Deployment, o: RunOptions = {}) {
  const bots = await buildBots(d);
  const interval = o.intervalMs ?? env("INTERVAL_MS", 2000);
  const end = o.durationSec ? Date.now() + o.durationSec * 1000 : Infinity;
  console.log(`${ts()} running ${bots.length} bot-markets every ${interval}ms${o.durationSec ? ` for ${o.durationSec}s` : ""}`);
  let stop = false;
  const onStop = () => (stop = true);
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  o.signal?.addEventListener("abort", onStop);
  let lastSummary = 0;
  while (!stop && Date.now() < end) {
    const t0 = Date.now();
    // markets of one bot run sequentially (shared nonce); different bots (keys) run concurrently
    const byBot = new Map<string, MarketMakerBot[]>();
    for (const b of bots) byBot.set(b.name, [...(byBot.get(b.name) ?? []), b]);
    await Promise.all([...byBot.values()].map(async (group) => { for (const b of group) await b.tick(); }));
    if (Date.now() - lastSummary > 15_000) {
      lastSummary = Date.now();
      for (const b of bots) console.log(`${ts()} SUMMARY ${b.summary()}`);
    }
    await sleep(Math.max(0, interval - (Date.now() - t0)));
  }
  console.log(`${ts()} stopping: pulling all quotes`);
  for (const b of bots) {
    try {
      await b.pullAll("shutdown", true);
    } catch (e) {
      console.log("pull failed", (e as Error).message.split("\n")[0]);
    }
  }
  for (const b of bots) console.log(`${ts()} FINAL ${b.summary()}`);
  return bots;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printBanner("market-maker bots");
  const d = await getDeployment();
  const dur = process.env.DURATION_SEC ? Number(process.env.DURATION_SEC) : undefined;
  await runBots(d, { durationSec: dur });
}
