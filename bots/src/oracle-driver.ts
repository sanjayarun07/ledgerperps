/**
 * ############################  LOCAL DEMO ONLY - SIMULATED PRICE FEED  ############################
 * Moves the ManualOracle price along a mean-reverting random walk so the demo market has something to do.
 * Uses the oracle OWNER key (hardhat account #0). Refuses to run unless chainId == 31337 AND the RPC is a loopback
 * URL AND the signer really is oracle.owner(). SIMULATED LIQUIDITY - NOT REAL.
 * Env: STEP_MS (2000)  SIGMA_BPS (6 per step)  REVERT (0.02)  MAX_DEV_PCT (4)  SEED  MARKETS  DURATION_SEC
 */
import { PerpClient, fromPrice } from "@perps/sdk";
import { printBanner } from "./banner.js";
import { OWNER_INDEX, RPC_URL, clientFor, getDeployment, sleep, ts } from "./config.js";
import { assertLocalDev } from "./local.js";

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** Pure step function (unit-tested): next price from current, anchor and a N(0,1) draw. */
export function nextPrice(cur: bigint, anchor: bigint, z: number, o: { sigmaBps: number; revert: number; maxDevPct: number; tick: bigint }): bigint {
  const c = Number(cur);
  const a = Number(anchor);
  const drift = -o.revert * Math.log(c / a);
  let n = c * Math.exp(drift + (o.sigmaBps / 10_000) * z);
  const lo = a * (1 - o.maxDevPct / 100);
  const hi = a * (1 + o.maxDevPct / 100);
  n = Math.min(hi, Math.max(lo, n));
  const t = Number(o.tick);
  return BigInt(Math.max(1, Math.round(n / t))) * BigInt(o.tick);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printBanner("oracle driver - LOCAL DEMO ONLY");
  const d = await getDeployment();
  const owner: PerpClient = clientFor(OWNER_INDEX, d);
  await assertLocalDev(owner, RPC_URL, "oracle driver"); // throws -> non-zero exit
  const onchainOwner = await owner.manualOracleOwner();
  if (onchainOwner.toLowerCase() !== owner.owner.toLowerCase()) throw new Error(`REFUSING: signer ${owner.owner} is not ManualOracle.owner (${onchainOwner})`);

  const names = Object.keys(d.marketIds).filter((n) => !process.env.MARKETS || process.env.MARKETS.split(",").includes(n));
  const stepMs = Number(process.env.STEP_MS ?? 2000);
  const opts = { sigmaBps: Number(process.env.SIGMA_BPS ?? 6), revert: Number(process.env.REVERT ?? 0.02), maxDevPct: Number(process.env.MAX_DEV_PCT ?? 4) };
  const rand = mulberry32(Number(process.env.SEED ?? Date.now() % 2 ** 31));
  const end = process.env.DURATION_SEC ? Date.now() + Number(process.env.DURATION_SEC) * 1000 : Infinity;

  const state = new Map<string, { cur: bigint; anchor: bigint; tick: bigint }>();
  for (const n of names) {
    const m = d.marketIds[n]!;
    const cfg = await owner.marketConfig(m);
    const st = await owner.oracleStatus(m);
    state.set(n, { cur: st.price, anchor: st.price, tick: cfg.tick });
    console.log(`${ts()} ${n}: anchor ${fromPrice(st.price)}`);
  }
  let stop = false;
  process.once("SIGINT", () => (stop = true));
  process.once("SIGTERM", () => (stop = true));
  while (!stop && Date.now() < end) {
    for (const n of names) {
      const s = state.get(n)!;
      s.cur = nextPrice(s.cur, s.anchor, gauss(rand), { ...opts, tick: s.tick });
      await owner.setManualOraclePrice(d.feeds[n]!, s.cur);
      console.log(`${ts()} [SIMULATED ORACLE] ${n} -> ${fromPrice(s.cur)}`);
    }
    await sleep(stepMs);
  }
  console.log(`${ts()} oracle driver stopped (prices will go stale - bots will pull quotes)`);
}
