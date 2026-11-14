// Verifies deployed code sizes of the 6 exchange contracts on the live chain and probes the chain's real max code size.
// Run: cd contracts && npx hardhat --config hardhat.nitro.config.js run ../infra/nitro-local/code-size.js --network nitroLocal
const { ethers, artifacts } = require("hardhat");
async function main() {
  const [s] = await ethers.getSigners(); const p = ethers.provider;
  const d = require("../../contracts/deployments/nitroLocal.json");
  // deploy order in deployExchange: core, then (module deploy, registerModule) pairs => +1,+3,+5,+7,+9
  // the dev key is shared with testnode init so the starting nonce is not 0: locate the core's nonce from its address
  let n0 = -1; for (let i = 0; i < 2000; i++) if (ethers.getCreateAddress({ from: s.address, nonce: i }) === d.exchange) { n0 = i; break; }
  console.log("core deploy nonce", n0);
  const names = [["PerpExchange", n0], ["PerpTrading", n0 + 1], ["PerpExtras", n0 + 3], ["PerpLiquidation", n0 + 5], ["PerpTwap", n0 + 7], ["PerpAdl", n0 + 9]];
  for (const [n, nonce] of names) {
    const addr = ethers.getCreateAddress({ from: s.address, nonce });
    const onchain = (await p.getCode(addr)).length / 2 - 1;
    const art = (await artifacts.readArtifact(n)).deployedBytecode.length / 2 - 1;
    console.log(n.padEnd(16), addr, "onchain bytes", onchain, "artifact bytes", art, onchain === art ? "(match)" : "(DIFFER: immutables?)");
  }
  console.log("exchange (from json) code bytes", (await p.getCode(d.exchange)).length / 2 - 1);
  for (const N of [24576, 24577, 32768, 49152, 65536, 98304]) {
    const init = "0x62" + N.toString(16).padStart(6, "0") + "6000f3"; // PUSH3 N PUSH1 0 RETURN -> N zero bytes
    try {
      const tx = await s.sendTransaction({ data: init, gasLimit: 30_000_000 }); const r = await tx.wait();
      console.log(N, "probe: deployed, code len", (await p.getCode(r.contractAddress)).length / 2 - 1, "status", r.status, "gasUsed", r.gasUsed.toString());
    } catch (e) { console.log(N, "probe: FAILED", (e.shortMessage || e.message).slice(0, 140)); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
