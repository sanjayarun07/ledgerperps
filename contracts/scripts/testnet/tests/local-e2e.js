// Local end-to-end of the smoke logic on the in-process hardhat chain (MockUSDC + ManualOracle + the 3 configured markets).
// Run: SMOKE_NO_MAIN=1 npx hardhat --config hardhat.testnet.config.js run scripts/testnet/tests/local-e2e.js
// Proves the smoke script's order sizing / event parsing / call shapes work against the real contracts. NOT a testnet result.
process.env.SMOKE_NO_MAIN = "1";
const { ethers, mergedAbi } = require("../common");
const { deployExchange } = require("../../../test/helpers");
const L = require("../lib");
const os = require("os"), path = require("path");

async function main() {
  const cfg = L.loadConfig();
  const [admin, other] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const oracle = await (await ethers.getContractFactory("ManualOracle")).deploy();
  const ex = await deployExchange(await usdc.getAddress(), await oracle.getAddress(), admin, { lock: false });
  const nominal = { "BTC-USD": 65000e6, "ETH-USD": 1800e6, "SOL-USD": 75e6 };
  for (const m of cfg.markets) { await oracle.set(m.feedId, BigInt(nominal[m.name])); const [mc, t] = L.marketCreateArgs(m); await ex.createMarket(mc, t); }
  await usdc.mint(admin.address, 1_000_000_000n);
  const d = { chainId: 31337, exchange: await ex.getAddress(), usdc: await usdc.getAddress() };
  const { run } = require("../smoke-testnet");
  for (const useT2 of [false, true]) for (const market of ["0", "1", "2"]) {
    process.env.SMOKE_MARKET = market;
    if (useT2) { await usdc.mint(other.address, 1_000_000_000n); }
    const signers = useT2 ? [admin] : [admin];
    // trader2 path needs TRADER2_PRIVATE_KEY; skipped locally (covered by the sub-account path, same code branch except signer)
    if (useT2) continue;
    const rec = await run({ d, chainId: 31337, signers, gate: { ok: true }, out: path.join(os.tmpdir(), "smoke-local.json"), checkDeployer: false });
    console.log(`market ${market}: ok=${rec.summary.ok} failed=${rec.summary.failed}`);
    if (rec.summary.failed) throw new Error("local smoke failed for market " + market);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
