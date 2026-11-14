// Run: node --test scripts/testnet/tests/lib.test.js   (pure; no network, no hardhat)
const test = require("node:test"); const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path"); const { execFileSync } = require("child_process");
const L = require("../lib");
const FAKE_KEY = "0x" + "ab".repeat(32);

test("normalizeKey accepts 64 hex with/without 0x, rejects others without echoing the value", () => {
  assert.equal(L.normalizeKey("ab".repeat(32)).key, FAKE_KEY);
  assert.equal(L.normalizeKey(FAKE_KEY).ok, true);
  for (const bad of ["", undefined, "0x123", "zz".repeat(32), FAKE_KEY + "00"]) {
    const r = L.normalizeKey(bad); assert.equal(r.ok, false); assert.ok(!String(r.reason).includes("ab".repeat(8)));
  }
});
test("redact removes key with and without 0x", () => {
  const out = L.redact(`boom ${FAKE_KEY} and ${FAKE_KEY.slice(2)}`, [FAKE_KEY]);
  assert.ok(!out.includes("abab")); assert.match(out, /\[REDACTED\]/);
});
test("assertChainId refuses wrong chain", () => {
  assert.throws(() => L.assertChainId(1), /REFUSING/); assert.throws(() => L.assertChainId(31337n), /REFUSING/);
  assert.doesNotThrow(() => L.assertChainId(421614n));
});
test("broadcastGate needs BOTH the env flag and chainId 421614", () => {
  assert.equal(L.broadcastGate("X", 421614, {}).ok, false);
  assert.equal(L.broadcastGate("X", 421614, { X: "true" }).ok, false);
  assert.equal(L.broadcastGate("X", 1, { X: "yes" }).ok, false);
  assert.equal(L.broadcastGate("X", 31337, { X: "yes" }).ok, false);
  assert.equal(L.broadcastGate("X", 421614, { X: "yes" }).ok, true);
});
test("requireSigner fails clearly and never mentions a value", () => {
  assert.throws(() => L.requireSigner([], "deploy"), /DEPLOYER_PRIVATE_KEY is missing/);
  assert.equal(L.requireSigner([{ address: "0x1" }]).address, "0x1");
});
test("assertDeployerMatch is case-insensitive and refuses mismatch / unset", () => {
  const a = "0x50C05D162dF2EFc2f2b9a24708bE0BcDAf8d6B29";
  assert.doesNotThrow(() => L.assertDeployerMatch(a.toLowerCase(), a));
  assert.throws(() => L.assertDeployerMatch("0x" + "1".repeat(40), a), /REFUSING/);
  assert.throws(() => L.assertDeployerMatch(a, null), /not set/);
});
test("shipped config validates; every address has https source and verifiedOnChain key", () => {
  const cfg = L.loadConfig(); assert.deepEqual(L.validateConfig(cfg), []);
  assert.equal(cfg.expectedDeployer, "0x50C05D162dF2EFc2f2b9a24708bE0BcDAf8d6B29");
});
test("validateConfig catches missing source, bad address, missing verifiedOnChain, wrong chain", () => {
  const c = JSON.parse(JSON.stringify(L.loadConfig()));
  c.usdc.source = "ftp://x"; c.pyth.address = "0x12"; delete c.markets[0].chainlink.verifiedOnChain; c.network.chainId = 1;
  const e = L.validateConfig(c).join("|");
  for (const m of [/USDC: 'source'/, /Pyth: address/, /BTC-USD Chainlink: 'verifiedOnChain'/, /network.chainId/]) assert.match(e, m);
});
test("configHash ignores verifiedOnChain but changes with params", () => {
  const c = JSON.parse(JSON.stringify(L.loadConfig())); const h = L.configHash(c);
  c.usdc.verifiedOnChain = { ok: true, checkedAt: "x" }; assert.equal(L.configHash(c), h);
  c.markets[0].params.maxOI = "1"; assert.notEqual(L.configHash(c), h);
});
test("verificationProblems: unverified or old verification blocks broadcast", () => {
  const c = JSON.parse(JSON.stringify(L.loadConfig()));
  for (const r of L.addressRefs(c)) r.node.verifiedOnChain = null;
  assert.ok(L.verificationProblems(c).length > 0);
  const now = Date.now();
  for (const r of L.addressRefs(c)) r.node.verifiedOnChain = { ok: true, checkedAt: new Date(now).toISOString() };
  assert.deepEqual(L.verificationProblems(c, 24, now), []);
  assert.ok(L.verificationProblems(c, 24, now + 48 * 3600e3).length > 0);
});
test("marketCreateArgs yields bigint config and ordered tiers", () => {
  const [mc, tiers] = L.marketCreateArgs(L.loadConfig().markets[0]);
  assert.equal(typeof mc.maxOI, "bigint"); assert.equal(tiers.at(-1).upToNotional, (1n << 128n) - 1n);
});
test("hygiene: world-readable .env and key-in-example are flagged (temp tree)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyg-")); fs.mkdirSync(path.join(root, "contracts"));
  fs.writeFileSync(path.join(root, "contracts", ".env"), "X=1\n", { mode: 0o644 }); fs.chmodSync(path.join(root, "contracts", ".env"), 0o644);
  fs.writeFileSync(path.join(root, "contracts", ".env.example"), `DEPLOYER_PRIVATE_KEY=${FAKE_KEY}\n`);
  const p = L.hygieneProblems(root).join("|");
  assert.match(p, /chmod 600/); assert.match(p, /private-key-looking/); assert.ok(!p.includes("abab"));
  fs.chmodSync(path.join(root, "contracts", ".env"), 0o600); fs.writeFileSync(path.join(root, "contracts", ".env.example"), "DEPLOYER_PRIVATE_KEY=\n");
  assert.deepEqual(L.hygieneProblems(root), []);
});
test("no script prints or interpolates the key: static scan", () => {
  const dir = path.join(__dirname, "..");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/console\.\w+\([^)]*(?<!redact\(.{0,40})process\.env\.(DEPLOYER|TRADER2)_PRIVATE_KEY/.test(src.replace(/L\.redact\([^)]*\)/g, "")), f + " may log the key");
    assert.ok(!/console\.\w+\([^)]*\bk\.key\b/.test(src), f + " logs k.key");
  }
});
test("hardhat.testnet.config.js: no key hardcoded; compiler settings inherited from base", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "hardhat.testnet.config.js"), "utf8");
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(src));
  const env = { ...process.env, DEPLOYER_PRIVATE_KEY: "", TRADER2_PRIVATE_KEY: "" };
  const root = path.join(__dirname, "..", "..", "..");
  const out = execFileSync("npx", ["hardhat", "--config", "hardhat.testnet.config.js", "run", "scripts/testnet/tests/config-check.js", "--no-compile"], { cwd: root, env }).toString().split("\n").filter((l) => l.startsWith("CFG:"))[0].slice(4);
  const [s1, s2, cid, acc] = JSON.parse(out);
  const pick = (x) => [x.version, x.settings.viaIR, x.settings.optimizer.enabled, x.settings.optimizer.runs, x.settings.evmVersion];
  assert.deepEqual(pick(s1), pick(s2)); assert.equal(s1.version, "0.8.24"); assert.equal(s1.settings.viaIR, true); assert.equal(s1.settings.optimizer.runs, 200); assert.equal(s1.settings.evmVersion, "cancun");
  assert.equal(cid, 421614); assert.deepEqual(acc, []);
});
