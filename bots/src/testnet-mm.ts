/**
 * TESTNET market-maker bot (Arbitrum Sepolia only). SIMULATED LIQUIDITY on Circle test USDC: it exists so the testnet UI has an order book.
 * It is NOT a real market maker, has no edge, and the sizes are tiny on purpose. Quotes track the on-chain oracle mark (Chainlink for BTC/ETH/SOL).
 *
 *   tsx src/testnet-mm.ts keygen    create a fresh testnet-only key in bots/.env.mm-testnet (mode 600, git-ignored); prints the ADDRESS only
 *   tsx src/testnet-mm.ts status    balances, collateral, open orders (read-only)
 *   tsx src/testnet-mm.ts setup     approve + deposit test USDC into sub 0         (dry run unless CONFIRM_MM_SETUP=yes)
 *   tsx src/testnet-mm.ts run       quote loop; Ctrl-C pulls all quotes             (sends transactions with the bot key; needs the bot address funded with ETH)
 *   tsx src/testnet-mm.ts stop      cancel all quotes and withdraw free collateral  (dry run unless CONFIRM_MM_STOP=yes)
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
  (process.env.MARKETS ?? "BTC-USD,ETH-USD").split(",").map((s) => s.trim()).filter((n) => n in d.marketIds);

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
  if (cmd === "stop") {
    const open = await c.openOrders(0);
    console.log(`open orders: ${open.length}`);
    if (process.env.CONFIRM_MM_STOP !== "yes") return console.log("DRY RUN: set CONFIRM_MM_STOP=yes to cancel all and withdraw free collateral");
    if (open.length) console.log("cancelAll tx", (await c.cancelAll({ sub: 0 })).hash);
    const w = (await c.accountState(0)).available;
    if (w > 0n) console.log("withdraw tx", (await c.withdraw(w, { sub: 0 })).hash);
    return;
  }
  if (cmd !== "run") throw new Error("usage: keygen | status | setup | run | stop");

  const levelUsd = num("LEVEL_NOTIONAL_USD", 12);
  const maxInvUsd = num("MAX_INV_NOTIONAL_USD", 40);
  const bots: MarketMakerBot[] = [];
  for (const n of names) {
    const market = d.marketIds[n]!;
    const cfg = await c.marketConfig(market, true);
    const px = await c.markPrice(market);
    // round UP to a lot and never below the market's min notional (BTC lot 0.0001 is ~$6.5, so $12 rounded down fell under the $10 minimum and BTC got no quotes)
    const raw = (usd: number) => { const want = (toUsdc(usd) * 10n ** 8n) / px; const lots = (want + cfg.lot - 1n) / cfg.lot; let sz = lots * cfg.lot; while ((sz * px) / 10n ** 8n < cfg.minNotional * 12n / 10n) sz += cfg.lot; return sz; };
    const quote: QuoteConfig = {
      halfSpreadBps: num("HALF_SPREAD_BPS", 25), levels: num("LEVELS", 2), levelStepBps: num("LEVEL_STEP_BPS", 20),
      levelSize: raw(levelUsd), maxInventory: raw(maxInvUsd), skewBps: num("SKEW_BPS", 10),
      refreshBps: num("REFRESH_BPS", 10), maxQuoteAgeMs: num("MAX_QUOTE_AGE_SEC", 300) * 1000,
    };
    bots.push(new MarketMakerBot(c, {
      name: "tmm", market, marketName: n, quote, bidSub: 0, askSub: 0,
      oracleStaleSec: num("ORACLE_STALE_SEC", 3600), // the contract's own maxAge check is the real gate; Chainlink testnet updates are infrequent
      quoteTtlSec: num("QUOTE_TTL_SEC", 900), minAvailable: toUsdc(num("MIN_AVAILABLE_USD", 2)), tif: Tif.GTC,
    }));
  }
  console.log(`${ts()} TESTNET market-maker (simulated liquidity, test USDC) quoting ${names.join(", ")} from ${c.owner}; Ctrl-C pulls quotes`);
  let stop = false;
  process.once("SIGINT", () => (stop = true));
  process.once("SIGTERM", () => (stop = true));
  const interval = num("INTERVAL_MS", 20_000);
  let last = 0;
  while (!stop) {
    const t0 = Date.now();
    for (const b of bots) await b.tick(); // sequential: one key, one nonce
    if (Date.now() - last > 60_000) { last = Date.now(); for (const b of bots) console.log(`${ts()} SUMMARY ${b.summary()}`); }
    await sleep(Math.max(0, interval - (Date.now() - t0)));
  }
  for (const b of bots) await b.pullAll("shutdown", true).catch((e) => console.log("pull failed", (e as Error).message.split("\n")[0]));
  for (const b of bots) console.log(`${ts()} FINAL ${b.summary()}`);
}
main().catch((e) => { console.error(String(e.shortMessage ?? e.message).split("\n")[0]); process.exit(1); });
