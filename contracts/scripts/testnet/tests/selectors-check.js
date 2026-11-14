// The set of selectors deploy-testnet.js registers (moduleSelectors(): every function of each module ABI that the router does not define itself)
// plus the router's own functions must EQUAL the function set of contracts/abi/PerpExchange.merged.json, so no phase-2 function can be left unrouted.
// Run: npx hardhat --config hardhat.testnet.config.js run scripts/testnet/tests/selectors-check.js
const fs = require("fs"); const path = require("path");
const { ethers, MODULES, moduleSelectors } = require("../common");

async function main() {
  const merged = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "abi", "PerpExchange.merged.json"), "utf8"));
  const iface = new ethers.Interface(merged.filter((f) => f.type === "function").map((f) => ({ ...f, stateMutability: f.stateMutability === "undefined" ? "nonpayable" : f.stateMutability })));
  const want = new Map(iface.fragments.filter((f) => f.type === "function").map((f) => [iface.getFunction(f.format()).selector, f.format()]));
  const core = (await ethers.getContractFactory("PerpExchange")).interface;
  const coreSels = new Set(core.fragments.filter((f) => f.type === "function").map((f) => core.getFunction(f.format()).selector));
  const reg = await moduleSelectors();
  const registered = new Map();
  for (const m of MODULES) for (const s of reg[m]) { if (registered.has(s)) throw new Error(`selector ${s} registered by both ${registered.get(s)} and ${m}`); registered.set(s, m); }
  const problems = [];
  for (const [sel, sig] of want) if (!coreSels.has(sel) && !registered.has(sel)) problems.push(`merged ABI function ${sig} (${sel}) is neither in the router nor registered by deploy-testnet.js`);
  for (const [sel, m] of registered) if (!want.has(sel)) problems.push(`${m} registers ${sel} which is not in the merged ABI (stale merged ABI? run scripts/export-abi.js)`);
  for (const sel of coreSels) if (registered.has(sel)) problems.push(`selector ${sel} is both a router function and registered from ${registered.get(sel)}`);
  // spot-check the phase-2 functions by name and the module that must serve them
  const phase2 = { takeBackstop: "PerpLiquidation", pokeBackstop: "PerpLiquidation", setBackstopCfg: "PerpLiquidation", setBackstopTakeFee: "PerpLiquidation", setBackstopPlaceOpen: "PerpLiquidation", backstopAuction: "PerpLiquidation", unwindBackstop: "PerpAdl", backstopCfg: null, backstopPlaceOpen: null, backstopTakeFeeBps: null };
  for (const [name, mod] of Object.entries(phase2)) {
    const sel = iface.getFunction(name).selector;
    if (mod && registered.get(sel) !== mod) problems.push(`${name} should be registered from ${mod}, got ${registered.get(sel) || (coreSels.has(sel) ? "router" : "nothing")}`);
    if (!mod && !coreSels.has(sel) && !registered.has(sel)) problems.push(`${name} is not routed at all`);
  }
  console.log(`merged ABI functions=${want.size} router-own=${coreSels.size} registered-from-modules=${registered.size}`);
  if (problems.length) { console.error("SELECTOR CHECK FAILED:\n - " + problems.join("\n - ")); process.exit(1); }
  console.log("SELECTOR CHECK PASSED: router + registered module selectors == merged ABI function set (phase-2 functions included)");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
