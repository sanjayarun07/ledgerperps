// Send testnet ETH (gas) and Circle test USDC from the deployer to the market-maker bot address. Dry run unless CONFIRM_FUND_MM=yes.
//   MM_ADDRESS=0x... [MM_ETH=0.003] [MM_USDC=20] CONFIRM_FUND_MM=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/fund-mm.js --network arbitrumSepolia
const hre = require("hardhat");
const dep = require("../../deployments/arbitrumSepolia.json");
(async () => {
  const { ethers } = hre; const [me] = await ethers.getSigners();
  const to = process.env.MM_ADDRESS; if (!ethers.isAddress(to || "")) throw new Error("set MM_ADDRESS");
  if (to.toLowerCase() === me.address.toLowerCase()) throw new Error("MM_ADDRESS is the deployer");
  const eth = ethers.parseEther(process.env.MM_ETH || "0.003"), usdcAmt = BigInt(Math.round(Number(process.env.MM_USDC || "20") * 1e6));
  const usdc = new ethers.Contract(dep.usdc, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], me);
  console.log(`from ${me.address} (ETH ${ethers.formatEther(await ethers.provider.getBalance(me.address))}, USDC ${Number(await usdc.balanceOf(me.address)) / 1e6})`);
  console.log(`to   ${to}: ${ethers.formatEther(eth)} ETH + ${Number(usdcAmt) / 1e6} test USDC`);
  if (process.env.CONFIRM_FUND_MM !== "yes") return console.log("DRY RUN: set CONFIRM_FUND_MM=yes to send");
  console.log("ETH tx", (await (await me.sendTransaction({ to, value: eth })).wait(1)).hash);
  console.log("USDC tx", (await (await usdc.transfer(to, usdcAmt)).wait(1)).hash);
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
