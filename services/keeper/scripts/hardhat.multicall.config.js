// Compiles scripts/sol/Multicall3Lite.sol into $E2E_MC_OUT (never touches contracts/). Used only by tests/e2e.sh.
const path = require("path");
const out = process.env.E2E_MC_OUT || path.join(__dirname, "..", "target", "mc-build");
module.exports = {
  paths: { root: path.join(__dirname, ".."), sources: "./scripts/sol", artifacts: path.join(out, "artifacts"), cache: path.join(out, "cache") },
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
};
