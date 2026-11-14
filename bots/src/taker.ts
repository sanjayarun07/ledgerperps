/** Test taker (SIMULATED): crosses the book with IOC market orders so fills can be verified. */
import { fromPrice, fromSize, fromUsdc, toSize } from "@perps/sdk";
import { printBanner } from "./banner.js";
import { RPC_URL, TAKER_INDEX, clientFor, getDeployment, sleep } from "./config.js";
import { assertLocalDev } from "./local.js";

printBanner("test taker");
const d = await getDeployment();
const c = clientFor(TAKER_INDEX, d);
await assertLocalDev(c, RPC_URL, "test taker");
const name = process.env.MARKET ?? "BTC-USD";
const market = d.marketIds[name]!;
const size = toSize(process.env.SIZE ?? "0.05");
const rounds = Number(process.env.ROUNDS ?? 3);
for (let r = 0; r < rounds; r++) {
  for (const isBuy of process.env.SIDE === "buy" ? [true] : process.env.SIDE === "sell" ? [false] : [true, false]) {
    try {
      const res = await c.marketOrder({ market, isBuy, size, slippageBps: Number(process.env.SLIPPAGE_BPS ?? 100) });
      console.log(`${name} ${isBuy ? "BUY " : "SELL"} ${fromSize(size)} -> filled ${fromSize(res.filled)} @ [${res.fills.map((f) => fromPrice(f.price)).join(", ")}] tx ${res.hash.slice(0, 12)}`);
    } catch (e) {
      console.log(`${name} ${isBuy ? "BUY" : "SELL"} failed: ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(Number(process.env.PAUSE_MS ?? 500));
  }
}
const st = await c.accountState();
console.log("taker positions:", (await c.positions()).map((p) => `${p.market}:${fromSize(p.size)}`).join(" ") || "flat", "| equity", fromUsdc(st.equity));
