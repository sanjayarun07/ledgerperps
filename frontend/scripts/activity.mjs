// Generates account activity for Hardhat #1 (sub 0) so every indexer endpoint has data: deposit, fills, resting + cancelled
// orders, bracket (conditional), TWAP, internal transfer, withdraw, session key.  Usage: node scripts/activity.mjs
import { deployment, exchangeAbi, usdcAbi, ex, write, order, usd, btc, TIF, account, acctKey } from "./lib.mjs";
const me = account(1).address;
await write(1, deployment.usdc, usdcAbi, "mint", [me, usd(100_000)]);
await write(1, deployment.usdc, usdcAbi, "approve", [deployment.exchange, usd(100_000)]);
await ex(1, "deposit", [me, 0, usd(50_000)]);
await ex(1, "placeOrder", [me, 0, order({ market: 0, isBuy: true, price: usd(50100), size: btc(0.1), tif: TIF.IOC })]); // market-ish buy (fills vs asks)
await ex(1, "placeOrder", [me, 0, order({ market: 0, isBuy: true, price: usd(49000), size: btc(0.05) })]);              // resting
await ex(1, "placeOrder", [me, 0, order({ market: 1, isBuy: false, price: usd(3100), size: btc(1) })]);                // resting (other market)
await ex(1, "cancelOrder", [(await import("./lib.mjs").then((m) => m.pub.readContract({ address: deployment.exchange, abi: exchangeAbi, functionName: "openOrderIds", args: [acctKey(me, 0)] })))[0]]);
await ex(1, "placeBracket", [me, 0, 0, usd(52000), usd(51900), usd(48000), usd(47900), btc(0.1)]);
await ex(1, "placeTwap", [me, 0, 2, true, btc(5), 3, 30, 200, false]);
await ex(1, "transferInternal", [0, 1, usd(1000)]);
await ex(1, "withdraw", [0, usd(500)]);
console.log("activity done for", me, acctKey(me, 0));
