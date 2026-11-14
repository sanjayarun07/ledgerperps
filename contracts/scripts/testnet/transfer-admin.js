// Hand DEFAULT_ADMIN_ROLE to a TimelockController (contracts/src/Governance.sol re-exports OpenZeppelin's). Dry-run by default.
//   TIMELOCK_MIN_DELAY=<secs> (default 3600 on testnet; use >= 86400 on any real network)
//   PROPOSERS=0xA,0xB  EXECUTORS=0xA (default = PROPOSERS)  [TIMELOCK_ADDRESS=0x.. to reuse an already deployed timelock]
//   GUARDIAN_ADDRESS=0x..  (optional, gets GUARDIAN_ROLE; pause-only, cannot unpause)
// Broadcast gate: CONFIRM_TRANSFER_ADMIN=yes. Order: deploy timelock -> grant timelock DEFAULT_ADMIN_ROLE -> (guardian) -> verify timelock holds role
// -> ONLY THEN renounce the deployer's DEFAULT_ADMIN_ROLE. Renounce is a separate gate: CONFIRM_RENOUNCE_DEPLOYER=yes.
// Timelock admin param is address(0): the timelock administers itself, no EOA backdoor (OZ v5 semantics).
const { ethers, ctx, loadDeployment } = require("./common");
const L = require("./lib");

async function main() {
  const cfg = L.loadConfig();
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  const d = loadDeployment();
  const delay = Number(process.env.TIMELOCK_MIN_DELAY || 3600);
  const proposers = (process.env.PROPOSERS || "").split(",").filter(Boolean);
  const executors = (process.env.EXECUTORS ? process.env.EXECUTORS.split(",") : proposers).filter(Boolean);
  const guardian = process.env.GUARDIAN_ADDRESS || null;
  for (const a of [...proposers, ...executors, ...(guardian ? [guardian] : []), ...(process.env.TIMELOCK_ADDRESS ? [process.env.TIMELOCK_ADDRESS] : [])]) if (!L.ADDR_RE.test(a)) throw new Error("malformed address in env: " + a);
  if (!proposers.length) throw new Error("PROPOSERS is required (comma-separated; ideally a multisig). Refusing to plan a timelock nobody can use.");
  if (delay < 3600) throw new Error("TIMELOCK_MIN_DELAY below 3600s refused.");
  const gate = L.broadcastGate("CONFIRM_TRANSFER_ADMIN", chainId);
  const ex = new ethers.Contract(d.exchange, ["function DEFAULT_ADMIN_ROLE() view returns (bytes32)", "function GUARDIAN_ROLE() view returns (bytes32)", "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)", "function renounceRole(bytes32,address)"], ethers.provider);
  const ADMIN = await ex.DEFAULT_ADMIN_ROLE(), GUARD = await ex.GUARDIAN_ROLE();
  console.log(gate.ok ? "MODE: BROADCAST" : `MODE: DRY-RUN (${gate.reason})`);
  console.log(`Plan:\n 1. ${process.env.TIMELOCK_ADDRESS ? "use existing timelock " + process.env.TIMELOCK_ADDRESS : `deploy TimelockController(minDelay=${delay}s, proposers=[${proposers}], executors=[${executors}], admin=0x0)`}\n 2. exchange.grantRole(DEFAULT_ADMIN_ROLE, timelock)\n${guardian ? ` 3. exchange.grantRole(GUARDIAN_ROLE, ${guardian})\n` : ""} 4. assert timelock holds DEFAULT_ADMIN_ROLE\n 5. (separate gate CONFIRM_RENOUNCE_DEPLOYER=yes) exchange.renounceRole(DEFAULT_ADMIN_ROLE, deployer)`);
  console.log("After step 5 every admin function (createMarket, setFees, registerModule, lockModules...) needs timelock schedule + wait + execute. Guardian pause still works instantly.");
  if (!gate.ok) return;
  const s = L.requireSigner(signers, "transfer-admin");
  L.assertDeployerMatch(s.address, L.expectedDeployer(cfg));
  let tl = process.env.TIMELOCK_ADDRESS;
  if (!tl) {
    const f = await ethers.getContractFactory("TimelockController", s);
    const c = await f.deploy(delay, proposers, executors, ethers.ZeroAddress); await c.waitForDeployment(); tl = await c.getAddress();
    console.log("timelock deployed:", tl, "tx", c.deploymentTransaction().hash);
  }
  const exs = ex.connect(s);
  await (await exs.grantRole(ADMIN, tl)).wait();
  if (guardian) await (await exs.grantRole(GUARD, guardian)).wait();
  if (!(await ex.hasRole(ADMIN, tl))) throw new Error("timelock does not hold DEFAULT_ADMIN_ROLE; NOT renouncing");
  console.log("timelock holds DEFAULT_ADMIN_ROLE.");
  if (process.env.CONFIRM_RENOUNCE_DEPLOYER === "yes") { await (await exs.renounceRole(ADMIN, s.address)).wait(); console.log("deployer admin role renounced."); }
  else console.log("Deployer still holds DEFAULT_ADMIN_ROLE (set CONFIRM_RENOUNCE_DEPLOYER=yes to renounce after you have tested a scheduled op).");
  const fs = require("fs"); d.timelock = tl; d.timelockMinDelay = delay; d.guardian = guardian || d.guardian; fs.writeFileSync(L.DEPLOYMENT_PATH, JSON.stringify(d, null, 2));
}
main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY])); process.exit(1); });
