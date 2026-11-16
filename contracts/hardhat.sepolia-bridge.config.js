// Plain Ethereum Sepolia (11155111) network, ONLY for scripts/testnet/bridge-eth-to-arbitrum.js. Reuses the deployer key from contracts/.env via the testnet config.
const t = require("./hardhat.testnet.config.js");
module.exports = { ...t, networks: { ...t.networks, sepolia: { url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", chainId: 11155111, accounts: t.networks.arbitrumSepolia.accounts } } };
