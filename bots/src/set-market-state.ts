/** LOCAL DEMO admin helper: `tsx src/set-market-state.ts <0..4>` sets ETH-USD market state (0 Normal,1 ReduceOnly,2 OracleDegraded,3 Paused,4 Recovery). Uses account #0 (admin). */
import { MarketState } from "@perps/sdk";
import { clientFor, getDeployment } from "./config.js";
const d = await getDeployment();
const a = clientFor(0, d);
const st = Number(process.argv[2]) as MarketState;
await a.setMarketState(d.marketIds["ETH-USD"]!, st);
console.log("ETH-USD state ->", st);
