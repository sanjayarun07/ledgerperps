// Dev-only: paints ~90 one-minute candles of BTC-USD history on the isolated dev chain so the chart can be reviewed with real data.
// Cancels the market makers' seed orders first, then prints trades along a random walk (maker rests at p, taker IOC crosses it), advancing chain time 60s per step.
// Re-run `node scripts/seed.mjs` afterwards to rebuild book depth. Usage: node scripts/history.mjs [steps]
import { ex, rpc, order, usd, btc, TIF, account, setPrice } from "./lib.mjs";
const steps = Number(process.argv[2] ?? 90);
const mk = (i) => account(i).address;
for (const i of [5, 6]) await ex(i, "cancelAll", [mk(i), 0]);
let p = 50_000, seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let k = 0; k < steps; k++) {
  const target = k > steps - 12 ? 50_000 : p;
  p = Math.round((target + (rnd() - 0.5) * 30) * 10) / 10;
  if (k > steps - 12) p = Math.round((p + (50_000 - p) * 0.3) * 10) / 10;
  await rpc("evm_increaseTime", [60]); await rpc("evm_mine");
  await setPrice("BTC-USD", p); await setPrice("ETH-USD", 3000); await setPrice("SOL-USD", 150); // every market must stay fresh: settlement walks all of an account's markets
  const buy = rnd() > 0.5, px = usd(p), sz = btc(0.02 + Math.floor(rnd() * 8) * 0.01);
  await ex(buy ? 6 : 5, "placeOrder", [mk(buy ? 6 : 5), 0, order({ market: 0, isBuy: !buy, price: px, size: sz })]);
  await ex(7, "placeOrder", [mk(7), 0, order({ market: 0, isBuy: buy, price: px, size: sz, tif: TIF.IOC })]);
}
console.log("history painted, last price", p);
