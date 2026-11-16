// Re-stamp the DEMO-USD admin-set price so the demo market is not stale. DRY RUN unless CONFIRM_REFRESH_DEMO=yes.
// DEMO-USD IS AN ADMIN-SET PRICE, NOT A REAL FEED. Needs the deployer key (owner of the demo ManualOracle).
const { ethers, ctx, loadDeployment } = require("./common");
const L = require("./lib");
async function main() {
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  const d = loadDeployment(); const cfg = L.loadConfig();
  if (!d.demo) throw new Error("this deployment has no DEMO-USD market");
  const price = BigInt(process.env.DEMO_PRICE ?? cfg.demo.startPrice);
  const o = new ethers.Contract(d.demo.manualOracle, ["function owner() view returns (address)", "function set(bytes32,uint256)", "function latest(bytes32) view returns (uint256,uint256)"], ethers.provider);
  const [px, t] = await o.latest(d.demo.feed); const now = (await ethers.provider.getBlock("latest")).timestamp;
  console.log(`demo price now ${Number(px) / 1e6}, age ${now - Number(t)}s; would set ${Number(price) / 1e6}`);
  const gate = L.broadcastGate("CONFIRM_REFRESH_DEMO", chainId);
  if (!gate.ok) return console.log(`DRY RUN (${gate.reason})`);
  const k = L.requireSigner(signers, "refresh-demo-price");
  if ((await o.owner()).toLowerCase() !== k.address.toLowerCase()) throw new Error("REFUSING: the loaded key is not the demo oracle owner");
  const tx = await o.connect(k).set(d.demo.feed, price); await tx.wait(); console.log("set tx", tx.hash);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
