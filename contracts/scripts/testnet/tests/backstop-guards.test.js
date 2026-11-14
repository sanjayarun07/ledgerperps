// Guard tests for enable-backstop.js / demo-backstop.js / deploy-testnet.js. Run: node --test scripts/testnet/tests/backstop-guards.test.js
// Spawns hardhat on the default in-process network (chainId 31337) with a FAKE key in the environment: every script must refuse, say why, and never print the key.
const test = require("node:test"); const assert = require("node:assert");
const { spawnSync } = require("child_process"); const path = require("path");
const L = require("../lib");
const ROOT = path.join(__dirname, "..", "..", "..");
const FAKE_KEY = "0x" + "cd".repeat(32);

function runScript(script, env = {}) {
  const r = spawnSync("npx", ["hardhat", "--config", "hardhat.testnet.config.js", "run", `scripts/testnet/${script}`], { cwd: ROOT, encoding: "utf8", timeout: 240000,
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: FAKE_KEY, TRADER2_PRIVATE_KEY: FAKE_KEY, ...env } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

for (const [script, confirm] of [["enable-backstop.js", "CONFIRM_ENABLE_BACKSTOP"], ["demo-backstop.js", "CONFIRM_BACKSTOP_DEMO"]]) {
  test(`${script} refuses a wrong chain even with the confirm flag, and never prints a key`, () => {
    const r = runScript(script, { [confirm]: "yes" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /REFUSING|not in allowed set/);
    assert.ok(!r.out.includes(FAKE_KEY) && !r.out.includes(FAKE_KEY.slice(2)), "key leaked into output");
  });
}

test("the broadcast gates need the exact env flag AND chainId 421614 (pure)", () => {
  for (const name of ["CONFIRM_ENABLE_BACKSTOP", "CONFIRM_BACKSTOP_DEMO"]) {
    assert.equal(L.broadcastGate(name, 421614, {}).ok, false, "missing flag refuses");
    assert.equal(L.broadcastGate(name, 421614, { [name]: "1" }).ok, false);
    assert.equal(L.broadcastGate(name, 31337, { [name]: "yes" }).ok, false, "wrong chain refuses");
    assert.equal(L.broadcastGate(name, 421614, { [name]: "yes" }).ok, true);
  }
});

test("backstopCfgProblems mirrors the contract bounds", () => {
  const ok = { softNotional: "10000000", maxDiscBps: 150, dwell: 30, ramp: 120, maxAge: 600 };
  assert.deepEqual(L.backstopCfgProblems("X", ok, 500), []);
  assert.match(L.backstopCfgProblems("X", { ...ok, ramp: 59 }, 500).join(), /ramp must be >= 60/);
  assert.match(L.backstopCfgProblems("X", { ...ok, maxAge: 149 }, 500).join(), /maxAge must be >= dwell \+ ramp/);
  assert.match(L.backstopCfgProblems("X", { ...ok, maxDiscBps: 301 }, 500).join(), /maxDiscBps/);
  assert.match(L.backstopCfgProblems("X", { ...ok, maxDiscBps: 150 }, 100).join(), /maxDiscBps/, "bounded by bandBps");
  assert.match(L.backstopCfgProblems("X", { ...ok, softNotional: "0" }, 500).join(), /softNotional/);
  assert.deepEqual(L.validateConfig(L.loadConfig()), [], "the shipped config validates (incl. its backstop entries)");
});

test("oracle mode: ORACLE_MODE overrides, default is the config, junk is refused; chainlink mode does not require Pyth verification", () => {
  const cfg = L.loadConfig();
  assert.equal(L.resolveOracleMode(cfg, {}), "chainlink");
  assert.equal(L.resolveOracleMode(cfg, { ORACLE_MODE: "median" }), "median");
  assert.throws(() => L.resolveOracleMode(cfg, { ORACLE_MODE: "manual" }), /ORACLE_MODE must be/);
  const labels = (mode) => L.addressRefs(cfg, mode).map((r) => r.label);
  assert.ok(labels("median").includes("Pyth") && labels("median").some((l) => /Pyth feed/.test(l)));
  assert.ok(!labels("chainlink").some((l) => /Pyth/.test(l)) && labels("chainlink").some((l) => /Chainlink/.test(l)));
  assert.deepEqual(L.recommendOracleMode([100, 200], 600).mode, "median");
  assert.equal(L.recommendOracleMode([100, 586273], 600).mode, "chainlink");
  assert.equal(L.recommendOracleMode([100, NaN], 600).mode, "chainlink");
  assert.equal(L.recommendOracleMode([], 600).mode, "chainlink");
});

test("demo market flag: on by default, DEMO_MARKET=no removes it, it is always the last market id", () => {
  const cfg = L.loadConfig();
  assert.equal(L.demoEnabled(cfg, {}), true); assert.equal(L.demoEnabled(cfg, { DEMO_MARKET: "no" }), false);
  assert.deepEqual(L.marketsToCreate(cfg, { demo: true }).map((m) => m.name), ["BTC-USD", "ETH-USD", "SOL-USD", "DEMO-USD"]);
  assert.deepEqual(L.marketsToCreate(cfg, { demo: false }).map((m) => m.name), ["BTC-USD", "ETH-USD", "SOL-USD"]);
  const bad = JSON.parse(JSON.stringify(cfg)); bad.markets.reverse(); bad.markets.forEach((m, i) => (m.marketId = i));
  assert.match(L.validateConfig(bad).join(), /demo market must be the LAST/);
  const noLabel = JSON.parse(JSON.stringify(cfg)); noLabel.markets[3].label = "x";
  assert.match(L.validateConfig(noLabel).join(), /label containing "DEMO"/);
});
