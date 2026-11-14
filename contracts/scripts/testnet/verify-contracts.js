// Verify every contract in deployments/arbitrumSepolia.json on Arbiscan (Etherscan v2 key). Idempotent: "already verified" is OK.
//   npx hardhat --config hardhat.testnet.config.js run scripts/testnet/verify-contracts.js --network arbitrumSepolia
// VERIFY_DRY=1 prints what would be submitted without calling the API.
const { hre, ctx, loadDeployment } = require("./common");
const L = require("./lib");

async function main() {
  const { chainId } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  const d = loadDeployment();
  if (d.chainId !== chainId) throw new Error(`deployment chainId ${d.chainId} != network ${chainId}`);
  const dry = process.env.VERIFY_DRY === "1";
  if (!dry && !process.env.ARBISCAN_API_KEY) throw new Error("ARBISCAN_API_KEY is not set (one Etherscan v2 key covers Arbiscan). Use VERIFY_DRY=1 to preview.");
  const rows = []; let failed = 0;
  for (const [label, c] of Object.entries(d.contracts)) {
    const args = c.ctorArgs.map((a) => (typeof a === "string" && /^\d+$/.test(a) ? a : a));
    if (dry) { rows.push({ contract: label, address: c.address, result: "DRY", detail: `args=${JSON.stringify(args)}` }); continue; }
    try {
      await hre.run("verify:verify", { address: c.address, constructorArguments: args });
      rows.push({ contract: label, address: c.address, result: "VERIFIED", detail: "" });
    } catch (e) {
      const m = String(e.message || e);
      if (/already verified/i.test(m)) rows.push({ contract: label, address: c.address, result: "ALREADY", detail: "" });
      else { failed++; rows.push({ contract: label, address: c.address, result: "FAIL", detail: L.redact(m, [process.env.ARBISCAN_API_KEY]).split("\n")[0].slice(0, 120) }); }
    }
  }
  console.log(L.table(rows));
  console.log(`Explorer: https://sepolia.arbiscan.io/address/${d.exchange}#code`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(L.redact(e.message, [process.env.ARBISCAN_API_KEY])); process.exit(1); });
