// Outside market maker on Arbitrum Sepolia (TESTNET, UNAUDITED, free test USDC). DRY RUN by default: prints what it would quote.
// Quotes one post-only bid and ask around the mark, replacing them when the mark moves more than REFRESH_BPS. Each place/cancel is a real
// transaction that costs gas, so it only sends when LIVE=yes.
//   env: RPC_URL, DEPLOYMENT_FILE (contracts/deployments/arbitrumSepolia.json), AGENT_PRIVATE_KEY (trading-only key),
//        MASTER_ADDRESS (funded owner), SUB (default 4), MARKET (default 0), SPREAD_BPS (default 20), SIZE (raw 1e8, default 10000),
//        REFRESH_BPS (default 10), LIVE=yes
//   one-off setup (master key): deposit into SUB, then approveAgent(agentAddress, expiry, { sub: SUB }).
import { readFileSync } from "node:fs";
import { PerpClient, Tif, newCloid } from "../src/index.js";

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const deployment = JSON.parse(readFileSync(env("DEPLOYMENT_FILE"), "utf8"));
const sub = Number(env("SUB", "4")), market = Number(env("MARKET", "0"));
const spread = BigInt(env("SPREAD_BPS", "20")), size = BigInt(env("SIZE", "10000")), refresh = BigInt(env("REFRESH_BPS", "10"));
const live = process.env.LIVE === "yes";

const c = PerpClient.fromPrivateKey({ rpcUrl: env("RPC_URL"), privateKey: env("AGENT_PRIVATE_KEY") as `0x${string}`, owner: env("MASTER_ADDRESS") as `0x${string}`, deployment, sub });
const down = (p: bigint, tick: bigint) => (p / tick) * tick, up = (p: bigint, tick: bigint) => ((p + tick - 1n) / tick) * tick;
let quotedAt = 0n; let ids: bigint[] = [];

console.log(`${live ? "LIVE" : "DRY RUN"}: market ${market} sub ${sub} (testnet, simulated liquidity, unaudited)`);
for (;;) {
  const [cfg, os] = await Promise.all([c.marketConfig(market), c.oracleStatus(market)]);
  const mark = await c.markPrice(market).catch(() => 0n);
  if (!mark || !os.fresh) { console.log("oracle not usable, not quoting"); await new Promise((r) => setTimeout(r, 15000)); continue; }
  const moved = quotedAt === 0n ? 10_000n : ((mark > quotedAt ? mark - quotedAt : quotedAt - mark) * 10_000n) / quotedAt;
  if (moved >= refresh) {
    const bid = down(mark - (mark * spread) / 20_000n, cfg.tick), ask = up(mark + (mark * spread) / 20_000n, cfg.tick);
    console.log(`mark ${Number(mark) / 1e6}: quote bid ${Number(bid) / 1e6} / ask ${Number(ask) / 1e6}, size ${Number(size) / 1e8}`);
    if (live) {
      if (ids.length) await c.cancelAll({ sub });
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 600); // dead-man switch: quotes die after 10 minutes if the bot stops
      ids = [];
      for (const [isBuy, price] of [[true, bid], [false, ask]] as const) ids.push((await c.placeOrder({ market, isBuy, price, size, tif: Tif.PostOnly, reduceOnly: false, cloid: newCloid(), expiry }, { sub })).orderId);
    }
    quotedAt = mark;
  }
  await new Promise((r) => setTimeout(r, 10000));
}
