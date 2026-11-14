// Pure helpers (no hardhat/ethers import) so guards can be unit-tested with `node --test`.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ARB_SEPOLIA_CHAIN_ID = 421614;
const HARDHAT_CHAIN_ID = 31337;
const DEFAULT_PUBLIC_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const EIP170 = 24576;
const CONFIG_PATH = path.join(__dirname, "..", "..", "..", "infra", "testnet", "testnet.config.json");
const DEPLOYMENT_PATH = path.join(__dirname, "..", "..", "deployments", "arbitrumSepolia.json");
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const B32_RE = /^0x[0-9a-fA-F]{64}$/;

/** Validate and normalise a private key string. Never returns the key in `reason`. */
function normalizeKey(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { ok: false, key: null, reason: "not set" };
  let s = String(raw).trim();
  if (!s.startsWith("0x")) s = "0x" + s;
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) return { ok: false, key: null, reason: "not a 32-byte hex string (expected 64 hex chars, optional 0x prefix)" };
  return { ok: true, key: s, reason: null };
}

/** Replace every occurrence of any secret (with and without 0x) by [REDACTED]. */
function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets || []) {
    if (!s) continue;
    const bare = String(s).replace(/^0x/, "");
    out = out.split(String(s)).join("[REDACTED]").split(bare).join("[REDACTED]");
  }
  return out;
}

function assertChainId(actual, expected = ARB_SEPOLIA_CHAIN_ID) {
  if (Number(actual) !== Number(expected)) {
    throw new Error(`REFUSING: RPC reports chainId ${actual}, expected ${expected} (Arbitrum Sepolia). Check ARB_SEPOLIA_RPC_URL.`);
  }
}

/** Broadcast gate: explicit env var == "yes" AND chainId == 421614. Returns {ok, reason}. */
function broadcastGate(envName, chainId, env = process.env) {
  if (Number(chainId) !== ARB_SEPOLIA_CHAIN_ID) return { ok: false, reason: `chainId ${chainId} != ${ARB_SEPOLIA_CHAIN_ID}` };
  if (env[envName] !== "yes") return { ok: false, reason: `${envName} is not "yes"` };
  return { ok: true, reason: null };
}

function requireSigner(signers, what = "this step") {
  if (!signers || signers.length === 0) {
    throw new Error(`DEPLOYER_PRIVATE_KEY is missing or invalid, but ${what} needs a signer. Put a TESTNET-ONLY key in contracts/.env (see .env.example). The key is never printed.`);
  }
  return signers[0];
}

/** Refuse to sign with a key whose address differs from the expected (public) deployer address. Case-insensitive. */
function assertDeployerMatch(derivedAddress, expected) {
  if (!expected) throw new Error("REFUSING: expectedDeployer is not set in infra/testnet/testnet.config.json (or EXPECTED_DEPLOYER_ADDRESS env).");
  if (!ADDR_RE.test(expected)) throw new Error("REFUSING: expected deployer address is malformed.");
  if (String(derivedAddress).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`REFUSING: the address derived from DEPLOYER_PRIVATE_KEY (${derivedAddress}) != expected deployer ${expected}. Wrong key loaded?`);
  }
}
function expectedDeployer(cfg, env = process.env) { return env.EXPECTED_DEPLOYER_ADDRESS || cfg.expectedDeployer || null; }

/**
 * Secret hygiene. Returns a list of problems (strings never contain secret values).
 *  - contracts/.env must not be readable by group/other (chmod 600) when it exists (POSIX only)
 *  - no *PRIVATE_KEY=<64 hex> assignment in files that look committable (.env.example, infra/testnet/**, docs/TESTNET_*.md)
 */
function hygieneProblems(root = path.join(__dirname, "..", "..", "..")) {
  const probs = [];
  const envFile = path.join(root, "contracts", ".env");
  try {
    if (fs.existsSync(envFile) && process.platform !== "win32") {
      const mode = fs.statSync(envFile).mode & 0o777;
      if (mode & 0o077) probs.push(`contracts/.env permissions are ${mode.toString(8)} (readable by others); run: chmod 600 contracts/.env`);
    }
  } catch (e) { probs.push("cannot stat contracts/.env: " + e.code); }
  const re = /PRIVATE_KEY\s*[=:]\s*["']?(0x)?[0-9a-fA-F]{64}\b/;
  const files = [path.join(root, "contracts", ".env.example"), path.join(root, "docs", "TESTNET_RUNBOOK.md"), path.join(root, "docs", "LAUNCH_CHECKLIST.md")];
  const walk = (dir) => { try { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else files.push(p); } } catch {} };
  walk(path.join(root, "infra", "testnet"));
  for (const f of files) { try { if (fs.existsSync(f) && re.test(fs.readFileSync(f, "utf8"))) probs.push(`private-key-looking assignment found in ${path.relative(root, f)} (value not shown)`); } catch {} }
  return probs;
}

function loadConfig(file = CONFIG_PATH) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function saveConfig(cfg, file = CONFIG_PATH) { fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n"); }

/** Every on-chain reference in the config. Used by validation, verify-addresses and verify-gate. */
function addressRefs(cfg) {
  const refs = [];
  refs.push({ label: "USDC", node: cfg.usdc });
  refs.push({ label: "Pyth", node: cfg.pyth });
  for (const m of cfg.markets) {
    if (m.chainlink) refs.push({ label: `${m.name} Chainlink`, node: m.chainlink });
    if (m.pyth) refs.push({ label: `${m.name} Pyth feed`, node: m.pyth, isFeedId: true });
  }
  return refs;
}

function validateConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== "object") return ["config is not an object"];
  if (cfg.network?.chainId !== ARB_SEPOLIA_CHAIN_ID) errs.push(`network.chainId must be ${ARB_SEPOLIA_CHAIN_ID}`);
  if (!Array.isArray(cfg.markets) || cfg.markets.length === 0) errs.push("markets must be a non-empty array");
  for (const r of cfg.markets ? addressRefs(cfg) : []) {
    const n = r.node || {};
    const v = r.isFeedId ? n.feedId : n.address;
    if (!(r.isFeedId ? B32_RE : ADDR_RE).test(v || "")) errs.push(`${r.label}: ${r.isFeedId ? "feedId" : "address"} missing or malformed`);
    if (!/^https:\/\//.test(n.source || "")) errs.push(`${r.label}: 'source' must be an https URL`);
    if (!("verifiedOnChain" in n)) errs.push(`${r.label}: 'verifiedOnChain' field missing (must exist; only verify-addresses.js sets it)`);
  }
  const seen = new Set();
  (cfg.markets || []).forEach((m, i) => {
    if (m.marketId !== i) errs.push(`${m.name}: marketId must equal its index (${i})`);
    if (seen.has(m.name)) errs.push(`duplicate market ${m.name}`); seen.add(m.name);
    if (!B32_RE.test(m.feedId || "")) errs.push(`${m.name}: feedId malformed`);
    if (!["median", "manual"].includes(m.oracleMode)) errs.push(`${m.name}: oracleMode must be median|manual`);
    if (m.oracleMode === "median" && !(m.chainlink && m.pyth)) errs.push(`${m.name}: median mode needs both chainlink and pyth`);
    for (const f of ["tick", "lot", "minNotional", "maxOrderSize", "maxOI", "maxAge", "bandBps", "maxSpreadBps", "fundingInterval", "premiumDivisor", "fundingCap"])
      if (m.params?.[f] === undefined) errs.push(`${m.name}: params.${f} missing`);
    if (!Array.isArray(m.params?.tiers) || !m.params.tiers.length) errs.push(`${m.name}: params.tiers missing`);
  });
  if (!cfg.oracle || cfg.oracle.medianMaxAgeSecs === undefined) errs.push("oracle.medianMaxAgeSecs missing");
  return errs;
}

/** Hash of the deploy-relevant config: `verifiedOnChain` blocks and prose are excluded so re-verifying does not change it. */
function configHash(cfg) {
  const strip = (x) => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === "object") {
      const o = {};
      for (const k of Object.keys(x).sort()) if (k !== "verifiedOnChain" && k !== "notes") o[k] = strip(x[k]);
      return o;
    }
    return x;
  };
  return "0x" + crypto.createHash("sha256").update(JSON.stringify(strip(cfg))).digest("hex");
}

/** For broadcast: every reference actually used must have been verified on-chain recently. */
function verificationProblems(cfg, maxAgeHours = 24, now = Date.now()) {
  const probs = [];
  for (const r of addressRefs(cfg)) {
    const v = r.node.verifiedOnChain;
    if (!v || v.ok !== true) probs.push(`${r.label}: not verified on-chain (run verify-addresses.js)`);
    else if (now - Date.parse(v.checkedAt) > maxAgeHours * 3600e3) probs.push(`${r.label}: verification older than ${maxAgeHours}h`);
  }
  return probs;
}

function marketCreateArgs(m, feedId = m.feedId) {
  const p = m.params;
  return [
    { feed: feedId, tick: BigInt(p.tick), lot: BigInt(p.lot), minNotional: BigInt(p.minNotional), maxOrderSize: BigInt(p.maxOrderSize), maxOI: BigInt(p.maxOI),
      maxAge: Number(p.maxAge), bandBps: Number(p.bandBps), maxSpreadBps: Number(p.maxSpreadBps), fundingInterval: Number(p.fundingInterval),
      premiumDivisor: Number(p.premiumDivisor), fundingCap: BigInt(p.fundingCap) },
    p.tiers.map((t) => ({ upToNotional: BigInt(t.upToNotional), imrBps: Number(t.imrBps), mmrBps: Number(t.mmrBps) })),
  ];
}

function gitCommit(cwd = __dirname) {
  try { return require("child_process").execSync("git rev-parse HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}

function isLocalSimulate(argv = process.argv, env = process.env) {
  return env.LOCAL_SIMULATE === "1" || argv.includes("--local-simulate");
}

function table(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(w[i])).join("  ");
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), w.map((x) => "-".repeat(x)).join("  "), ...rows.map(line)].join("\n");
}

module.exports = { ARB_SEPOLIA_CHAIN_ID, HARDHAT_CHAIN_ID, DEFAULT_PUBLIC_RPC, EIP170, CONFIG_PATH, DEPLOYMENT_PATH, ADDR_RE, B32_RE,
  normalizeKey, hygieneProblems, redact, assertDeployerMatch, expectedDeployer, assertChainId, broadcastGate, requireSigner, loadConfig, saveConfig, addressRefs, validateConfig, configHash,
  verificationProblems, marketCreateArgs, gitCommit, isLocalSimulate, table };
