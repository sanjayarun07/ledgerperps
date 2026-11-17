// Open a tiny, near-maximum-leverage BTC-USD long from a dedicated throwaway testnet account so a REAL Chainlink move can liquidate it.
// The key is read from contracts/.env.liqtest (git-ignored, LIQTEST_PRIVATE_KEY). Never prints it. Dry run unless CONFIRM_LIQ_POSITION=yes.
//   CONFIRM_LIQ_POSITION=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/open-liq-position.js --network arbitrumSepolia
// Env: SIZE_BTC (default 0.001), DEPOSIT_USDC (default 7.5), SIDE=long|short (default long)
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const dep = require("../../deployments/arbitrumSepolia.json");
const merged = require("../../../frontend/src/generated/PerpExchange.merged.json");

(async () => {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 421614) throw new Error(`REFUSING: chainId ${net.chainId}`);
  const envFile = path.join(__dirname, "../../.env.liqtest");
  const m = /LIQTEST_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/.exec(fs.readFileSync(envFile, "utf8"));
  if (!m) throw new Error("no LIQTEST_PRIVATE_KEY in contracts/.env.liqtest");
  const w = new ethers.Wallet(m[1], ethers.provider);
  const [deployer] = await ethers.getSigners();
  if (w.address.toLowerCase() === deployer.address.toLowerCase()) throw new Error("REFUSING: liqtest key equals the deployer key");

  const abi = merged.abi || merged;
  const ex = new ethers.Contract(dep.exchange, abi, w);
  const usdc = new ethers.Contract(dep.usdc, ["function approve(address,uint256)", "function balanceOf(address) view returns (uint256)"], w);
  const long = (process.env.SIDE || "long") !== "short";
  const size = BigInt(Math.round(Number(process.env.SIZE_BTC || "0.001") * 1e8));
  const deposit = BigInt(Math.round(Number(process.env.DEPOSIT_USDC || "7.5") * 1e6));

  const book = await (await fetch("http://localhost:18700/v1/markets/0/book?depth=3")).json();
  const lv = (book.data || book);
  const asks = lv.asks || [], bids = lv.bids || [];
  if (!asks.length || !bids.length) throw new Error("book empty: " + JSON.stringify(lv).slice(0, 200));
  const px = (x) => BigInt(Array.isArray(x) ? x[0] : x.price);
  const bestAsk = px(asks[0]), bestBid = px(bids[0]);
  // IOC priced 0.3% through the touch, rounded to the 0.1 USDC tick
  const tick = 100000n;
  const limit = long ? ((bestAsk * 1003n / 1000n) / tick) * tick : ((bestBid * 997n / 1000n + tick - 1n) / tick) * tick;
  const notional = size * bestAsk / 100000000n;
  console.log(`account ${w.address}  ETH ${ethers.formatEther(await ethers.provider.getBalance(w.address))}  tUSDC ${Number(await usdc.balanceOf(w.address)) / 1e6}`);
  console.log(`plan: ${long ? "BUY" : "SELL"} ${Number(size) / 1e8} BTC IOC limit ${Number(limit) / 1e6} (touch ask ${Number(bestAsk) / 1e6} bid ${Number(bestBid) / 1e6}), notional ~${Number(notional) / 1e6} USDC, deposit ${Number(deposit) / 1e6} tUSDC to sub 0`);
  if (process.env.CONFIRM_LIQ_POSITION !== "yes") return console.log("DRY RUN: set CONFIRM_LIQ_POSITION=yes to send");

  const wait = async (p) => (await (await p).wait(1)).hash;
  if (process.env.SKIP_DEPOSIT !== "yes") {
    console.log("approve", await wait(usdc.approve(dep.exchange, deposit)));
    console.log("deposit", await wait(ex.deposit(w.address, 0, deposit)));
  }
  const params = { market: 0, isBuy: long, price: limit, size, tif: 1, reduceOnly: false, cloid: 0n, expiry: 0n };
  console.log("order  ", await wait(ex.placeOrder(w.address, 0, params)));
  const a = await ex.acctKey(w.address, 0);
  const pos = await ex.positions(a, 0);
  const st = await ex.accountState(a);
  console.log(`position size ${pos.size} entry ${pos.entryPrice ?? "?"}  equity ${st.equity} im ${st.im} mm ${st.mm} avail ${st.avail}`);
})().catch((e) => { console.error(String(e.shortMessage || e.message).split("\n")[0]); process.exit(1); });
