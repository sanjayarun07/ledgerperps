// Delayed-inbox path on the local testnode (parent-chain submission -> L2 inclusion). Uses a throwaway L1 wallet funded from the PUBLIC dev key.
// Does NOT test SequencerInbox.forceInclusion (needs a censoring/stopped sequencer + maxTimeVariation delay).
// Run: cd contracts && npx hardhat --config hardhat.nitro.config.js run ../infra/nitro-local/delayed.js --network nitroLocal
const { ethers } = require("hardhat");
const d = require("../../contracts/deployments/nitroLocal.json");
const L1 = new ethers.JsonRpcProvider("http://127.0.0.1:8545"), L2 = ethers.provider;
const DEV = "0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659"; // public testnode dev key
const INBOX = "0x627Ad2B14d747b011fF32C56077548DE8c889C31", SEQINBOX = "0xB9A30A902CAe17cb95Ed67Bca153E52969c3e443";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const dev = new ethers.Wallet(DEV, L1);
  const f = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("nitro-local-throwaway:delayed")), L1);
  const inbox = new ethers.Contract(INBOX, ["function depositEth() payable returns (uint256)",
    "function sendUnsignedTransaction(uint256 gasLimit,uint256 maxFeePerGas,uint256 nonce,address to,uint256 value,bytes data) returns (uint256)"], f);
  const si = new ethers.Contract(SEQINBOX, ["function maxTimeVariation() view returns (uint256,uint256,uint256,uint256)"], L1);
  try { console.log("SequencerInbox.maxTimeVariation (delayBlocks,futureBlocks,delaySeconds,futureSeconds):", (await si.maxTimeVariation()).map(String).join(", ")); } catch (e) { console.log("maxTimeVariation read failed:", e.shortMessage || e.message); }
  await (await dev.sendTransaction({ to: f.address, value: ethers.parseEther("1") })).wait();
  const t0 = Date.now();
  const r1 = await (await inbox.depositEth({ value: ethers.parseEther("0.1") })).wait();
  console.log("L1 depositEth mined in L1 block", r1.blockNumber, "after", Date.now() - t0, "ms");
  let t1 = null; while (Date.now() - t0 < 120000) { if ((await L2.getBalance(f.address)) > 0n) { t1 = Date.now(); break; } await sleep(250); }
  console.log("L2 balance of the depositor > 0 after", t1 ? t1 - t0 : "NOT REACHED", "ms (delayed message sequenced by the node's delayed-sequencer)");
  const ex = d.exchange, data = new ethers.Interface(["function pokeFunding(uint8)"]).encodeFunctionData("pokeFunding", [1]);
  const t2 = Date.now();
  const r2 = await (await inbox.sendUnsignedTransaction(500000, 1_000_000_000, 0, ex, 0, data)).wait();
  console.log("L1 sendUnsignedTransaction(pokeFunding) mined in L1 block", r2.blockNumber);
  let t3 = null; while (Date.now() - t2 < 120000) { if ((await L2.getTransactionCount(f.address)) >= 1) { t3 = Date.now(); break; } await sleep(250); }
  console.log("L2 nonce of sender advanced after", t3 ? t3 - t2 : "NOT REACHED", "ms; L2 nonce =", await L2.getTransactionCount(f.address));
}
main().catch((e) => { console.error(e); process.exit(1); });
