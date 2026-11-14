// Seeds the isolated dev chain with liquidity + a bit of trade history so the book / trades / candles are non-empty.
// Accounts: #5 and #6 are market makers, #7 a taker (the browser burner uses #0..#4). Usage: node scripts/seed.mjs
import { deployment, exchangeAbi, usdcAbi, ex, write, order, usd, btc, TIF, account, setPrice } from "./lib.mjs";
for (const i of [5, 6, 7]) {
  await write(i, deployment.usdc, usdcAbi, "mint", [account(i).address, usd(5_000_000)]);
  await write(i, deployment.usdc, usdcAbi, "approve", [deployment.exchange, usd(5_000_000)]);
  await ex(i, "deposit", [account(i).address, 0, usd(2_000_000)]);
}
const mk = (i) => account(i).address;
const mid = { 0: 50000, 1: 3000, 2: 150 };
const tickRound = (p, t) => Math.round(p / t) * t;
const lots = { 0: 0.01, 1: 0.1, 2: 1 };
for (const m of [0, 1, 2]) {
  await setPrice(["BTC-USD", "ETH-USD", "SOL-USD"][m], mid[m]);
  for (let k = 1; k <= 6; k++) {
    const step = mid[m] * 0.0004 * k;
    await ex(5, "placeOrder", [mk(5), 0, order({ market: m, isBuy: true, price: usd(tickRound(mid[m] - step, 0.1)), size: btc(lots[m] * 10 * k) })]);
    await ex(6, "placeOrder", [mk(6), 0, order({ market: m, isBuy: false, price: usd(tickRound(mid[m] + step, 0.1)), size: btc(lots[m] * 10 * k) })]);
  }
  // a few crossing trades so history exists
  for (let k = 0; k < 4; k++) {
    await ex(7, "placeOrder", [mk(7), 0, order({ market: m, isBuy: k % 2 === 0, price: usd(tickRound(mid[m] * (k % 2 === 0 ? 1.01 : 0.99), 0.1)), size: btc(lots[m] * 2), tif: TIF.IOC })]);
  }
}
console.log("seeded");
