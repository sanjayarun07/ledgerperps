// IRREVERSIBLE. Freezes the router's selector->module table forever (no bug fix by swapping a module, ever again for this router).
// Do this only AFTER smoke tests pass and you are certain no module needs replacing. Gate: CONFIRM_LOCK_MODULES=yes.
const { ethers, ctx, mergedAbi, loadDeployment } = require("./common");
const L = require("./lib");

async function main() {
  const cfg = L.loadConfig();
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  const d = loadDeployment();
  const gate = L.broadcastGate("CONFIRM_LOCK_MODULES", chainId);
  console.log("!!! lockModules() IS IRREVERSIBLE. After this the module table can never change; a faulty module means a full redeploy. !!!");
  const r = new ethers.Contract(d.exchange, ["function modulesLocked() view returns (bool)", "function lockModules()", "function hasRole(bytes32,address) view returns (bool)", "function DEFAULT_ADMIN_ROLE() view returns (bytes32)"], ethers.provider);
  if (await r.modulesLocked()) { console.log("Already locked. Nothing to do."); return; }
  if (!gate.ok) { console.log(`DRY-RUN: would call lockModules() on ${d.exchange} (${gate.reason}). Set CONFIRM_LOCK_MODULES=yes to execute.`); return; }
  const s = L.requireSigner(signers, "lockModules");
  L.assertDeployerMatch(s.address, L.expectedDeployer(cfg));
  if (!(await r.hasRole(await r.DEFAULT_ADMIN_ROLE(), s.address))) throw new Error("signer does not hold DEFAULT_ADMIN_ROLE (admin already transferred? then lock via the timelock instead)");
  const tx = await r.connect(s).lockModules(); const rc = await tx.wait();
  console.log(`locked. tx ${rc.hash} block ${rc.blockNumber} modulesLocked=${await r.modulesLocked()}`);
  const fs = require("fs"); d.modulesLocked = true; d.lockTx = rc.hash; fs.writeFileSync(L.DEPLOYMENT_PATH, JSON.stringify(d, null, 2));
}
main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY])); process.exit(1); });
