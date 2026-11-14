/** On-chain verification of the simulated liquidity: quotes resting, fills, and zero self-trades. Reads only. */
import { fromPrice, fromSize, exchangeAbi } from "@perps/sdk";
import { MM_INDEXES, TAKER_INDEX, clientFor, getDeployment } from "./config.js";

const d = await getDeployment();
const c = clientFor(TAKER_INDEX, d);
const fills = await c.getFills({ fromBlock: BigInt(process.env.FROM_BLOCK ?? 0) });
const owner = async (a: `0x${string}`) => (await c.publicClient.readContract({ address: d.exchange, abi: exchangeAbi, functionName: "acctOwner", args: [a] })) as string;
const cache = new Map<string, string>();
const own = async (a: `0x${string}`) => cache.get(a) ?? (cache.set(a, await owner(a)), cache.get(a)!);
let self = 0;
let takerFills = 0;
let takerVol = 0n;
const byMarket = new Map<number, number>();
for (const f of fills) {
  byMarket.set(f.market, (byMarket.get(f.market) ?? 0) + 1);
  if ((await own(f.maker)) === (await own(f.taker))) self++;
  if (f.taker === c.acct(0)) { takerFills++; takerVol += f.size; }
}
console.log(`Fill events: ${fills.length} (by market: ${[...byMarket].map(([m, n]) => `m${m}=${n}`).join(" ")})`);
console.log(`test-taker fills: ${takerFills}, volume ${fromSize(takerVol)} base units`);
console.log(`SELF-TRADES (maker owner == taker owner): ${self}`);
const unrealMakers = [] as string[];
for (const [i, idx] of MM_INDEXES.entries()) {
  const mc = clientFor(idx, d);
  for (const sub of [0, 1]) {
    const oo = await mc.openOrders(sub);
    const ps = await mc.positions(sub);
    unrealMakers.push(`mm${i + 1}/sub${sub}: open=${oo.length} pos=${ps.map((p) => `m${p.market}:${fromSize(p.size)}`).join(",") || "flat"}`);
  }
}
console.log(unrealMakers.join("\n"));
const last = fills.slice(-3);
for (const f of last) console.log(`  last fills: m${f.market} ${f.takerIsBuy ? "buy" : "sell"} ${fromSize(f.size)} @ ${fromPrice(f.price)} block ${f.blockNumber}`);
