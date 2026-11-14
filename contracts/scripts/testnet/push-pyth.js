// Fetch signed price updates from Hermes and push them to the Pyth contract. Dry-run = fetch + fee quote + simulate (staticCall) only.
// Broadcast: CONFIRM_PYTH_PUSH=yes. Costs a tiny fee in ETH per call. Run it right before anything that reads the oracle, or loop it.
const { ethers, ctx } = require("./common");
const L = require("./lib");
const P = require("./pyth");
async function main() {
  const cfg = L.loadConfig();
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  const { url, updates } = await P.fetchUpdates(cfg);
  console.log(`Hermes ${url}: ${updates.length} update blob(s)`);
  const fee = await P.quoteFee(cfg, updates);
  console.log(`getUpdateFee = ${fee} wei (read-only call succeeded)`);
  const gate = L.broadcastGate("CONFIRM_PYTH_PUSH", chainId);
  if (!gate.ok) return console.log(`DRY-RUN (${gate.reason}); nothing sent.`);
  const s = L.requireSigner(signers, "pyth push");
  L.assertDeployerMatch(s.address, L.expectedDeployer(cfg));
  console.log("pushed:", await P.push(cfg, s, updates));
}
main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY])); process.exit(1); });
