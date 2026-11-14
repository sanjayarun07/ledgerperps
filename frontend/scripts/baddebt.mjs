// Manufactures bad debt on a CLEAN chain (no seed liquidity on market 0): Hardhat #3 (loser, 6k collateral) goes 1 BTC long against
// #4 (winner), the oracle gaps from 50k to 30k, #5 liquidates #3 -> unresolved bad debt / adlDebt(0) > 0, #4 holds a profitable
// short that ADL can target. Afterwards connect as #4 (adlScore) and any funded account (recapitalize).
// Usage: scripts/stack.sh && node scripts/baddebt.mjs
import { deployment, exchangeAbi, usdcAbi, ex, write, order, usd, btc, TIF, account, acctKey, setPrice } from "./lib.mjs";
for (const [i, dep] of [[3, 6000], [4, 100000]]) {
  await write(i, deployment.usdc, usdcAbi, "mint", [account(i).address, usd(200_000)]);
  await write(i, deployment.usdc, usdcAbi, "approve", [deployment.exchange, usd(200_000)]);
  await ex(i, "deposit", [account(i).address, 0, usd(dep)]);
}
await ex(0, "setFees", [5, 1, 50, 5000, 10000, usd(1_000_000)]);
await ex(4, "placeOrder", [account(4).address, 0, order({ market: 0, isBuy: false, price: usd(50000), size: btc(1) })]);
await ex(3, "placeOrder", [account(3).address, 0, order({ market: 0, isBuy: true, price: usd(50000), size: btc(1), tif: TIF.IOC })]);
await setPrice("BTC-USD", 30000);
await ex(5, "liquidate", [acctKey(account(3).address, 0), 0]);
console.log("bad debt created; loser #3 liquidated, winner #4 short 1 BTC");
