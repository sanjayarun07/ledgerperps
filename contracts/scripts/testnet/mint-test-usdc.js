// Mint MockUSDC ("tUSDC", free test collateral) to an address. ONLY works when the deployment uses MockUSDC (deploy with USE_MOCK_USDC=yes).
// Dry run unless CONFIRM_MINT=yes. Circle test USDC cannot be minted: use the Circle faucet for that.
//   TO=0x... AMOUNT=150000 CONFIRM_MINT=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/mint-test-usdc.js --network arbitrumSepolia
const hre = require("hardhat");
const dep = require("../../deployments/arbitrumSepolia.json");
(async () => {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 421614) throw new Error(`REFUSING: chainId ${net.chainId}, this script only runs on Arbitrum Sepolia (421614)`);
  if (dep.collateral !== "mock") throw new Error(`REFUSING: this deployment's collateral is "${dep.collateral}", not MockUSDC. Redeploy with USE_MOCK_USDC=yes to get mintable test collateral.`);
  const to = process.env.TO;
  if (!ethers.isAddress(to || "")) throw new Error("set TO=<address>");
  const amount = BigInt(Math.round(Number(process.env.AMOUNT || "0") * 1e6));
  if (amount <= 0n || amount > 10_000_000n * 1_000_000n) throw new Error("set AMOUNT (test USDC, 0 < AMOUNT <= 10,000,000)");
  const [me] = await ethers.getSigners();
  const usdc = new ethers.Contract(dep.usdc, ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"], me);
  console.log(`token ${dep.usdc} (MockUSDC, free test collateral, NOT real USDC)\nmint ${Number(amount) / 1e6} to ${to} (balance now ${Number(await usdc.balanceOf(to)) / 1e6})`);
  if (process.env.CONFIRM_MINT !== "yes") return console.log("DRY RUN: set CONFIRM_MINT=yes to send");
  console.log("mint tx", (await (await usdc.mint(to, amount)).wait(1)).hash);
})().catch((e) => { console.error(String(e.shortMessage || e.message).split("\n")[0]); process.exit(1); });
