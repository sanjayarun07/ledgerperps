// Enable backstop PHASE 2 (inventory soft cap + Dutch auction + forced unwind) per market. DRY-RUN BY DEFAULT.
//   dry-run (read-only, no key needed):  npx hardhat --config hardhat.testnet.config.js run scripts/testnet/enable-backstop.js --network arbitrumSepolia
//   BROADCAST (admin key, chainId 421614): CONFIRM_ENABLE_BACKSTOP=yes npx hardhat ... run scripts/testnet/enable-backstop.js --network arbitrumSepolia
// Values come from infra/testnet/testnet.config.json -> "backstop" (BTC-USD scaled from docs/RUNBOOKS.md 0b; DEMO-USD tiny and fast so it can be watched
// within minutes). Only markets that exist in the deployment AND have a config entry are touched; BACKSTOP_MARKETS=BTC-USD,DEMO-USD narrows further.
// The caller must hold DEFAULT_ADMIN_ROLE (checked before sending). Nothing here ever prints a key. Output: infra/testnet/backstop-enable-last-run.json.
const fs = require("fs"); const path = require("path");
const { ethers, ctx, mergedAbi, loadDeployment } = require("./common");
const L = require("./lib");
const OUT = path.join(__dirname, "..", "..", "..", "infra", "testnet", "backstop-enable-last-run.json");
const EXPLORER = "https://sepolia.arbiscan.io";

async function main() {
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  return run({ d: loadDeployment(), chainId, signers, gate: L.broadcastGate("CONFIRM_ENABLE_BACKSTOP", chainId), out: OUT, checkDeployer: true });
}

// Exported so tests/backstop-scripts-local.js can drive the same logic on the in-process chain (never used for real networks other than via main()).
async function run({ d, chainId, signers, gate, out, checkDeployer, cfg = L.loadConfig(), env = process.env }) {
  const live = gate.ok;
  console.log(live ? "MODE: BROADCAST (sends real transactions)" : `MODE: DRY-RUN (read-only; ${gate.reason})`);
  const ex = new ethers.Contract(d.exchange, await mergedAbi(), ethers.provider);
  const only = env.BACKSTOP_MARKETS ? env.BACKSTOP_MARKETS.split(",").map((x) => x.trim()) : null;
  const plan = [];
  for (const m of cfg.markets) {
    const c = cfg.backstop && cfg.backstop[m.name];
    const id = d.marketIds && d.marketIds[m.name];
    if (!c || id === undefined) continue;
    if (only && !only.includes(m.name)) continue;
    const probs = L.backstopCfgProblems(m.name, c, m.params.bandBps);
    if (probs.length) throw new Error("backstop config invalid:\n - " + probs.join("\n - "));
    plan.push({ name: m.name, id: Number(id), c });
  }
  if (!plan.length) throw new Error("nothing to do: no market in this deployment has a 'backstop' entry in testnet.config.json (or BACKSTOP_MARKETS excludes them all)");

  let signer = null;
  if (live) {
    signer = L.requireSigner(signers, "enable-backstop");
    if (checkDeployer) L.assertDeployerMatch(signer.address, L.expectedDeployer(cfg));
    const adminRole = await ex.DEFAULT_ADMIN_ROLE();
    if (!(await ex.hasRole(adminRole, signer.address))) throw new Error(`REFUSING: ${signer.address} does not hold DEFAULT_ADMIN_ROLE on ${d.exchange}`);
  }
  const from = signer ? signer.address : L.expectedDeployer(cfg) || ethers.ZeroAddress;
  const rows = []; const txs = [];
  for (const p of plan) {
    const cur = await ex.backstopCfg(p.id);
    const args = [p.id, BigInt(p.c.softNotional), p.c.maxDiscBps, p.c.dwell, p.c.ramp, p.c.maxAge];
    let gas = "-";
    try { gas = (await ethers.provider.estimateGas({ from, to: d.exchange, data: ex.interface.encodeFunctionData("setBackstopCfg", args) })).toString(); } catch (e) { gas = "n/a (" + (e.shortMessage || "estimate failed").slice(0, 40) + ")"; }
    rows.push({ market: p.name, id: p.id, "soft(USDC)": Number(p.c.softNotional) / 1e6, maxDisc: p.c.maxDiscBps, dwell: p.c.dwell, ramp: p.c.ramp, maxAge: p.c.maxAge, "now soft": Number(cur.softNotional) / 1e6, gas });
    if (live) {
      const tx = await ex.connect(signer).setBackstopCfg(...args); const rc = await tx.wait(1);
      const back = await ex.backstopCfg(p.id);
      if (back.softNotional !== BigInt(p.c.softNotional) || Number(back.maxAge) !== p.c.maxAge) throw new Error(`${p.name}: read-back mismatch after setBackstopCfg`);
      txs.push({ market: p.name, hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), arbiscan: chainId === L.ARB_SEPOLIA_CHAIN_ID ? `${EXPLORER}/tx/${rc.hash}` : null });
      console.log(`  ${p.name}: setBackstopCfg ok tx ${rc.hash} gas ${rc.gasUsed}`);
    }
  }
  console.log(L.table(rows));
  console.log("Not changed by this script: take fee (default 0 bps), backstopPlace switch, ADL parameters.");
  if (!live) { console.log("\nDRY-RUN: nothing sent. To broadcast: CONFIRM_ENABLE_BACKSTOP=yes (admin key; see docs/TESTNET_RUNBOOK.md)."); return { live, plan: rows }; }
  const rec = { ranAt: new Date().toISOString(), chainId, exchange: d.exchange, admin: signer.address, gitCommit: L.gitCommit(), configHash: L.configHash(cfg), markets: plan.map((p) => ({ name: p.name, id: p.id, ...p.c })), txs };
  fs.writeFileSync(out, JSON.stringify(rec, null, 2));
  console.log(`\nWrote ${out}`);
  return rec;
}
module.exports = { run };
if (!process.env.ENABLE_NO_MAIN) main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY, process.env.TRADER2_PRIVATE_KEY, process.env.ARB_SEPOLIA_RPC_URL])); process.exit(1); });
