// Reads ArbOS pricing + chain facts from the live L2 via precompiles (ArbGasInfo 0x6c, ArbSys 0x64) and samples block timestamps vs wall clock.
// Run: cd contracts && npx hardhat --config hardhat.nitro.config.js run ../infra/nitro-local/chain-info.js --network nitroLocal
const { ethers } = require("hardhat");
const p = ethers.provider;
async function main() {
  const [s] = await ethers.getSigners();
  const gi = new ethers.Contract("0x000000000000000000000000000000000000006C", [
    "function getPricesInWei() view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
    "function getL1BaseFeeEstimate() view returns (uint256)", "function getMinimumGasPrice() view returns (uint256)",
    "function getL1PricingUnitsSinceUpdate() view returns (uint64)", "function getGasBacklog() view returns (uint64)",
    "function getPricingInertia() view returns (uint64)", "function getGasAccountingParams() view returns (uint256,uint256,uint256)",
    "function getL1PricingSurplus() view returns (int256)", "function getPerBatchGasCharge() view returns (int64)",
    "function getAmortizedCostCapBips() view returns (uint64)", "function getL1RewardRate() view returns (uint64)"], p);
  const sys = new ethers.Contract("0x0000000000000000000000000000000000000064", ["function arbOSVersion() view returns (uint256)", "function arbChainID() view returns (uint256)"], p);
  const out = {};
  for (const [n, f] of [["arbOSVersion(raw, minus 55)", () => sys.arbOSVersion()], ["arbChainID", () => sys.arbChainID()], ["getPricesInWei", () => gi.getPricesInWei()],
    ["getL1BaseFeeEstimate", () => gi.getL1BaseFeeEstimate()], ["getMinimumGasPrice", () => gi.getMinimumGasPrice()], ["getGasAccountingParams(speedLimit,poolMax,txMax)", () => gi.getGasAccountingParams()],
    ["getGasBacklog", () => gi.getGasBacklog()], ["getPricingInertia", () => gi.getPricingInertia()], ["getL1PricingSurplus", () => gi.getL1PricingSurplus()],
    ["getPerBatchGasCharge", () => gi.getPerBatchGasCharge()], ["getAmortizedCostCapBips", () => gi.getAmortizedCostCapBips()]]) {
    try { const v = await f(); out[n] = Array.isArray(v) || (v && v.toArray) ? v.toArray().map(String) : String(v); } catch (e) { out[n] = "ERR " + (e.shortMessage || e.message).slice(0, 80); }
  }
  console.log(JSON.stringify(out, null, 1));
  console.log("L1 (geth) gasPrice via parent RPC not queried here; eth_gasPrice L2 =", (await p.send("eth_gasPrice", [])));
  // timestamp sampling: 20 self-sends, record wall clock vs block timestamp
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const w0 = Date.now(); const tx = await s.sendTransaction({ to: s.address, value: 0 }); const r = await tx.wait(); const w1 = Date.now();
    const b = await p.getBlock(r.blockNumber);
    rows.push({ block: r.blockNumber, ts: b.timestamp, wallSecAtReceipt: w1 / 1000, ahead: b.timestamp - w1 / 1000, ms: w1 - w0 });
    if (i % 5 === 4) await new Promise((r2) => setTimeout(r2, 7000));
  }
  let mono = true; for (let i = 1; i < rows.length; i++) if (rows[i].ts < rows[i - 1].ts) mono = false;
  console.log("block ts - wall(sec) at receipt: min", Math.min(...rows.map((r) => r.ahead)).toFixed(2), "max", Math.max(...rows.map((r) => r.ahead)).toFixed(2), "| non-decreasing:", mono,
    "| receipt latency ms min/max", Math.min(...rows.map((r) => r.ms)), Math.max(...rows.map((r) => r.ms)));
  console.log("consecutive block numbers/ts:", rows.map((r) => `${r.block}:${r.ts}`).join(" "));
  const l = await p.getBlock("latest");
  const l1 = await new ethers.JsonRpcProvider("http://127.0.0.1:8545").getBlock("latest");
  console.log("latest L2 ts", l.timestamp, "L1 ts", l1.timestamp, "wall", Math.floor(Date.now() / 1000));
}
main().catch((e) => { console.error(e); process.exit(1); });
