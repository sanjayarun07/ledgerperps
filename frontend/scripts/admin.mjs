// Admin / test-harness actions as Hardhat account #0 (DEFAULT_ADMIN_ROLE on the dev deployment).
//   node scripts/admin.mjs state <market> <Normal|ReduceOnly|OracleDegraded|Paused|Recovery>
//   node scripts/admin.mjs pause | unpause
//   node scripts/admin.mjs price <BTC-USD|ETH-USD|SOL-USD> <usd>
//   node scripts/admin.mjs time <seconds>      (evm_increaseTime + mine one block)
//   node scripts/admin.mjs mine [n]
//   node scripts/admin.mjs refresh             (re-publish all oracle prices so they are not stale after a time jump)
//   node scripts/admin.mjs status
import { deployment, exchangeAbi, ex, pub, rpc, setPrice } from "./lib.mjs";
const STATES = ["Normal", "ReduceOnly", "OracleDegraded", "Paused", "Recovery", "Delisted"];
const [cmd, a, b] = process.argv.slice(2);
const read = (functionName, args = []) => pub.readContract({ address: deployment.exchange, abi: exchangeAbi, functionName, args });
switch (cmd) {
  case "state": { const s = STATES.indexOf(b); if (s < 0) throw new Error(`state must be one of ${STATES.join(", ")}`); await ex(0, "setMarketState", [Number(a), s]); console.log(`market ${a} -> ${b}`); break; }
  case "pause": await ex(0, "setGlobalPause", [true]); console.log("global pause ON"); break;
  case "unpause": await ex(0, "setGlobalPause", [false]); console.log("global pause OFF"); break;
  case "price": await setPrice(a, Number(b)); console.log(`${a} oracle -> ${b}`); break;
  case "refresh": { for (const [n, px] of Object.entries({ "BTC-USD": 50000, "ETH-USD": 3000, "SOL-USD": 150 })) await setPrice(n, px); console.log("oracle refreshed"); break; }
  case "time": await rpc("evm_increaseTime", [Number(a)]); await rpc("evm_mine"); console.log(`advanced ${a}s`); break;
  case "mine": for (let i = 0; i < Number(a ?? 1); i++) await rpc("evm_mine"); console.log("mined"); break;
  case "status": {
    const blk = await pub.getBlock();
    console.log({ block: blk.number, time: Number(blk.timestamp), paused: await read("globalPaused"), states: await Promise.all([0, 1, 2].map(async (m) => STATES[Number((await read("getMarket", [m])).state)])) });
    break;
  }
  default: console.error("usage: see header"); process.exit(1);
}
