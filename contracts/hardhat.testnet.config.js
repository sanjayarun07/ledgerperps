// Arbitrum Sepolia (421614) config. Use with:  npx hardhat --config hardhat.testnet.config.js <task> --network arbitrumSepolia
// Compiler settings are INHERITED from hardhat.config.js (single source of truth): solc 0.8.24, viaIR, optimizer runs 200, cancun.
// Secrets come only from the environment (contracts/.env, git-ignored). Nothing here is ever printed.
const fs = require("fs");
const path = require("path");
const { normalizeKey, hygieneProblems, ARB_SEPOLIA_CHAIN_ID, DEFAULT_PUBLIC_RPC } = require("./scripts/testnet/lib.js");

// Minimal .env loader (no dotenv dependency). Real environment variables win over the file.
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

// Refuse to run with any signing key present while secret hygiene is broken (world/group-readable .env, key in a committable file).
if (process.env.DEPLOYER_PRIVATE_KEY || process.env.TRADER2_PRIVATE_KEY) {
  const hp = hygieneProblems();
  if (hp.length) throw new Error("REFUSING to run with a private key loaded:\n - " + hp.join("\n - "));
}
const base = require("./hardhat.config.js");
const k = normalizeKey(process.env.DEPLOYER_PRIVATE_KEY);
if (process.env.DEPLOYER_PRIVATE_KEY && !k.ok) {
  // Reason text never contains the value.
  console.warn(`[testnet config] DEPLOYER_PRIVATE_KEY ignored: ${k.reason}`);
}

module.exports = {
  ...base,
  networks: {
    ...base.networks,
    arbitrumSepolia: {
      url: process.env.ARB_SEPOLIA_RPC_URL || DEFAULT_PUBLIC_RPC, // default is for READ-ONLY checks only; use a dedicated RPC for deploys
      chainId: ARB_SEPOLIA_CHAIN_ID,
      // Lazy: with no key the network works read-only. Scripts that sign call requireSigner() and fail with a clear message.
      accounts: k.ok ? [k.key] : [],
    },
  },
  // A single Etherscan.io v2 key covers Arbiscan / chain 421614 (hardhat-verify >= 2.0.13 uses the v2 endpoint for a string key).
  etherscan: { apiKey: process.env.ARBISCAN_API_KEY || "" },
  sourcify: { enabled: false },
};
