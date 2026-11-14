// Seeds LOCAL dev accounts: mints MockUSDC to the first 10 hardhat accounts and deposits into subaccount 0.
// Run inside the deployer container / from contracts/:  npx hardhat run <this file> --network localhost
// Reads deployments/<network>.json written by scripts/deploy.js. Test values only.
const path = require("path");
const { createRequire } = require("module");
const req = createRequire(path.join(process.cwd(), "package.json"));
const hre = req("hardhat");
const { ethers, network } = hre;
const fs = require("fs");
async function main() {
  const d = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const signers = await ethers.getSigners();
  const usdc = await ethers.getContractAt("MockUSDC", d.usdc);
  const abi = JSON.parse(fs.readFileSync(path.join(process.cwd(), process.env.MERGED_ABI || "abi/PerpExchange.merged.json"), "utf8"));
  const ex = new ethers.Contract(d.exchange, abi, signers[0]);
  const amount = 1_000_000n * 10n ** 6n;
  for (const s of signers.slice(0, 10)) {
    await (await usdc.mint(s.address, amount)).wait();
    await (await usdc.connect(s).approve(d.exchange, ethers.MaxUint256)).wait();
    await (await ex.connect(s).deposit(s.address, 0, amount / 2n)).wait();
  }
  console.log(`seeded ${Math.min(10, signers.length)} accounts: 1,000,000 tUSDC minted, 500,000 deposited to subaccount 0`);
}
main().catch((e) => { console.error(e); process.exit(1); });
