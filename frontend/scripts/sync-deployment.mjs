// Copies ../contracts/deployments/<network>.json (default localhost) and the merged ABI into src/generated/.
// Usage: node scripts/sync-deployment.mjs [network] [--file <deployment.json>] [--soft]   (--soft: keep an existing copy / write a placeholder instead of failing)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const contracts = path.resolve(root, "../contracts");
const out = path.join(root, "src/generated");
const soft = process.argv.includes("--soft");
const network = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--file") ?? process.env.DEPLOYMENT_NETWORK ?? "localhost";
fs.mkdirSync(out, { recursive: true });

const abiSrc = path.join(contracts, "abi/PerpExchange.merged.json");
if (!fs.existsSync(abiSrc)) { console.error(`missing ${abiSrc} (run contracts export-abi)`); process.exit(1); }
fs.copyFileSync(abiSrc, path.join(out, "PerpExchange.merged.json"));
const usdcAbi = path.join(contracts, "abi/MockUSDC.json");
if (fs.existsSync(usdcAbi)) fs.copyFileSync(usdcAbi, path.join(out, "MockUSDC.json"));

const fileArg = process.argv.indexOf("--file");
const depSrc = fileArg > 0 ? path.resolve(process.argv[fileArg + 1]) : path.join(contracts, `deployments/${network}.json`);
const depDst = path.join(out, "deployment.json");
if (fs.existsSync(depSrc)) {
  fs.copyFileSync(depSrc, depDst);
  console.log(`synced ${depSrc} -> ${depDst}`);
} else if (soft) {
  if (!fs.existsSync(depDst)) {
    fs.writeFileSync(depDst, JSON.stringify({ env: "NOT-DEPLOYED", chainId: 31337, usdc: "0x0000000000000000000000000000000000000000", oracle: "0x0000000000000000000000000000000000000000", exchange: "0x0000000000000000000000000000000000000000", feeds: {}, marketIds: { "BTC-USD": 0, "ETH-USD": 1, "SOL-USD": 2 } }, null, 2));
    console.warn(`WARN: ${depSrc} not found; wrote placeholder deployment. Deploy contracts then run pnpm sync.`);
  } else console.warn(`WARN: ${depSrc} not found; keeping existing ${depDst}`);
} else { console.error(`missing ${depSrc}; run hardhat deploy --network ${network}`); process.exit(1); }
