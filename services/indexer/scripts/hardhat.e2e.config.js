// Hardhat config used ONLY by the indexer e2e. It reuses the (read-only) contracts project config but points the
// `localhost` network at an e2e-specific port so it never collides with other nodes. Nothing in contracts/ is edited.
const path = require("path");
const CONTRACTS = process.env.CONTRACTS_DIR || path.resolve(__dirname, "../../../contracts");
const base = require(path.join(CONTRACTS, "hardhat.config.js"));
module.exports = {
  ...base,
  paths: { root: CONTRACTS, sources: path.join(CONTRACTS, "src"), tests: path.join(CONTRACTS, "test") },
  networks: {
    ...base.networks,
    hardhat: { ...(base.networks && base.networks.hardhat), mining: { auto: true, interval: 0 } },
    localhost: { url: process.env.E2E_RPC || "http://127.0.0.1:18545" },
  },
};
