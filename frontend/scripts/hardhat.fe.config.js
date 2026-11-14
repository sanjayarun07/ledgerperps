// Hardhat config used ONLY by the frontend dev harness. Reuses the (read-only) contracts project config but points the
// `fe` network at a dedicated port so it never collides with another node. Run it with cwd = frontend/.fe so that
// contracts/scripts/deploy.js writes `deployments/fe.json` under frontend/.fe (nothing in contracts/ is modified).
const path = require("path");
const CONTRACTS = process.env.CONTRACTS_DIR || path.resolve(__dirname, "../../contracts");
const base = require(path.join(CONTRACTS, "hardhat.config.js"));
module.exports = {
  ...base,
  paths: { root: CONTRACTS, sources: path.join(CONTRACTS, "src"), tests: path.join(CONTRACTS, "test") },
  networks: {
    ...base.networks,
    fe: { url: process.env.FE_RPC || "http://127.0.0.1:18647" },
  },
};
