// Permissionless keeper loop: funding poke, liquidation scan, conditional triggers. (services/keeper is the production path.)
import { clientFor } from "./_common.js";

const keeper = clientFor(15);
const n = await keeper.marketCount();
for (let m = 0; m < n; m++) {
  try { await keeper.pokeFunding(m); console.log("poked funding market", m); } catch (e) { console.log("poke failed", m, (e as Error).message); }
}
// liquidation: supply accounts from your own indexer / Deposit events
const watch: `0x${string}`[] = (process.env.WATCH ?? "").split(",").filter(Boolean) as any;
for (const acct of watch) {
  for (let m = 0; m < n; m++) {
    if (await keeper.isLiquidatable(acct, m)) {
      console.log("liquidating", acct, "market", m, (await keeper.liquidate(acct, m)).hash);
    }
  }
}
