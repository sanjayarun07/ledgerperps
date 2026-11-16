/**
 * TESTNET market-maker bot (Arbitrum Sepolia only). SIMULATED LIQUIDITY on Circle test USDC: it exists so the testnet UI has an order book.
 * It is NOT a real market maker, has no edge, and the sizes are tiny on purpose. Quotes track the on-chain oracle mark (Chainlink for BTC/ETH/SOL).
 *
 *   tsx src/testnet-mm.ts keygen    create a fresh testnet-only key in bots/.env.mm-testnet (mode 600, git-ignored); prints the ADDRESS only
 *   tsx src/testnet-mm.ts status    balances, collateral, open orders (read-only)
 *   tsx src/testnet-mm.ts setup     approve + deposit test USDC into sub 0         (dry run unless CONFIRM_MM_SETUP=yes)
 *   tsx src/testnet-mm.ts run       quote loop; Ctrl-C pulls all quotes             (sends transactions with the bot key; needs the bot address funded with ETH)
 *   tsx src/testnet-mm.ts stop      cancel all quotes and withdraw free collateral  (dry run unless CONFIRM_MM_STOP=yes)
 * Thick BTC book (DEPTH=thick; see src/depth.ts): a 3-tier ladder, each tier on its own pair of subaccounts (DEPTH_SUB_BASE, default 4).
 *   tsx src/testnet-mm.ts preflight  read-only: oracle freshness and accuracy, ladder geometry, collateral, ETH, open-interest cap; exits 1 on errors
 *   tsx src/testnet-mm.ts fanout     move collateral from sub 0 into the tier subaccounts (dry run unless CONFIRM_MM_FANOUT=yes)
 *   DEPTH=thick DEPTH_SCALE=0.5 tsx src/testnet-mm.ts run   (run refuses to start when preflight has errors unless DEPTH_SKIP_PREFLIGHT=yes)
 * The key is read from MM_PRIVATE_KEY or bots/.env.mm-testnet and is never printed. Never use the deployer key here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PerpClient, Tif, loadDeployment, toUsdc, fromUsdc, fromPrice, fromSize } from "@perps/sdk";
import type { Hex } from "viem";
import { MarketMakerBot } from "./mm.js";
import type { QuoteConfig } from "./quotes.js";
import { sleep, ts } from "./config.js";
import { HyperliquidVenue } from "./hyperliquid.js";
import { THICK_BTC, buildDepthPlan, hasErrors, preflight, requiredCollateral, type DepthTier } from "./depth.js";
import { Hedger, HyperliquidRefVenue, SimulatedVenue, toRaw, type HedgeConfig, type HedgeVenue } from "./hedge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYFILE = path.resolve(here, "../.env.mm-testnet");
const DEP = process.env.DEPLOYMENT ?? path.resolve(here, "../../contracts/deployments/arbitrumSepolia.json");
const RPC = process.env.MM_RPC_URL ?? "http://127.0.0.1:18701"; // infra/testnet/run-indexer.sh starts this rate-limit-friendly forwarder
const CHAIN = 421614;
const num = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

function loadKey(): Hex {
  let k = process.env.MM_PRIVATE_KEY;
  if (!k && fs.existsSync(KEYFILE)) k = /^MM_PRIVATE_KEY=(\S+)/m.exec(fs.readFileSync(KEYFILE, "utf8"))?.[1];
  if (!k) throw new Error(`no key: run "keygen" first (or export MM_PRIVATE_KEY)`);
  k = k.startsWith("0x") ? k : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("MM_PRIVATE_KEY is not 32 bytes of hex");
  return k as Hex;
}

const HL_KEYFILE = path.resolve(here, "../.env.hl-testnet");
function loadHlKey(): Hex {
  let k = process.env.HL_PRIVATE_KEY;
  if (!k && fs.existsSync(HL_KEYFILE)) k = /^HL_PRIVATE_KEY=(\S+)/m.exec(fs.readFileSync(HL_KEYFILE, "utf8"))?.[1];
  if (!k) throw new Error(`HEDGE=hl needs a Hyperliquid TESTNET key: export HL_PRIVATE_KEY or create ${HL_KEYFILE}. Use a fresh key; never the deployer or MM key.`);
  k = k.startsWith("0x") ? k : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("HL_PRIVATE_KEY is not 32 bytes of hex");
  return k as Hex;
}

async function client() {
  const d = await loadDeployment(DEP);
  const c = PerpClient.fromPrivateKey({ rpcUrl: RPC, privateKey: loadKey(), deployment: d, sub: 0 });
  const id = await c.chainId();
  if (id !== CHAIN) throw new Error(`REFUSING: chainId ${id}, this tool only runs on Arbitrum Sepolia (${CHAIN})`);
  if (d.chainId !== CHAIN) throw new Error(`REFUSING: deployment file is for chain ${d.chainId}`);
  const deployer = (JSON.parse(fs.readFileSync(DEP, "utf8")) as { deployer?: string }).deployer?.toLowerCase();
  if (deployer && c.owner.toLowerCase() === deployer) throw new Error("REFUSING: the bot key must not be the deployer key");
  return { c, d };
}

const marketNames = (d: { marketIds: Record<string, number> }) =>
  (process.env.MARKETS ?? "BTC-USD,ETH-USD,SOL-USD").split(",").map((s) => s.trim()).filter((n) => n in d.marketIds);


const depthOn = () => (process.env.DEPTH ?? "off") === "thick";

/** Independent spot price for the accuracy check (read-only public endpoint; failure just skips the check). */
async function refPriceUsd(): Promise<number | undefined> {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", { signal: AbortSignal.timeout(5000) });
    const v = Number(((await r.json()) as { data?: { amount?: string } }).data?.amount);
    return v > 0 ? v : undefined;
  } catch { return undefined; }
}

async function depthContext(c: PerpClient, d: { marketIds: Record<string, number> }) {
  const market = d.marketIds["BTC-USD"];
  if (market === undefined) throw new Error("deployment has no BTC-USD market");
  const cfg = await c.marketConfig(market, true);
  const oracle = await c.oracleStatus(market);
  const plan = buildDepthPlan({ tiers: THICK_BTC, subBase: num("DEPTH_SUB_BASE", 4), px: oracle.price, lot: cfg.lot, minNotional: cfg.minNotional, maxOrderSize: cfg.maxOrderSize, scale: num("DEPTH_SCALE", 1) });
  const subs = [0, ...plan.flatMap((t: DepthTier) => [t.bidSub, t.askSub])];
  let available = 0n;
  for (const sb of subs) available += (await c.accountState(sb)).available;
  return { market, cfg, oracle, plan, subs, available };
}

async function runPreflight(c: PerpClient, d: { marketIds: Record<string, number> }): Promise<boolean> {
  const x = await depthContext(c, d);
  const checks = preflight({
    market: x.cfg, plan: x.plan, px: x.oracle.price, oracle: { fresh: x.oracle.fresh, ageSec: Number(x.oracle.ageSec) }, refPriceUsd: await refPriceUsd(),
    ethBalance: await c.publicClient.getBalance({ address: c.owner }), availableUsdc: x.available,
    ethPerTx: Number((await c.publicClient.getGasPrice()) * 350_000n) / 1e18, // live gas price x ~350k gas per order transaction
  });
  for (const k of checks) console.log(`  [${k.level.toUpperCase().padEnd(5)}] ${k.msg}`);
  const bad = hasErrors(checks);
  console.log(bad ? "PREFLIGHT FAILED" : "PREFLIGHT OK (simulated liquidity on test USDC; nothing here is real market depth)");
  return !bad;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "keygen") {
    if (fs.existsSync(KEYFILE)) throw new Error(`${KEYFILE} exists; refusing to overwrite`);
    const pk = generatePrivateKey();
    fs.writeFileSync(KEYFILE, `# testnet-only market-maker key. Git-ignored. Never reuse it for anything with value.\nMM_PRIVATE_KEY=${pk}\n`, { mode: 0o600 });
    console.log(`created ${KEYFILE} (mode 600). Bot address: ${privateKeyToAccount(pk).address}`);
    return;
  }
  const { c, d } = await client();
  const names = marketNames(d);
  if (cmd === "status") {
    const st = await c.accountState(0);
    console.log(`bot ${c.owner}\n  ETH ${Number((await c.publicClient.getBalance({ address: c.owner })) / 10n ** 12n) / 1e6}  test USDC (wallet) ${fromUsdc(await c.usdcBalance())}  allowance ${(await c.usdcAllowance()) > 0n ? "set" : "none"}`);
    console.log(`  sub0 equity ${fromUsdc(st.equity)} available ${fromUsdc(st.available)}`);
    for (const n of names) {
      const m = d.marketIds[n]!;
      const open = (await c.openOrders(0)).filter((o) => o.market === m);
      const pos = (await c.getPosition(c.acct(0), m)).size;
      console.log(`  ${n}: mark ${fromPrice(await c.markPrice(m).catch(() => 0n))} position ${fromSize(pos)} open orders ${open.length}`);
    }
    return;
  }
  if (cmd === "setup") {
    const amt = toUsdc(num("MM_DEPOSIT_USDC", 20));
    const bal = await c.usdcBalance();
    console.log(`deposit ${fromUsdc(amt)} test USDC into sub 0 (wallet holds ${fromUsdc(bal)})`);
    if (bal < amt) throw new Error("wallet has less test USDC than MM_DEPOSIT_USDC: fund it first (contracts/scripts/testnet/fund-mm.js)");
    if (process.env.CONFIRM_MM_SETUP !== "yes") return console.log("DRY RUN: set CONFIRM_MM_SETUP=yes to send approve + deposit");
    if ((await c.usdcAllowance()) < amt) console.log("approve tx", (await c.approveUsdc()).hash);
    console.log("deposit tx", (await c.deposit(amt)).hash);
    return;
  }
  if (cmd === "preflight") {
    if (!(await runPreflight(c, d))) process.exit(1);
    return;
  }
  if (cmd === "fanout") {
    const x = await depthContext(c, d);
    const have = new Map<number, bigint>();
    for (const sb of x.subs) have.set(sb, (await c.accountState(sb)).available);
    const moves: { sub: number; amt: bigint }[] = [];
    for (const t of x.plan) {
      const need = requiredCollateral(x.cfg, [t], x.oracle.price).total;
      for (const sb of [t.bidSub, t.askSub]) { const want = need / 2n; const cur = have.get(sb) ?? 0n; if (cur < want) moves.push({ sub: sb, amt: want - cur }); }
    }
    const total = moves.reduce((a, m) => a + m.amt, 0n);
    for (const m of moves) console.log(`  sub 0 -> sub ${m.sub}: ${fromUsdc(m.amt)} test USDC`);
    console.log(`total ${fromUsdc(total)}; sub 0 has ${fromUsdc(have.get(0) ?? 0n)} free`);
    if (total > (have.get(0) ?? 0n)) throw new Error("sub 0 has less free collateral than the fan-out needs: deposit more (setup) or lower DEPTH_SCALE");
    if (process.env.CONFIRM_MM_FANOUT !== "yes") return console.log("DRY RUN: set CONFIRM_MM_FANOUT=yes to send the transfers");
    for (const m of moves) console.log(`transfer to sub ${m.sub}`, (await c.transferInternal(0, m.sub, m.amt)).hash);
    return;
  }
  if (cmd === "stop") {
    if (depthOn()) {
      const x = await depthContext(c, d);
      const confirm = process.env.CONFIRM_MM_STOP === "yes";
      for (const sb of x.subs.filter((v) => v !== 0)) {
        const n = (await c.openOrders(sb)).length;
        console.log(`sub ${sb}: ${n} open orders`);
        if (!confirm) continue;
        if (n) console.log(`  cancelAll tx`, (await c.cancelAll({ sub: sb })).hash);
        const av = (await c.accountState(sb)).available;
        if (av > 0n) console.log(`  sweep ${fromUsdc(av)} to sub 0`, (await c.transferInternal(sb, 0, av)).hash);
      }
      if (!confirm) console.log("DRY RUN: set CONFIRM_MM_STOP=yes to cancel all tier orders and sweep collateral back to sub 0");
    }
    const open = await c.openOrders(0);
    console.log(`open orders: ${open.length}`);
    if (process.env.CONFIRM_MM_STOP !== "yes") return console.log("DRY RUN: set CONFIRM_MM_STOP=yes to cancel all and withdraw free collateral");
    if (open.length) console.log("cancelAll tx", (await c.cancelAll({ sub: 0 })).hash);
    const w = (await c.accountState(0)).available;
    if (w > 0n) console.log("withdraw tx", (await c.withdraw(w, { sub: 0 })).hash);
    return;
  }
  if (cmd !== "run") throw new Error("usage: keygen | status | setup | preflight | fanout | run | stop");

  const levelUsd = num("LEVEL_NOTIONAL_USD", 12);
  const maxInvUsd = num("MAX_INV_NOTIONAL_USD", 40);
  // HEDGE=sim: hedge inventory on an in-memory venue priced off Hyperliquid testnet mids (if reachable) else the oracle. HEDGE=ref: only compare prices.
  // Neither places real orders anywhere: signing Hyperliquid exchange actions is not implemented.
  const hedgeMode = process.env.HEDGE ?? "off";
  const hl = new HyperliquidRefVenue();
  const hedgeSym = (n: string) => n.split("-")[0]!;
  let venue: HedgeVenue | undefined;
  if (hedgeMode === "sim") venue = new SimulatedVenue(async (sym) => { try { return await hl.mid(sym); } catch { const m = d.marketIds[`${sym}-USD`]!; return Number(await c.markPrice(m)) / 1e6; } });
  else if (hedgeMode === "ref") venue = hl;
  else if (hedgeMode === "hl") venue = new HyperliquidVenue(loadHlKey()); // REAL signed orders on Hyperliquid TESTNET with its own testnet key
  const hedgeCfg = (cfg: { lot: bigint }): HedgeConfig => ({
    thresholdRaw: toRaw(num("HEDGE_THRESHOLD_UNITS", 0.0005)), maxClipRaw: toRaw(num("HEDGE_MAX_CLIP_UNITS", 0.01)), minClipRaw: cfg.lot,
    maxDivergenceBps: num("HEDGE_MAX_DIVERGENCE_BPS", 150), cooldownMs: num("HEDGE_COOLDOWN_SEC", 10) * 1000,
  });
  const bots: MarketMakerBot[] = [];
  const takerSizes = new Map<number, bigint>();
  if (depthOn()) {
    if (process.env.DEPTH_SKIP_PREFLIGHT !== "yes" && !(await runPreflight(c, d))) throw new Error("preflight failed: fix the errors above (or DEPTH_SKIP_PREFLIGHT=yes to override)");
    const x = await depthContext(c, d);
    for (const t of x.plan) {
      bots.push(new MarketMakerBot(c, {
        name: `tmm-${t.tier.name}`, market: x.market, marketName: "BTC-USD", quote: t.quote, bidSub: t.bidSub, askSub: t.askSub,
        oracleStaleSec: num("ORACLE_STALE_SEC", 3600), quoteTtlSec: num("QUOTE_TTL_SEC", 3600), minAvailable: toUsdc(num("MIN_AVAILABLE_USD", 2)), tif: Tif.GTC,
      }));
    }
    takerSizes.set(x.market, x.plan[0]!.quote.levelSize);
  }
  for (const n of depthOn() ? [] : names) {
    const market = d.marketIds[n]!;
    const cfg = await c.marketConfig(market, true);
    const px = await c.markPrice(market);
    // round UP to a lot and never below the market's min notional (BTC lot 0.0001 is ~$6.5, so $12 rounded down fell under the $10 minimum and BTC got no quotes)
    const raw = (usd: number) => { const want = (toUsdc(usd) * 10n ** 8n) / px; const lots = (want + cfg.lot - 1n) / cfg.lot; let sz = lots * cfg.lot; while ((sz * px) / 10n ** 8n < cfg.minNotional * 12n / 10n) sz += cfg.lot; return sz; };
    const quote: QuoteConfig = {
      halfSpreadBps: num("HALF_SPREAD_BPS", 25), levels: num("LEVELS", 2), levelStepBps: num("LEVEL_STEP_BPS", 20),
      levelSize: raw(levelUsd), maxInventory: raw(maxInvUsd), skewBps: num("SKEW_BPS", 10), keepMinSize: true,
      refreshBps: num("REFRESH_BPS", 10), maxQuoteAgeMs: num("MAX_QUOTE_AGE_SEC", 300) * 1000,
    };
    takerSizes.set(market, quote.levelSize);
    bots.push(new MarketMakerBot(c, {
      name: "tmm", market, marketName: n, quote, bidSub: 0, askSub: 0,
      hedger: venue ? new Hedger(venue, hedgeSym(n), hedgeCfg(cfg), (m) => console.log(`${ts()} [hedge] ${m}`)) : undefined,
      oracleStaleSec: num("ORACLE_STALE_SEC", 3600), // the contract's own maxAge check is the real gate; Chainlink testnet updates are infrequent
      quoteTtlSec: num("QUOTE_TTL_SEC", 900), minAvailable: toUsdc(num("MIN_AVAILABLE_USD", 2)), tif: Tif.GTC,
    }));
  }
  console.log(`${ts()} TESTNET market-maker (simulated liquidity, test USDC) quoting ${depthOn() ? `BTC-USD thick ladder (${bots.length} tiers)` : names.join(", ")} from ${c.owner}; Ctrl-C pulls quotes`);
  let stop = false;
  process.once("SIGINT", () => (stop = true));
  process.once("SIGTERM", () => (stop = true));
  const interval = num("INTERVAL_MS", depthOn() ? 15_000 : 20_000);
  let last = 0;
  // Small taker (sub-account 1): every TAKER_EVERY_SEC it crosses ONE resting quote (IOC, one level) so the chart, trade history and 24h stats have real trades. 0 disables it.
  const takerEvery = num("TAKER_EVERY_SEC", depthOn() ? 0 : 45) * 1000; let lastTake = Date.now(), takeN = 0;
  const TAKER_SUB = 1;
  async function takerTick() {
    const ids = [...takerSizes.keys()]; const market = ids[takeN % ids.length]!; const isBuy = Math.floor(takeN / ids.length) % 2 === 0; takeN++;
    try {
      if ((await c.accountState(TAKER_SUB)).available < toUsdc(3)) { const amt = toUsdc(num("TAKER_FUND_USDC", 6)); if ((await c.accountState(0)).available > amt + toUsdc(8)) await c.transferInternal(0, TAKER_SUB, amt); else return console.log(`${ts()} [taker] skipped: not enough free collateral to fund sub ${TAKER_SUB}`); }
      const top = await c.bestPrice(market, !isBuy); if (top === 0n) return;
      const cfg = await c.marketConfig(market, true);
      const px = isBuy ? top + cfg.tick : top - cfg.tick;
      const frac = BigInt(Math.round(num("TAKER_SIZE_FRAC", 1) * 1000)); const sz = ((takerSizes.get(market)! * frac / 1000n) / cfg.lot) * cfg.lot; if (sz === 0n) return;
      const r = await c.placeOrder({ market, isBuy, price: px, size: sz, tif: Tif.IOC, reduceOnly: false, cloid: 0n, expiry: 0n }, { sub: TAKER_SUB });
      console.log(`${ts()} [taker] ${isBuy ? "buy" : "sell"} market ${market} @ ${fromPrice(px)} (best ${fromPrice(top)}) order ${r.orderId}`);
    } catch (e) { console.log(`${ts()} [taker] skipped: ${String((e as Error).message).split("\n")[0]}`); }
  }
  while (!stop) {
    const t0 = Date.now();
    const maybeTake = async () => { if (takerEvery > 0 && Date.now() - lastTake >= takerEvery) { lastTake = Date.now(); await takerTick(); } };
    await maybeTake();
    for (const b of bots) { await b.tick(); await maybeTake(); } // sequential: one key, one nonce. A full pass can take minutes, so the taker is checked between tiers too
    if (Date.now() - last > 60_000) { last = Date.now(); for (const b of bots) console.log(`${ts()} SUMMARY ${b.summary()}`); }
    await sleep(Math.max(0, interval - (Date.now() - t0)));
  }
  for (const b of bots) await b.pullAll("shutdown", true).catch((e) => console.log("pull failed", (e as Error).message.split("\n")[0]));
  for (const b of bots) console.log(`${ts()} FINAL ${b.summary()}`);
}
main().catch((e) => { console.error(String(e.shortMessage ?? e.message).split("\n")[0]); process.exit(1); });
