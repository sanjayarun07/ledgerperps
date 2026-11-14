// Read-only on-chain verification of every external dependency in infra/testnet/testnet.config.json.
// Sets the 'verifiedOnChain' field (and only that field) when run against chainId 421614. No key needed.
// Run: npx hardhat --config hardhat.testnet.config.js run scripts/testnet/verify-addresses.js --network arbitrumSepolia
const hre = require("hardhat");
const L = require("./lib");
const { ethers } = hre;

const MAX_AGE_WARN = 3600; // seconds; Chainlink/Pyth older than this is reported STALE (informational, not a hard fail for Pyth)

async function main() {
  const cfg = L.loadConfig();
  const errs = L.validateConfig(cfg);
  if (errs.length) { console.error("Config invalid:\n - " + errs.join("\n - ")); process.exit(1); }
  const net = await ethers.provider.getNetwork();
  L.assertChainId(net.chainId);
  const block = await ethers.provider.getBlock("latest");
  const now = block.timestamp;
  const rows = [];
  const stamp = (node, ok, details) => { node.verifiedOnChain = { ok, checkedAt: new Date().toISOString(), block: block.number, chainId: Number(net.chainId), details }; };
  const row = (item, address, ok, detail) => rows.push({ item, address, result: ok ? "PASS" : "FAIL", detail });
  const hasCode = async (a) => (await ethers.provider.getCode(a)).length > 2;

  // USDC
  {
    const u = cfg.usdc; let ok = false, d = "";
    try {
      if (!(await hasCode(u.address))) d = "no code";
      else {
        const c = new ethers.Contract(u.address, ["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)"], ethers.provider);
        const [dec, sym, nm] = [Number(await c.decimals()), await c.symbol(), await c.name()];
        ok = dec === u.expectedDecimals && sym === u.expectedSymbol; d = `decimals=${dec} symbol=${sym} name="${nm}"`;
      }
    } catch (e) { d = e.message.slice(0, 100); }
    stamp(u, ok, d); row("USDC", u.address, ok, d);
  }
  // Pyth contract
  const pythAbi = ["function getPriceUnsafe(bytes32) view returns (tuple(int64 price,uint64 conf,int32 expo,uint256 publishTime))"];
  {
    const p = cfg.pyth; const ok = await hasCode(p.address); const d = ok ? "has code" : "no code";
    stamp(p, ok, d); row("Pyth contract", p.address, ok, d);
  }
  const pyth = new ethers.Contract(cfg.pyth.address, pythAbi, ethers.provider);
  const pythAges = [];
  for (const m of cfg.markets) {
    if (m.oracleMode === "demo") { row(`${m.name} oracle`, "-", true, "DEMO market: admin-set ManualOracle via RoutingOracle (no external feed to verify; NOT a real price)"); continue; }
    if (m.chainlink) {
      const c = m.chainlink; let ok = false, d = "";
      try {
        if (!(await hasCode(c.address))) d = "no code";
        else {
          const f = new ethers.Contract(c.address, ["function decimals() view returns (uint8)", "function description() view returns (string)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], ethers.provider);
          const [dec, desc, r] = [Number(await f.decimals()), await f.description(), await f.latestRoundData()];
          const age = now - Number(r[3]); const px = Number(r[1]) / 10 ** dec;
          const descOk = desc.replace(/\s/g, "").toUpperCase() === c.description.replace(/\s/g, "").toUpperCase();
          const fresh = age <= Math.max(c.heartbeatSecs, 1) * 2 && age <= (cfg.oracle.medianMaxAgeSecs);
          ok = r[1] > 0n && descOk && dec === 8 && age <= cfg.oracle.medianMaxAgeSecs;
          d = `desc="${desc}"${descOk ? "" : " MISMATCH"} dec=${dec} price=${px} age=${age}s${fresh ? "" : " STALE(> medianMaxAgeSecs)"}`;
        }
      } catch (e) { d = e.message.slice(0, 100); }
      stamp(c, ok, d); row(`${m.name} Chainlink`, c.address, ok, d);
    } else row(`${m.name} Chainlink`, "-", false, "manual-oracle-only (testnet demo)");
    if (m.pyth) {
      let ok = false, d = "";
      try {
        const r = await pyth.getPriceUnsafe(m.pyth.feedId);
        const age = now - Number(r.publishTime); const px = Number(r.price) * 10 ** Number(r.expo);
        ok = r.price > 0n; pythAges.push(age);
        d = `price=${px} conf=${r.conf} expo=${r.expo} age=${age}s${age > MAX_AGE_WARN ? " STALE: needs a Pyth push before MedianOracle will accept it" : ""}`;
      } catch (e) { d = "getPriceUnsafe reverted (feed id unknown to this Pyth contract?)"; pythAges.push(NaN); }
      stamp(m.pyth, ok, d); row(`${m.name} Pyth feed`, m.pyth.feedId.slice(0, 12) + "...", ok, d);
    } else row(`${m.name} Pyth feed`, "-", false, "manual-oracle-only (testnet demo)");
    if (m.oracleMode === "manual") row(`${m.name} mode`, "-", true, "manual-oracle-only (testnet demo)");
  }
  console.log(L.table(rows));
  const failed = rows.filter((r) => r.result === "FAIL").length;
  console.log(`\nBlock ${block.number}, chainId ${net.chainId}. ${rows.length - failed} PASS / ${failed} FAIL`);
  const rec = L.recommendOracleMode(pythAges, cfg.oracle.pythFreshSecs || 600);
  console.log(`\nORACLE MODE RECOMMENDATION: ${rec.mode} (${rec.reason}). Config default is '${cfg.oracle.mode}'. Rule: use 'median' only if Pyth is fresh AND a pusher is running; set ORACLE_MODE=median|chainlink or edit oracle.mode.`);
  cfg.oracle.verifiedOnChain = { checkedAt: new Date().toISOString(), block: block.number, recommendedMode: rec.mode, reason: rec.reason, worstPythAgeSecs: pythAges.length ? Math.max(...pythAges) : null };
  console.log("Note: a stale Pyth price is reported but is not a PASS/FAIL issue of the address; it is a liveness TODO (keeper pusher).");
  if (process.env.NO_WRITE !== "1") { L.saveConfig(cfg); console.log("verifiedOnChain fields written to infra/testnet/testnet.config.json"); }
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e.message); process.exit(1); });
