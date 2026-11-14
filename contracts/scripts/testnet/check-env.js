// Read-only environment check. Run: npx hardhat --config hardhat.testnet.config.js run scripts/testnet/check-env.js --network arbitrumSepolia
// Prints the deployer ADDRESS only, never the key. The key is optional for this script (balance check is skipped without it).
const hre = require("hardhat");
const L = require("./lib");
const { ethers } = hre;

async function main() {
  const cfg = L.loadConfig();
  const problems = [], warns = [];
  const rows = [];
  const ok = (k, v) => rows.push({ check: k, result: "OK", detail: v });
  const bad = (k, v) => { rows.push({ check: k, result: "FAIL", detail: v }); problems.push(k); };
  const warn = (k, v) => { rows.push({ check: k, result: "WARN", detail: v }); warns.push(k); };

  const cerr = L.validateConfig(cfg);
  cerr.length ? bad("config", cerr.join("; ")) : ok("config", "infra/testnet/testnet.config.json parses and validates");

  process.env.ARB_SEPOLIA_RPC_URL ? ok("ARB_SEPOLIA_RPC_URL", "set (value not printed; may contain an API key)") : warn("ARB_SEPOLIA_RPC_URL", `unset; using public RPC ${L.DEFAULT_PUBLIC_RPC} (read-only checks only; use a dedicated RPC to deploy)`);
  process.env.ARBISCAN_API_KEY ? ok("ARBISCAN_API_KEY", "set (value not printed)") : warn("ARBISCAN_API_KEY", "unset; needed only for verify-contracts.js");
  const k = L.normalizeKey(process.env.DEPLOYER_PRIVATE_KEY);
  k.ok ? ok("DEPLOYER_PRIVATE_KEY", "set and well-formed (value never printed)") : warn("DEPLOYER_PRIVATE_KEY", `${k.reason}; read-only mode (required for any broadcast)`);

  let chainId;
  try {
    chainId = Number((await ethers.provider.getNetwork()).chainId);
    chainId === L.ARB_SEPOLIA_CHAIN_ID ? ok("chainId", `${chainId} (Arbitrum Sepolia)`) : bad("chainId", `RPC reports ${chainId}, expected ${L.ARB_SEPOLIA_CHAIN_ID}`);
    const blk = await ethers.provider.getBlockNumber();
    ok("latest block", String(blk));
  } catch (e) { bad("rpc", `cannot reach RPC: ${L.redact(e.message, [process.env.ARB_SEPOLIA_RPC_URL]).slice(0, 160)}`); }

  const expected = L.expectedDeployer(cfg);
  expected ? ok("expected deployer", expected) : bad("expected deployer", "expectedDeployer not set");
  let addr = null;
  if (k.ok) {
    addr = new ethers.Wallet(k.key).address;
    ok("deployer address (from key)", addr);
    try { L.assertDeployerMatch(addr, expected); ok("key matches expected deployer", "yes"); } catch (e) { bad("key matches expected deployer", e.message.replace("REFUSING: ", "")); }
  }
  const probe = addr || expected;
  if (probe && chainId === L.ARB_SEPOLIA_CHAIN_ID) {
    const bal = await ethers.provider.getBalance(probe);
    const eth = Number(ethers.formatEther(bal));
    const min = Number(process.env.MIN_DEPLOYER_ETH || "0.02");
    (eth >= min ? ok : warn)("ETH balance " + probe, `${eth} ETH (warns below ${min} ETH; compare with the dry-run gas estimate)`);
    const usdc = new ethers.Contract(cfg.usdc.address, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
    try { const u = await usdc.balanceOf(probe); (u > 0n ? ok : warn)("USDC balance " + probe, `${ethers.formatUnits(u, 6)} USDC (needed for smoke test; faucet: ${cfg.usdc.faucet})`); }
    catch (e) { warn("USDC balance", "balanceOf failed: " + e.message.slice(0, 80)); }
  }
  console.log(L.table(rows));
  console.log(problems.length ? `\nRESULT: FAIL (${problems.join(", ")})` : `\nRESULT: PASS${warns.length ? ` with ${warns.length} warning(s)` : ""}`);
  process.exitCode = problems.length ? 1 : 0;
}
main().catch((e) => { console.error(L.redact(e.message, [process.env.DEPLOYER_PRIVATE_KEY])); process.exit(1); });
