// hardhat-dependent helpers shared by the testnet scripts.
const hre = require("hardhat");
const L = require("./lib");
const { ethers } = hre;

const MODULES = ["PerpTrading", "PerpExtras", "PerpLiquidation", "PerpTwap", "PerpAdl"];
const OKF = (f) => ["function", "event", "error"].includes(f.type);

/** Same selector-registration logic as test/helpers.js deployExchange (core ABI wins; module-only functions are routed). */
async function moduleSelectors() {
  const coreIface = (await ethers.getContractFactory("PerpExchange")).interface;
  const seen = new Set(coreIface.fragments.filter(OKF).map((f) => f.format()));
  const out = {};
  for (const name of MODULES) {
    const f = await ethers.getContractFactory(name);
    const sels = [];
    for (const frag of f.interface.fragments.filter(OKF)) {
      const key = frag.format();
      if (frag.type === "function" && !seen.has(key)) sels.push(f.interface.getFunction(key).selector);
      seen.add(key);
    }
    out[name] = sels;
  }
  return out;
}

/** Merged router+module ABI (same merge as test/helpers.js), for talking to the router address. */
async function mergedAbi() {
  const coreIface = (await ethers.getContractFactory("PerpExchange")).interface;
  const seen = new Set(coreIface.fragments.filter(OKF).map((f) => f.format()));
  const merged = coreIface.fragments.filter(OKF);
  for (const name of MODULES) {
    const f = await ethers.getContractFactory(name);
    for (const frag of f.interface.fragments.filter(OKF)) { const k = frag.format(); if (!seen.has(k)) { seen.add(k); merged.push(frag); } }
  }
  return merged;
}

async function deployedSize(name) {
  const a = await hre.artifacts.readArtifact(name);
  return (a.deployedBytecode.length - 2) / 2;
}

async function ctx({ chains, needSigner = false, what = "this step" } = {}) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chains && !chains.includes(chainId)) throw new Error(`REFUSING: chainId ${chainId} not in allowed set [${chains.join(",")}]. Check --network / ARB_SEPOLIA_RPC_URL.`);
  const signers = await ethers.getSigners();
  const signer = needSigner ? L.requireSigner(signers, what) : signers[0] || null;
  return { chainId, signer, signers, provider: ethers.provider };
}

function loadDeployment() {
  const fs = require("fs");
  if (!fs.existsSync(L.DEPLOYMENT_PATH)) throw new Error(`No ${L.DEPLOYMENT_PATH}; run deploy-testnet.js first.`);
  return JSON.parse(fs.readFileSync(L.DEPLOYMENT_PATH, "utf8"));
}

module.exports = { hre, ethers, MODULES, moduleSelectors, mergedAbi, deployedSize, ctx, loadDeployment };
