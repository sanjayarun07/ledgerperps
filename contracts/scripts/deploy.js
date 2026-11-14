// Deploys USDC(mock) + ManualOracle + modular exchange + BTC/ETH/SOL markets. LOCAL DEMO substitutes. Writes deployments/<network>.json
const { ethers, network } = require("hardhat");
const fs = require("fs");
const { deployExchange } = require("../test/helpers");
async function main() {
  const [admin] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const oracle = await (await ethers.getContractFactory("ManualOracle")).deploy();
  const ex = await deployExchange(await usdc.getAddress(), await oracle.getAddress(), admin);
  const markets = [["BTC-USD", 50000e6, 100000, 10000], ["ETH-USD", 3000e6, 10000, 100000], ["SOL-USD", 150e6, 1000, 1000000]];
  const MAX = (1n << 128n) - 1n;
  for (const [name, p, tick, lot] of markets) {
    const feed = ethers.id(name);
    await oracle.set(feed, BigInt(p));
    await ex.createMarket({ feed, tick, lot, minNotional: 10_000_000n, maxOrderSize: 10n ** 12n, maxOI: 10n ** 13n, maxAge: 3600, bandBps: 500,
      maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n },
      [{ upToNotional: 100_000_000_000n, imrBps: 1000, mmrBps: 500 }, { upToNotional: 1_000_000_000_000n, imrBps: 2000, mmrBps: 1000 }, { upToNotional: MAX, imrBps: 5000, mmrBps: 2500 }]);
  }
  const out = { env: "LOCAL-DEMO (mock USDC, manual oracle)", chainId: Number((await ethers.provider.getNetwork()).chainId),
    usdc: await usdc.getAddress(), oracle: await oracle.getAddress(), exchange: await ex.getAddress(),
    feeds: Object.fromEntries(markets.map(([n]) => [n, ethers.id(n)])), marketIds: { "BTC-USD": 0, "ETH-USD": 1, "SOL-USD": 2 } };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/${network.name}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
