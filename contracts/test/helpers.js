const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => BigInt(Math.round(n * 1e6));
const btc = (x) => BigInt(Math.round(x * 1e8));
const TIF = { GTC: 0, IOC: 1, FOK: 2, PostOnly: 3 };
const FEED = ethers.id("BTC-USD");

function order(o) {
  return {
    market: o.market ?? 0,
    isBuy: o.isBuy,
    price: o.price,
    size: o.size,
    tif: o.tif ?? TIF.GTC,
    reduceOnly: o.reduceOnly ?? false,
    cloid: o.cloid ?? 0n,
    expiry: o.expiry ?? 0n,
  };
}

// Deploys the core + modules, registers module selectors, locks the table, returns a Contract with the merged ABI.
async function deployExchange(usdcAddr, oracleAddr, admin, { lock = true } = {}) {
  const core = await (await ethers.getContractFactory("PerpExchange")).deploy(usdcAddr, oracleAddr, admin.address);
  const coreIface = (await ethers.getContractFactory("PerpExchange")).interface;
  const OK = (f) => ["function", "event", "error"].includes(f.type);
  const seen = new Set(coreIface.fragments.filter(OK).map((f) => f.format()));
  const merged = coreIface.fragments.filter(OK);
  for (const name of ["PerpTrading", "PerpExtras", "PerpLiquidation", "PerpTwap", "PerpAdl"]) {
    const f = await ethers.getContractFactory(name);
    const mod = await f.deploy();
    const sels = [];
    for (const frag of f.interface.fragments.filter(OK)) {
      const key = frag.format();
      if (frag.type === "function" && !seen.has(key)) sels.push(f.interface.getFunction(frag.format()).selector);
      if (!seen.has(key)) { seen.add(key); merged.push(frag); }
    }
    await core.registerModule(await mod.getAddress(), sels);
  }
  if (lock) await core.lockModules();
  return new ethers.Contract(await core.getAddress(), merged, admin);
}

async function deploy() {
  const [admin, alice, bob, carol, keeper, guardian, relayer, agent] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const oracle = await (await ethers.getContractFactory("ManualOracle")).deploy();
  const ex = await deployExchange(await usdc.getAddress(), await oracle.getAddress(), admin);
  await ex.grantRole(await ex.GUARDIAN_ROLE(), guardian.address);
  await oracle.set(FEED, usd(50000));
  const cfg = {
    feed: FEED, tick: 100_000n, lot: 10_000n, minNotional: usd(10), maxOrderSize: btc(100), maxOI: btc(1000),
    maxAge: 60, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n,
  };
  const MAX = (1n << 128n) - 1n;
  await ex.createMarket(cfg, [
    { upToNotional: usd(100_000), imrBps: 1000, mmrBps: 500 },
    { upToNotional: usd(1_000_000), imrBps: 2000, mmrBps: 1000 },
    { upToNotional: MAX, imrBps: 5000, mmrBps: 2500 },
  ]);
  for (const s of [alice, bob, carol, keeper]) {
    await usdc.mint(s.address, usd(1_000_000));
    await usdc.connect(s).approve(await ex.getAddress(), ethers.MaxUint256);
  }
  const key = async (s) => ex.acctKey(s.address, 0);
  return { admin, alice, bob, carol, keeper, guardian, relayer, agent, usdc, oracle, ex, key };
}

// Refresh the oracle timestamp so the price stays fresh across time travel
async function setPx(oracle, px) { await oracle.set(FEED, px); }

async function ledger(ex, accts) {
  const [tracked, net] = await ex.ledgerTotals(accts);
  return { tracked, net, drift: tracked - net };
}

module.exports = { deployExchange, ethers, loadFixture, time, usd, btc, TIF, FEED, order, deploy, setPx, ledger };
