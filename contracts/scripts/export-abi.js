// Writes abi/PerpExchange.merged.json: core + all module ABIs (the router exposes all of them at one address).
const hre = require("hardhat"); const fs = require("fs");
async function main() {
  await hre.run("compile");
  const OK = (f) => ["function", "event", "error"].includes(f.type);
  const seen = new Set(); const abi = [];
  for (const n of ["PerpExchange", "PerpTrading", "PerpExtras", "PerpLiquidation", "PerpTwap", "PerpAdl"]) {
    const f = await hre.ethers.getContractFactory(n);
    for (const fr of f.interface.fragments.filter(OK)) { const k = fr.format(); if (!seen.has(k)) { seen.add(k); abi.push(JSON.parse(fr.format("json"))); } }
  }
  for (const n of ["MockUSDC", "ManualOracle"]) fs.mkdirSync("abi", { recursive: true }), fs.writeFileSync(`abi/${n}.json`, JSON.stringify(JSON.parse((await hre.ethers.getContractFactory(n)).interface.formatJson()), null, 2));
  fs.mkdirSync("abi", { recursive: true });
  fs.writeFileSync("abi/PerpExchange.merged.json", JSON.stringify(abi, null, 2));
  console.log("wrote abi/PerpExchange.merged.json with", abi.length, "entries");
}
main().catch((e) => { console.error(e); process.exit(1); });
