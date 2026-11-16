// Send testnet ETH (gas) from the deployer to a wallet on Arbitrum Sepolia. Dry run unless CONFIRM_SEND_ETH=yes. Refuses contracts and the deployer itself.
//   TO=0x... ETH=0.1 [CONFIRM_SEND_ETH=yes] npx hardhat --config hardhat.testnet.config.js run scripts/testnet/send-eth.js --network arbitrumSepolia
const hre = require("hardhat");
(async () => {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 421614) throw new Error(`REFUSING: chainId ${net.chainId}, this script only runs on Arbitrum Sepolia (421614)`);
  const [me] = await ethers.getSigners();
  const to = process.env.TO;
  if (!ethers.isAddress(to || "")) throw new Error("set TO=<address>");
  if (to.toLowerCase() === me.address.toLowerCase()) throw new Error("TO is the deployer");
  if ((await ethers.provider.getCode(to)) !== "0x") throw new Error("REFUSING: TO is a contract");
  const amt = ethers.parseEther(process.env.ETH || "0");
  if (amt <= 0n || amt > ethers.parseEther("2")) throw new Error("set ETH (0 < amount <= 2)");
  const bal = await ethers.provider.getBalance(me.address);
  console.log(`from ${me.address} (${ethers.formatEther(bal)} ETH)\nto   ${to} (${ethers.formatEther(await ethers.provider.getBalance(to))} ETH)\nsend ${ethers.formatEther(amt)} ETH`);
  if (bal < amt + ethers.parseEther("0.002")) throw new Error("deployer would be left with less than 0.002 ETH");
  if (process.env.CONFIRM_SEND_ETH !== "yes") return console.log("DRY RUN: set CONFIRM_SEND_ETH=yes to send");
  console.log("tx", (await (await me.sendTransaction({ to, value: amt })).wait(1)).hash);
})().catch((e) => { console.error(String(e.shortMessage || e.message).split("\n")[0]); process.exit(1); });
