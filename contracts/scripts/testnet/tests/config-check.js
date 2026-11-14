const hre = require("hardhat");
const base = require("../../../hardhat.config.js");
const c = hre.config;
const norm = (s) => ({ version: s.compilers[0].version, settings: s.compilers[0].settings });
console.log("CFG:" + JSON.stringify([{ version: c.solidity.compilers[0].version, settings: c.solidity.compilers[0].settings }, { version: base.solidity.version, settings: base.solidity.settings }, c.networks.arbitrumSepolia.chainId, c.networks.arbitrumSepolia.accounts]));
