// Advance funding on the TESTNET exchange. `pokeFunding(m)` is permissionless: it takes a premium sample and, once an interval has passed, moves the funding index.
// Without it NO funding ever accrues (the keeper runs in dry-run mode, so nothing else sends it).
//   status + dry run:  npx hardhat --config hardhat.testnet.config.js run scripts/testnet/poke-funding.js --network arbitrumSepolia
//   send:              CONFIRM_POKE_FUNDING=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/poke-funding.js --network arbitrumSepolia
// Optional: MARKETS=0,1,2 (default all non-DEMO markets; DEMO has an admin-set price). Each poke costs a little gas from the deployer key; never prints a key.
// To see funding accrue: poke once (starts sampling), wait >= 1 interval (3600 s) while a position is open, poke again, then compare the index and the position's equity.
const hre = require("hardhat");
const dep = require("../../deployments/arbitrumSepolia.json");
const exchangeArt = require("../../artifacts/src/PerpExchange.sol/PerpExchange.json");
const extrasArt = require("../../artifacts/src/PerpExtras.sol/PerpExtras.json");

(async () => {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 421614) throw new Error(`REFUSING: chainId ${net.chainId}, this script only runs on Arbitrum Sepolia (421614)`);
  const [me] = await ethers.getSigners();
  const abi = [...exchangeArt.abi, ...extrasArt.abi.filter((x) => x.type === "function" && x.name === "getMarket")];
  const ex = new ethers.Contract(dep.exchange, abi, me);
  const names = Object.entries(dep.marketIds);
  const want = process.env.MARKETS ? process.env.MARKETS.split(",").map(Number) : names.filter(([n]) => !n.startsWith("DEMO")).map(([, id]) => id);
  const now = Number((await ethers.provider.getBlock("latest")).timestamp);
  console.log(`exchange ${dep.exchange}\nsender   ${me.address} (ETH ${ethers.formatEther(await ethers.provider.getBalance(me.address))})\n`);

  const show = async (label) => {
    console.log(label);
    for (const [name, id] of names) {
      const m = await ex.getMarket(id);
      const due = Number(m.lastFunding) + Number(m.fundingInterval);
      const est = await ex.estimatedFundingRate(id).catch(() => 0n);
      console.log(`  ${name.padEnd(8)} fundingIndex=${m.fundingIndex} sampledTime=${m.sampledTime}s lastPremiumValid=${m.lastPremiumValid} estRate(1e12)=${est} next interval ${due <= now ? "DUE (" + (now - due) + "s ago)" : "in " + (due - now) + "s"}`);
    }
  };
  await show("before:");
  console.log(`\nwill poke markets: ${want.join(", ")}`);
  if (process.env.CONFIRM_POKE_FUNDING !== "yes") return console.log("DRY RUN: set CONFIRM_POKE_FUNDING=yes to send (one transaction per market)");
  for (const id of want) {
    const tx = await ex.pokeFunding(id);
    const r = await tx.wait(1);
    console.log(`pokeFunding(${id}) ${r.hash} gas ${r.gasUsed}`);
  }
  await show("\nafter:");
})().catch((e) => { console.error(String(e.shortMessage || e.message).split("\n")[0]); process.exit(1); });
