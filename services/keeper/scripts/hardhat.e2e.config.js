// Hardhat config used ONLY by the keeper e2e. It reuses the (read-only) contracts project but lets the node run on a
// configurable port and keeps all outputs out of contracts/. Nothing under contracts/ is modified.
const path = require("path");
const contracts = path.resolve(__dirname, "../../../contracts");
const base = require(path.join(contracts, "hardhat.config.js"));
const port = process.env.E2E_PORT || "18545";
module.exports = {
  ...base,
  paths: { root: contracts, sources: "./src", tests: "./test" },
  networks: { hardhat: { ...base.networks.hardhat, mining: { auto: true, interval: 0 } }, localhost: { url: `http://127.0.0.1:${port}` } },
};
