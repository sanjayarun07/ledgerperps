// Testnet deploy. DRY-RUN BY DEFAULT.
//   dry-run (real RPC, no tx):   npx hardhat --config hardhat.testnet.config.js run scripts/testnet/deploy-testnet.js --network arbitrumSepolia
//   local simulation (in-proc):  LOCAL_SIMULATE=1 npx hardhat --config hardhat.testnet.config.js run scripts/testnet/deploy-testnet.js     (or pass --local-simulate to node-launched wrappers)
//   BROADCAST:                   CONFIRM_TESTNET_DEPLOY=yes npx hardhat ... run ... --network arbitrumSepolia
// Broadcast requires: chainId==421614, CONFIRM_TESTNET_DEPLOY=yes, key address == expectedDeployer, config verified on-chain <24h ago.
// The module table is deliberately LEFT UNLOCKED (see lock-modules.js). ADMIN stays the deployer EOA until transfer-admin.js.
const fs = require("fs");
const { ethers, MODULES, moduleSelectors, deployedSize, hre } = require("./common");
const L = require("./lib");

async function main() {
  const cfg = L.loadConfig();
  const errs = L.validateConfig(cfg);
  if (errs.length) throw new Error("Config invalid:\n - " + errs.join("\n - "));
  const LOCAL = L.isLocalSimulate();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (LOCAL) { if (chainId !== L.HARDHAT_CHAIN_ID) throw new Error(`REFUSING: --local-simulate only runs on the in-process hardhat network (31337), got ${chainId}.`); }
  else L.assertChainId(chainId);

  const signers = await ethers.getSigners();
  const signer = signers[0] || null;
  const gate = LOCAL ? { ok: false, reason: "local simulation" } : L.broadcastGate("CONFIRM_TESTNET_DEPLOY", chainId);
  const broadcast = gate.ok;
  const execute = broadcast || LOCAL; // LOCAL really sends txs, but only to the throwaway in-process chain
  // Oracle for the REAL markets. testnet: ORACLE_MODE=median (Chainlink+Pyth via MedianOracle, both fresh) | chainlink (ChainlinkAdapter directly, no Pyth);
  // default = cfg.oracle.mode ('chainlink' unless Pyth was observed fresh, see verify-addresses.js). local simulation: manual (default) or median.
  if (!LOCAL && process.env.ORACLE_MODE === "manual") throw new Error("ORACLE_MODE=manual (ManualOracle) is only allowed with --local-simulate; testnet uses real feeds.");
  const oracleMode = LOCAL ? (process.env.ORACLE_MODE === "median" ? "median" : "manual") : L.resolveOracleMode(cfg);
  const demo = L.demoEnabled(cfg);
  const demoMkt = demo ? cfg.markets.find((m) => m.oracleMode === "demo") : null;
  if (demo && !demoMkt) throw new Error("DEMO market enabled but the config has no oracleMode=demo market");

  if (broadcast) {
    const s = L.requireSigner(signers, "broadcast");
    L.assertDeployerMatch(s.address, L.expectedDeployer(cfg));
    const vp = L.verificationProblems(cfg, 24, Date.now(), oracleMode);
    if (vp.length) throw new Error("REFUSING to broadcast; run verify-addresses.js first:\n - " + vp.join("\n - "));
  }
  const deployer = LOCAL ? signer.address : (signer ? signer.address : L.expectedDeployer(cfg));
  const guardian = process.env.GUARDIAN_ADDRESS || null;
  if (guardian && !L.ADDR_RE.test(guardian)) throw new Error("GUARDIAN_ADDRESS malformed");
  const usdcMode = LOCAL ? "mock" : process.env.USE_MOCK_USDC === "yes" ? "mock" : "circle";

  console.log(`MODE: ${broadcast ? "BROADCAST (real transactions)" : LOCAL ? "LOCAL SIMULATION (in-process chain, mocks)" : "DRY-RUN (no transactions sent)"}`);
  if (!LOCAL && !broadcast) console.log(`  (broadcast disabled: ${gate.reason})`);
  console.log(`chainId=${chainId} deployer=${deployer} guardian=${guardian || "none"} collateral=${usdcMode} oracle=${oracleMode} demoMarket=${demo ? "DEMO-USD (admin-set price, NOT a real feed)" : "off"}`);

  // ---------------- execution engine: one code path for dry-run and real
  const plan = [];
  let nonce = !execute ? await ethers.provider.getTransactionCount(deployer) : 0;
  const results = { contracts: {}, txs: [] };
  const feeData = await ethers.provider.getFeeData();
  async function step(label, kind, estimateFn, sendFn, predictAddr) {
    const row = { n: plan.length + 1, step: label, gas: "-", note: "" };
    plan.push(row);
    if (execute) {
      const tx = await sendFn(); const rc = await tx.wait();
      row.gas = rc.gasUsed.toString(); row.note = `blk ${rc.blockNumber}`;
      results.txs.push({ label, hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString() });
      return rc;
    }
    try { row.gas = (await estimateFn()).toString(); } catch (e) { row.note = "estimate n/a until prior steps exist"; }
    nonce++;
    return null;
  }
  const addrs = {}; // name -> address (real or predicted)
  async function deploy(name, factoryName, args, label = name) {
    const f = await ethers.getContractFactory(factoryName);
    const size = await deployedSize(factoryName);
    if (size >= L.EIP170) throw new Error(`${factoryName} deployed size ${size} >= ${L.EIP170}`);
    const predicted = ethers.getCreateAddress({ from: deployer, nonce }); // predicted CREATE address (dry-run only)
    let contract = null;
    const rc = await step(`deploy ${label}`, "deploy",
      async () => ethers.provider.estimateGas({ ...(await f.getDeployTransaction(...args)), from: deployer }),
      async () => { contract = await f.deploy(...args); return contract.deploymentTransaction(); });
    const addr = execute ? await contract.getAddress() : predicted;
    addrs[label] = addr;
    results.contracts[label] = { address: addr, contract: factoryName, ctorArgs: args.map((a) => (typeof a === "bigint" ? a.toString() : a)), sizeBytes: size, ...(rc ? { block: rc.blockNumber, tx: rc.hash } : {}) };
    plan[plan.length - 1].note = (plan[plan.length - 1].note + ` size=${size}B -> ${addr}`).trim();
    return execute ? contract : { target: addr, getAddress: async () => addr };
  }
  async function call(label, contract, method, args) {
    return step(`call ${label}`, "call", async () => { if (!execute && contract.interface === undefined) throw new Error("n/a"); return contract.getFunction(method).estimateGas(...args); },
      () => contract.getFunction(method)(...args));
  }

  // 1. collateral
  const cfgUsdc = cfg.usdc.address;
  let usdcAddr = cfgUsdc;
  if (usdcMode === "mock") { const u = await deploy("MockUSDC", "MockUSDC", []); usdcAddr = await u.getAddress(); }

  // 2. oracle (real markets)
  let oracleAddr, manual = null;
  const med = cfg.markets.filter((m) => m.oracleMode === "median");
  const skipped = cfg.markets.filter((m) => m.oracleMode === "manual");
  if (oracleMode === "manual") {
    manual = await deploy("ManualOracle", "ManualOracle", []); oracleAddr = await manual.getAddress();
  } else {
    const cl = await deploy("ChainlinkAdapter", "ChainlinkAdapter", []);
    // Dry-run cannot estimate calls on not-yet-existing contracts: they are listed, not estimated.
    for (const m of med) await call(`ChainlinkAdapter.setFeed(${m.name})`, execute ? cl : { }, "setFeed", [m.feedId, m.chainlink.address]);
    for (const m of med) if (m.chainlink.bounds) await call(`ChainlinkAdapter.setBounds(${m.name})`, execute ? cl : { }, "setBounds", [m.feedId, m.chainlink.bounds.min, m.chainlink.bounds.max]);
    if (oracleMode === "median") {
      const py = await deploy("PythAdapter", "PythAdapter", [cfg.pyth.address, BigInt(cfg.oracle.pythMaxConfBps)]);
      const mo = await deploy("MedianOracle", "MedianOracle", [await cl.getAddress(), await py.getAddress(), BigInt(cfg.oracle.medianMaxAgeSecs), BigInt(cfg.oracle.medianMaxDevBps)]);
      oracleAddr = await mo.getAddress();
    } else oracleAddr = await cl.getAddress(); // chainlink mode: the adapter IS the exchange oracle
  }
  // 2b. optional DEMO market oracle: an admin-set ManualOracle, reachable only for the demo feed id through the immutable RoutingOracle
  let demoManual = null, routing = null;
  if (demoMkt) {
    demoManual = await deploy("ManualOracle", "ManualOracle", [], "DemoManualOracle");
    routing = await deploy("RoutingOracle", "RoutingOracle", [oracleAddr, await demoManual.getAddress(), demoMkt.feedId]);
    oracleAddr = await routing.getAddress();
  }
  // 3. exchange + modules (same logic as test/helpers.js deployExchange, minus lockModules)
  const ex = await deploy("PerpExchange", "PerpExchange", [usdcAddr, oracleAddr, deployer], "PerpExchange");
  const sels = await moduleSelectors();
  for (const name of MODULES) {
    const mod = await deploy(name, name, []);
    await call(`PerpExchange.registerModule(${name}, ${sels[name].length} selectors)`, execute ? ex : {}, "registerModule", [await mod.getAddress(), sels[name]]);
  }
  // 4. markets
  const created = [];
  for (const m of [...(oracleMode === "manual" ? cfg.markets.filter((x) => x.oracleMode !== "demo") : med), ...(demoMkt ? [demoMkt] : [])]) {
    const [mc, tiers] = L.marketCreateArgs(m);
    await call(`PerpExchange.createMarket(${m.name})`, execute ? ex : {}, "createMarket", [mc, tiers]);
    created.push(m);
  }
  // 5. manual prices (local sim only) and the initial DEMO price (any executing mode; it is NOT market data)
  if (manual && execute) {
    const nominal = { "BTC-USD": 50000e6, "ETH-USD": 3000e6, "SOL-USD": 150e6 };
    for (const m of created.filter((x) => x.oracleMode !== "demo")) await call(`ManualOracle.set(${m.name})`, manual, "set", [m.feedId, BigInt(nominal[m.name])]);
  }
  if (demoMkt && demoManual) await call(`DemoManualOracle.set(DEMO-USD) = ${Number(cfg.demo.startPrice) / 1e6} (admin-set, NOT a real feed)`, execute ? demoManual : {}, "set", [demoMkt.feedId, BigInt(cfg.demo.startPrice)]);
  // 6. guardian
  if (guardian) {
    const gr = execute ? await ex.GUARDIAN_ROLE() : ethers.id("GUARDIAN_ROLE");
    await call(`PerpExchange.grantRole(GUARDIAN_ROLE, ${guardian})`, execute ? ex : {}, "grantRole", [gr, guardian]);
  }
  // NOTE: no lockModules() here, by design.

  console.log("\nPLAN / RESULT");
  console.log(L.table(plan));
  const totalGas = plan.reduce((a, r) => a + (/^\d+$/.test(r.gas) ? BigInt(r.gas) : 0n), 0n);
  const price = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  console.log(`\nSum of gas figures shown: ${totalGas}${execute ? "" : " (estimates only for steps that do not depend on undeployed contracts; real total is higher)"}`);
  if (price) console.log(`Current max fee per gas: ${ethers.formatUnits(price, "gwei")} gwei -> ~${ethers.formatEther(totalGas * price)} ETH for the shown gas`);
  if (skipped.length && oracleMode !== "manual") console.log(`Skipped (no real feed): ${skipped.map((m) => m.name).join(", ")} -> manual-oracle-only (testnet demo)`);
  if (demoMkt) console.log(`DEMO-USD (id ${created.indexOf(demoMkt)}): priced by an admin-set ManualOracle through RoutingOracle. NOT a real feed. Disable with DEMO_MARKET=no.`);
  console.log("Module table: UNLOCKED (run lock-modules.js after smoke tests).");

  if (!execute) { console.log("\nNothing was sent. To broadcast: CONFIRM_TESTNET_DEPLOY=yes ... (see docs/TESTNET_RUNBOOK.md)"); return; }

  const exAddr = await ex.getAddress();
  const out = {
    env: LOCAL ? "LOCAL-SIMULATION (mock USDC, manual oracle)" : "TESTNET-ARBITRUM-SEPOLIA (unaudited prototype; modules unlocked)",
    chainId, deployer, admin: deployer, guardian, collateral: usdcMode === "mock" ? "mock" : "circle-testnet-usdc",
    usdc: usdcAddr, oracle: oracleAddr, exchange: exAddr,
    oracleMode: LOCAL ? `local-${oracleMode}` : oracleMode,
    feeds: Object.fromEntries(created.map((m) => [m.name, m.feedId])),
    marketIds: Object.fromEntries(created.map((m, i) => [m.name, i])),
    demo: demoMkt ? { market: "DEMO-USD", marketId: created.indexOf(demoMkt), label: demoMkt.label, feed: demoMkt.feedId, manualOracle: addrs.DemoManualOracle, routingOracle: addrs.RoutingOracle, startPrice: cfg.demo.startPrice } : null,
    contracts: results.contracts, transactions: results.txs,
    startBlock: Math.min(...results.txs.map((t) => t.block)),
    configHash: L.configHash(cfg), gitCommit: L.gitCommit(), modulesLocked: false,
    compiler: { solc: "0.8.24", viaIR: true, optimizerRuns: 200, evmVersion: "cancun" },
    deployedAt: new Date().toISOString(),
  };
  const target = LOCAL ? (process.env.LOCAL_SIM_OUT || null) : L.DEPLOYMENT_PATH;
  if (!target) { console.log("\n(local simulation: deployment file not written; set LOCAL_SIM_OUT=<path> to write one)"); }
  else {
    if (!LOCAL && fs.existsSync(target)) throw new Error(`${target} already exists; move it aside to redeploy (deployment NOT recorded, addresses above)`);
    fs.mkdirSync(require('path').dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(out, null, 2)); console.log(`\nWrote ${target}`);
  }
  if (LOCAL) {
    // sanity: selector table equals what the router reports
    const r = new ethers.Contract(exAddr, ["function moduleOf(bytes4) view returns (address)", "function modulesLocked() view returns (bool)", "function marketCount() view returns (uint8)"], signer);
    let n = 0; for (const name of MODULES) for (const s of sels[name]) { if ((await r.moduleOf(s)) !== results.contracts[name].address) throw new Error("selector mismatch " + s); n++; }
    console.log(`Local sanity: ${n} selectors routed correctly; modulesLocked=${await r.modulesLocked()}; marketCount=${await r.marketCount()}`);
  }
}
module.exports = { main };
if (!process.env.DEPLOY_NO_MAIN) main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY, process.env.ARB_SEPOLIA_RPC_URL])); process.exit(1); });
