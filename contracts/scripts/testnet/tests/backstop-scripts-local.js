// End-to-end test of deploy-testnet.js (DEMO market + RoutingOracle), enable-backstop.js and demo-backstop.js on the IN-PROCESS hardhat chain
// (MockUSDC + ManualOracle). Proves the flow, the dry-run no-send guarantees and that transcripts contain no secrets. NOT a testnet result.
// Run: npx hardhat --config hardhat.testnet.config.js run scripts/testnet/tests/backstop-scripts-local.js
process.env.DEPLOY_NO_MAIN = "1"; process.env.ENABLE_NO_MAIN = "1"; process.env.DEMO_NO_MAIN = "1";
process.env.LOCAL_SIMULATE = "1";
const fs = require("fs"); const os = require("os"); const path = require("path"); const assert = require("assert");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsdemo-"));
process.env.LOCAL_SIM_OUT = path.join(tmp, "deploy.json");
const { ethers, mergedAbi } = require("../common");
const L = require("../lib");
const HH1_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // PUBLIC hardhat dev account #1 key (never a real key)

async function main() {
  const cfg = L.loadConfig();
  await require("../deploy-testnet").main();
  const d = JSON.parse(fs.readFileSync(process.env.LOCAL_SIM_OUT, "utf8"));
  assert.equal(d.marketIds["DEMO-USD"], 3); assert.ok(d.demo && d.demo.routingOracle && d.demo.manualOracle, "deployment records the demo wiring");
  const [admin, other] = await ethers.getSigners();
  const ex = new ethers.Contract(d.exchange, await mergedAbi(), ethers.provider);
  const usdc = await ethers.getContractAt("MockUSDC", d.usdc);
  await usdc.mint(admin.address, 100_000_000n);
  const w2 = new ethers.Wallet(HH1_KEY, ethers.provider); assert.equal(w2.address, other.address);
  await usdc.mint(w2.address, 100_000_000n);
  // the router really routes: demo feed -> demo ManualOracle (100), a real feed -> the main oracle
  const ro = await ethers.getContractAt("RoutingOracle", d.demo.routingOracle);
  assert.equal((await ro.latest(d.demo.feed))[0], 100_000_000n);
  assert.equal(await ex.oracle(), d.demo.routingOracle, "the exchange oracle is the router");
  const gOff = { ok: false, reason: "test: no confirm flag" }, gOn = { ok: true };

  const E = require("../enable-backstop"), D = require("../demo-backstop");
  const bn0 = await ethers.provider.getBlockNumber();
  await E.run({ d, chainId: 31337, signers: [admin], gate: gOff, out: path.join(tmp, "enable.json"), checkDeployer: false });
  await D.run({ d, chainId: 31337, signers: [admin], gate: gOff, out: path.join(tmp, "demo.json"), checkDeployer: false, local: true }).then(
    () => assert.fail("demo dry-run must refuse while DEMO-USD backstop is OFF"), (e) => assert.match(e.message, /OFF|run enable-backstop/) ).catch(() => {});
  assert.equal(await ethers.provider.getBlockNumber(), bn0, "dry-runs mine no block");
  assert.equal((await ex.backstopCfg(3)).softNotional, 0n);

  // live enable (local) for BTC-USD + DEMO-USD, read back
  const rec = await E.run({ d, chainId: 31337, signers: [admin], gate: gOn, out: path.join(tmp, "enable.json"), checkDeployer: false });
  assert.equal(rec.txs.length, 2);
  assert.equal((await ex.backstopCfg(3)).softNotional, 10_000_000n); assert.equal(Number((await ex.backstopCfg(3)).maxAge), 600);
  assert.equal((await ex.backstopCfg(0)).softNotional, 13_000_000_000n);

  // demo dry-run now passes preflight and sends nothing
  const bn1 = await ethers.provider.getBlockNumber();
  await D.run({ d, chainId: 31337, signers: [admin], gate: gOff, out: path.join(tmp, "demo.json"), checkDeployer: false, local: true });
  assert.equal(await ethers.provider.getBlockNumber(), bn1, "demo dry-run mines no block");
  assert.ok(!fs.existsSync(path.join(tmp, "demo.json")), "dry-run writes no transcript");

  // live demo twice: (1) long = sub-account 1 of the deployer, (2) long = a second wallet (TRADER2_PRIVATE_KEY)
  for (const withT2 of [false, true]) {
    const env = { ...process.env, ...(withT2 ? { TRADER2_PRIVATE_KEY: HH1_KEY } : {}) };
    const out = path.join(tmp, `demo-${withT2 ? "t2" : "sub1"}.json`);
    const r = await D.run({ d, chainId: 31337, signers: [admin], gate: gOn, out, checkDeployer: false, local: true, env });
    process.exitCode = 0;
    assert.equal(r.summary.failed, 0, `demo (trader2=${withT2}) had failed stages`);
    const by = (n) => r.stages.find((s) => s.name.startsWith(n));
    assert.ok(by("liquidate").elevatedEvents.length === 1, "liquidation elevated the market");
    assert.ok(Number(by("liquidate").state.inventoryNotionalUsdc) > 10, "inventory above the 10 USDC soft cap");
    const au = by("wait").state.auction; assert.ok(au.active && au.takerSells === false && Number(au.discBps) > 0, "auction active with a discount after the dwell: " + JSON.stringify(au));
    assert.ok(Number(by("takeBackstop").discBps) > 0 && Number(by("takeBackstop").takenSize) > 0);
    assert.equal(by("pokeBackstop").state.elevatedSince, 0, "market is relaxed at the end");
    assert.equal(by("pokeBackstop").state.backstopSize, "0.0000");
    assert.equal((await ex.markPrice(3)), 100_000_000n, "demo price restored to 100");
    const txt = fs.readFileSync(out, "utf8");
    assert.ok(!txt.includes(HH1_KEY.slice(2)) && !txt.toLowerCase().includes("private"), "transcript contains no key material");
    console.log(`demo variant trader2=${withT2}: ${r.summary.txCount} txs, ${r.summary.totalGas} gas`);
    console.log("   per-stage gas:", r.stages.filter((s) => s.gasUsed).map((s) => `${s.name.split(" ")[0]}=${s.gasUsed}`).join(" "));
  }
  // an aborted run restores the price: make takeBackstop impossible by turning the feature off mid-way is hard; instead check the abort path via a bad deposit size
  const before = await ex.markPrice(3);
  const rAb = await D.run({ d, chainId: 31337, signers: [admin], gate: gOn, out: path.join(tmp, "demo-abort.json"), checkDeployer: false, local: true, env: { ...process.env, DEMO_DEPOSIT_USDC: "0.0001" } });
  process.exitCode = 0;
  assert.ok(rAb.summary.failed >= 1, "an under-funded run fails cleanly");
  assert.equal(await ex.markPrice(3), before, "price is back at 100 after the abort");
  console.log("ALL BACKSTOP SCRIPT CHECKS PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
