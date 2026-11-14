// Withdraw min(withdrawable, exchange USDC balance) for the deployer's sub-account 0. Use when a demo left unresolved bad debt
// (ledger owes more than the contract holds) and a full withdraw reverts with "transfer amount exceeds balance".
const hre = require("hardhat");
const abi = require("../../abi/PerpExchange.merged.json");
const dep = require("../../deployments/arbitrumSepolia.json");
(async () => {
  if (process.env.CONFIRM_WITHDRAW !== "yes") console.log("DRY RUN (set CONFIRM_WITHDRAW=yes to send)");
  const { ethers } = hre; const [me] = await ethers.getSigners();
  if (me.address.toLowerCase() !== dep.deployer.toLowerCase()) throw new Error("signer is not the deployer of this record");
  const ex = new ethers.Contract(dep.exchange, abi, me);
  const usdc = new ethers.Contract(dep.usdc, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  const key = await ex.acctKey(me.address, 0);
  const w = await ex.withdrawable(key), bal = await usdc.balanceOf(dep.exchange), amt = w < bal ? w : bal;
  console.log(`withdrawable ${Number(w) / 1e6}, exchange holds ${Number(bal) / 1e6}, withdrawing ${Number(amt) / 1e6}; left owed ${Number(w - amt) / 1e6} (unbacked by the unresolved bad debt)`);
  if (process.env.CONFIRM_WITHDRAW === "yes" && amt > 0n) { const tx = await ex.withdraw(0, amt); const rc = await tx.wait(1); console.log("tx", rc.hash); }
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
