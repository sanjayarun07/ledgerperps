// Gas per operation on the LIVE testnet exchange, measured on DEMO-USD (id 3) so it does not touch the bots' BTC book. DRY-RUN unless CONFIRM_MEASURE_GAS=yes.
// Uses the deployer with sub-accounts 3 (maker) and 2 (taker); cleans up (cancel all, withdraw) at the end. Writes infra/testnet/gas-report.json.
// gasUsed on Arbitrum includes the L1-data component converted to gas units, so these are the numbers that matter for cost.
const fs = require("fs"); const path = require("path");
const { ethers, ctx, mergedAbi, loadDeployment } = require("./common");
const L = require("./lib");
const OUT = path.join(__dirname, "..", "..", "..", "infra", "testnet", process.env.GAS_REPORT_FILE || "gas-report.json");
const MK = 3, MAKER = 3, TAKER = 2, P0 = 100_000_000n, SZ = 10_000_000n; // price 100.00 (1e6), size 0.1 (1e8)
const TIF = { GTC: 0, IOC: 1, PostOnly: 3 };

async function main() {
  const { chainId, signers } = await ctx({ chains: [L.ARB_SEPOLIA_CHAIN_ID] });
  const gate = L.broadcastGate("CONFIRM_MEASURE_GAS", chainId);
  if (!gate.ok) return console.log(`DRY RUN (${gate.reason}). Would measure ~20 operations on DEMO-USD with deployer sub ${MAKER}/${TAKER}.`);
  const d = loadDeployment(); const cfg = L.loadConfig(); const k = L.requireSigner(signers, "measure-gas"); L.assertDeployerMatch(k.address, L.expectedDeployer(cfg));
  const ex = new ethers.Contract(d.exchange, await mergedAbi(), ethers.provider).connect(k);
  const usdc = new ethers.Contract(d.usdc, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], k);
  const oracle = new ethers.Contract(d.demo.manualOracle, ["function set(bytes32,uint256)"], k);
  const me = k.address; const rows = [];
  const op = (isBuy, price, size, tif = TIF.GTC, ro = false) => ({ market: MK, isBuy, price, size, tif, reduceOnly: ro, cloid: 0n, expiry: 0 });
  const id = (rc) => { for (const l of rc.logs) { try { const e = ex.interface.parseLog(l); if (e && (e.name === "OrderRested" || e.name === "OrderAccepted")) return e.args.id; } catch { /* not ours */ } } return null; };
  const m = async (name, fn, note = "") => { const rc = await (await fn()).wait(1); rows.push({ op: name, gas: Number(rc.gasUsed), note }); console.log(`${String(rc.gasUsed).padStart(8)}  ${name}${note ? "  (" + note + ")" : ""}`); return rc; };

  await (await oracle.set(d.demo.feed, P0)).wait(1); // fresh DEMO price
  if ((await usdc.allowance(me, d.exchange)) < 10n ** 9n) await (await usdc.approve(d.exchange, ethers.MaxUint256)).wait(1);
  await m("deposit, first time on a sub-account (registers it)", () => ex.deposit(me, MAKER, 60_000_000n));
  await m("deposit, first time on a second sub-account", () => ex.deposit(me, TAKER, 60_000_000n));
  await m("deposit, repeat", () => ex.deposit(me, MAKER, 1_000_000n));
  const bid = (n) => P0 - 2_000_000n - BigInt(n) * 100_000n; // 98.00, 97.90, ...
  let rc = await m("place GTC, new price level, empty book side", () => ex.placeOrder(me, MAKER, op(true, bid(0), SZ))); const a1 = id(rc);
  rc = await m("place GTC, same price level (joins the queue)", () => ex.placeOrder(me, MAKER, op(true, bid(0), SZ))); const a2 = id(rc);
  rc = await m("place GTC, new price level next to an existing one", () => ex.placeOrder(me, MAKER, op(true, bid(1), SZ))); const a3 = id(rc);
  rc = await m("place post-only, new level", () => ex.placeOrder(me, MAKER, op(true, bid(2), SZ, TIF.PostOnly))); const a4 = id(rc);
  await m("cancel one order (only order at its level)", () => ex.cancelOrder(a4));
  await m("cancel one order (head of a queue of 2)", () => ex.cancelOrder(a1));
  rc = await m("replace order (cancel + place, new level)", () => ex.replaceOrder(a3, op(true, bid(5), SZ))); const a5 = id(rc);
  await m("cancelAll with 2 resting orders", () => ex.cancelAll(me, MAKER), `orders: ${[a2, a5].length}`);
  for (let i = 0; i < 8; i++) await (await ex.placeOrder(me, MAKER, op(true, bid(10 + i), SZ))).wait(1);
  await m("cancelAll with 8 resting orders on 8 levels", () => ex.cancelAll(me, MAKER), "8 orders");
  const ask = (n) => P0 + 1_000_000n + BigInt(n) * 100_000n; // 101.00, 101.10, 101.20
  await (await ex.placeOrder(me, MAKER, op(false, ask(0), SZ))).wait(1);
  await m("taker IOC buy fills 1 resting order fully (taker side)", () => ex.placeOrder(me, TAKER, op(true, ask(0), SZ, TIF.IOC)));
  for (let i = 0; i < 3; i++) await (await ex.placeOrder(me, MAKER, op(false, ask(i), SZ))).wait(1);
  await m("taker IOC buy sweeps 3 resting orders on 3 levels", () => ex.placeOrder(me, TAKER, op(true, ask(2), 3n * SZ, TIF.IOC)));
  await (await ex.placeOrder(me, MAKER, op(true, ask(0) - 1_000_000n, 4n * SZ))).wait(1);
  await m("taker IOC sell closes the position against 1 resting bid", () => ex.placeOrder(me, TAKER, op(false, ask(0) - 1_000_000n, 4n * SZ, TIF.IOC, true)));
  await m("pokeFunding (DEMO-USD)", () => ex.pokeFunding(MK));
  // cleanup
  await (await ex.cancelAll(me, MAKER)).wait(1); await (await ex.cancelAll(me, TAKER)).wait(1);
  for (const s of [MAKER, TAKER]) { try { const w = await ex.withdrawable(await ex.acctKey(me, s)); if (w > 0n) await (await ex.withdraw(s, w)).wait(1); } catch (e) { console.log("withdraw skipped:", String(e.shortMessage || e.message).slice(0, 80)); } }
  await (await oracle.set(d.demo.feed, P0)).wait(1);
  const fee = await ethers.provider.getFeeData(); const gp = fee.gasPrice ?? 0n;
  const eth = Number(await ex.markPrice(1)) / 1e6; // ETH-USD mark
  const report = { when: new Date().toISOString(), chainId, exchange: d.exchange, gasPriceWei: gp.toString(), ethUsd: eth, rows: rows.map((r) => ({ ...r, usdCost: (r.gas * Number(gp)) / 1e18 * eth })) };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  console.log(`\ngas price ${Number(gp) / 1e9} gwei, ETH ${eth} USD (testnet feed). Wrote ${OUT}`);
  for (const r of report.rows) console.log(`${String(r.gas).padStart(8)}  $${r.usdCost.toFixed(4)}  ${r.op}`);
}
main().catch((e) => { console.error(L.redact(String(e.shortMessage || e.message), [process.env.DEPLOYER_PRIVATE_KEY])); process.exit(1); });
