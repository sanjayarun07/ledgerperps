/**
 * SEED (LOCAL DEMO ONLY - SIMULATED LIQUIDITY - NOT REAL):
 *   1. mints MockUSDC to the market-maker + taker accounts (permissionless faucet on the mock token)
 *   2. approves + deposits into the exchange (MM bid-set sub 0 and ask-set sub 1; taker sub 0)
 *   3. starts the market-maker bots (skip with --no-start; bound runtime with DURATION_SEC)
 * Usage: pnpm seed [--no-start]     Env: FUND_USD (500000 per MM subaccount)  TAKER_FUND_USD (50000)
 */
import { fromUsdc, toUsdc } from "@perps/sdk";
import { printBanner } from "./banner.js";
import { ASK_SUB, BID_SUB, MM_INDEXES, RPC_URL, TAKER_INDEX, clientFor, getDeployment } from "./config.js";
import { assertLocalDev } from "./local.js";
import { runBots } from "./run-mm.js";

printBanner("seed");
const d = await getDeployment();
const fund = toUsdc(Number(process.env.FUND_USD ?? 500_000));
const takerFund = toUsdc(Number(process.env.TAKER_FUND_USD ?? 50_000));

async function top(index: number, sub: number, target: bigint, label: string) {
  const c = clientFor(index, d);
  await assertLocalDev(c, RPC_URL, "seed (mints MockUSDC)");
  const have = await c.collateral(sub);
  if (have >= target) {
    console.log(`${label} (${c.owner} sub ${sub}) already has ${fromUsdc(have)} USDC collateral`);
    return;
  }
  const need = target - have;
  await c.mintMockUsdc(c.owner, need);
  if ((await c.usdcAllowance()) < need) await c.approveUsdc();
  await c.deposit(need, { sub });
  console.log(`${label} (${c.owner} sub ${sub}) deposited ${fromUsdc(need)} MOCK USDC -> collateral ${fromUsdc(await c.collateral(sub))}`);
}

for (const [i, idx] of MM_INDEXES.entries()) {
  await top(idx, BID_SUB, fund, `mm${i + 1} bid-set`);
  await top(idx, ASK_SUB, fund, `mm${i + 1} ask-set`);
}
await top(TAKER_INDEX, 0, takerFund, "test taker");

if (process.argv.includes("--no-start")) {
  console.log("seeded; not starting bots (--no-start). Run `pnpm mm` and `pnpm oracle`.");
} else {
  console.log("starting SIMULATED market-maker bots (start `pnpm oracle` in another shell to move the price)...");
  await runBots(d, { durationSec: process.env.DURATION_SEC ? Number(process.env.DURATION_SEC) : undefined });
}
