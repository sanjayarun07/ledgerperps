// Bridge plain Sepolia ETH to Arbitrum Sepolia via the official Inbox.depositEth() (credits the SAME address on Arbitrum Sepolia, takes ~10 min).
// Dry run unless CONFIRM_BRIDGE=yes. Refuses unless the connected chain is Ethereum Sepolia (11155111) and the Inbox is verified ON-CHAIN to belong to
// the rollup whose chainId is 421614 (Inbox -> Bridge -> Rollup.chainId()), so a wrong address in this file cannot send funds anywhere else.
//   BRIDGE_ETH=0.3 [CONFIRM_BRIDGE=yes] npx hardhat --config hardhat.sepolia-bridge.config.js run scripts/testnet/bridge-eth-to-arbitrum.js --network sepolia
const hre = require("hardhat");
const INBOX = "0xaAe29B0366299461418F5324a79Afc425BE5ae21"; // Arbitrum Sepolia Inbox on Ethereum Sepolia
(async () => {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 11155111) throw new Error(`REFUSING: chainId ${net.chainId}, this script only runs on Ethereum Sepolia (11155111)`);
  const inbox = new ethers.Contract(INBOX, ["function bridge() view returns (address)", "function depositEth() payable returns (uint256)"], ethers.provider);
  const bridge = new ethers.Contract(await inbox.bridge(), ["function rollup() view returns (address)"], ethers.provider);
  const rollup = new ethers.Contract(await bridge.rollup(), ["function chainId() view returns (uint256)"], ethers.provider);
  const cid = Number(await rollup.chainId());
  if (cid !== 421614) throw new Error(`REFUSING: Inbox ${INBOX} belongs to chain ${cid}, not Arbitrum Sepolia (421614)`);
  const [me] = await ethers.getSigners();
  const amt = ethers.parseEther(process.env.BRIDGE_ETH || "0");
  if (amt <= 0n || amt > ethers.parseEther("5")) throw new Error("set BRIDGE_ETH (0 < amount <= 5)");
  const bal = await ethers.provider.getBalance(me.address);
  console.log(`inbox ${INBOX} verified for chain ${cid}\nfrom ${me.address} (Sepolia balance ${ethers.formatEther(bal)} ETH)\nbridge ${ethers.formatEther(amt)} ETH -> same address on Arbitrum Sepolia`);
  if (bal < amt + ethers.parseEther("0.01")) throw new Error("balance too low (need amount + 0.01 ETH for gas)");
  if (process.env.CONFIRM_BRIDGE !== "yes") return console.log("DRY RUN: set CONFIRM_BRIDGE=yes to send");
  const tx = await inbox.connect(me).depositEth({ value: amt });
  console.log("depositEth tx", tx.hash); await tx.wait(1); console.log("confirmed on Sepolia; arrives on Arbitrum Sepolia in about 10 minutes");
})().catch((e) => { console.error(String(e.shortMessage || e.message).split("\n")[0]); process.exit(1); });
