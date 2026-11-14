// Local Nitro testnode ONLY. Key below is the PUBLIC dev key hard-coded in OffchainLabs/nitro-testnode/test-node.bash
// (devprivkey). It is publicly known: never use it, or this config, on any real network or with real funds.
// Usage: npx hardhat --config hardhat.nitro.config.js run scripts/deploy.js --network nitroLocal
const base = require("./hardhat.config.js");
const TESTNODE_PUBLIC_DEV_KEY = "0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659";
module.exports = {
  ...base,
  networks: {
    ...base.networks,
    nitroLocal: {
      url: process.env.NITRO_L2_RPC || "http://127.0.0.1:8547",
      chainId: 412346,
      accounts: [TESTNODE_PUBLIC_DEV_KEY],
    },
  },
};
