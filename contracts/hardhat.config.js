require("@nomicfoundation/hardhat-toolbox");
module.exports = {
  paths: { sources: "./src", tests: "./test" },
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" } },
  // EIP-170 (24 KB) is ENFORCED: every deployed contract must fit.
  networks: { hardhat: { allowUnlimitedContractSize: false }, localhost: { url: "http://127.0.0.1:8545" } },
};
