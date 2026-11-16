/**
 * TESTNET taker (Arbitrum Sepolia only). SIMULATED ACTIVITY on free test USDC: it crosses the best resting quote on a fixed timer so the
 * chart, trade history and 24h stats keep moving. It is a separate wallet from the market maker so its transactions never share the
 * maker's nonce (the maker's quoting pass can take minutes, which made an in-process taker too slow). It has no edge and no view.
 *
 *   tsx src/testnet-taker.ts keygen    create a fresh testnet-only key in bots/.env.taker-testnet (mode 600, git-ignored); prints the ADDRESS only
 *   tsx src/testnet-taker.ts status    ETH, test USDC, collateral, position (read-only)
 *   tsx src/testnet-taker.ts setup     approve + deposit test USDC (dry run unless CONFIRM_TAKER_SETUP=yes; TAKER_DEPOSIT_USDC, default 500)
 *   tsx src/testnet-taker.ts run       trade loop (sends transactions; Ctrl-C stops)
 * env: TAKER_EVERY_SEC (20), TAKER_SIZE raw 1e8 (default 100000 = 0.001 BTC, about $65), TAKER_MARKET (BTC-USD), TAKER_MAX_POS raw (default 3x size)
 * The key is read from TAKER_PRIVATE_KEY or bots/.env.taker-testnet and is never printed. Never use the deployer or maker key here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PerpClient, Tif, loadDeployment, toUsdc, fromUsdc, fromPrice, fromSize } from "@perps/sdk";
import type { Hex } from "viem";
import { sleep, ts } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYFILE = path.resolve(here, "../.env.taker-testnet");
const DEP = process.env.DEPLOYMENT ?? path.resolve(here, "../../contracts/deployments/arbitrumSepolia.json");
const RPC = process.env.TAKER_RPC_URL ?? process.env.MM_RPC_URL ?? "http://127.0.0.1:18701";
const CHAIN = 421614;
const num = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

function loadKey(): Hex {
  let k = process.env.TAKER_PRIVATE_KEY;
  if (!k && fs.existsSync(KEYFILE)) k = /^TAKER_PRIVATE_KEY=(\S+)/m.exec(fs.readFileSync(KEYFILE, "utf8"))?.[1];
  if (!k) throw new Error(`no key: run "keygen" first (or export TAKER_PRIVATE_KEY)`);
  k = k.startsWith("0x") ? k : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("TAKER_PRIVATE_KEY is not 32 bytes of hex");
  return k as Hex;
}

async function main() {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "keygen") {
    if (fs.existsSync(KEYFILE)) throw new Error(`${KEYFILE} exists; refusing to overwrite`);
    const pk = generatePrivateKey();
    fs.writeFileSync(KEYFILE, `# testnet-only taker key. Git-ignored. Never reuse it for anything with value.\nTAKER_PRIVATE_KEY=${pk}\n`, { mode: 0o600 });
    console.log(`created ${KEYFILE} (mode 600). Taker address: ${privateKeyToAccount(pk).address}`);
    return;
  }
  const d = await loadDeployment(DEP);
  const c = PerpClient.fromPrivateKey({ rpcUrl: RPC, privateKey: loadKey(), deployment: d, sub: 0 });
  if ((await c.chainId()) !== CHAIN || d.chainId !== CHAIN) throw new Error(`REFUSING: this tool only runs on Arbitrum Sepolia (${CHAIN})`);
  const deployer = (JSON.parse(fs.readFileSync(DEP, "utf8")) as { deployer?: string }).deployer?.toLowerCase();
  if (deployer && c.owner.toLowerCase() === deployer) throw new Error("REFUSING: the taker key must not be the deployer key");
  const name = process.env.TAKER_MARKET ?? "BTC-USD";
  const market = d.marketIds[name];
  if (market === undefined) throw new Error(`unknown market ${name}`);

  if (cmd === "status") {
    const [eth, usdc, st, pos] = await Promise.all([c.publicClient.getBalance({ address: c.owner }), c.usdcBalance(), c.accountState(0), c.positions(0)]);
    console.log(`taker ${c.owner}\n  ETH ${Number(eth) / 1e18}\n  test USDC in wallet ${fromUsdc(usdc)}\n  exchange equity ${fromUsdc(st.equity)}, available ${fromUsdc(st.available)}`);
    for (const p of pos) if (p.size !== 0n) console.log(`  position market ${p.market}: ${fromSize(p.size)}`);
    return;
  }
  if (cmd === "setup") {
    const amt = toUsdc(num("TAKER_DEPOSIT_USDC", 500));
    console.log(`deposit ${fromUsdc(amt)} test USDC into sub 0 (wallet holds ${fromUsdc(await c.usdcBalance())})`);
    if (process.env.CONFIRM_TAKER_SETUP !== "yes") return console.log("dry run: set CONFIRM_TAKER_SETUP=yes to send");
    if ((await c.usdcAllowance()) < amt) console.log("approve tx", (await c.approveUsdc()).hash);
    console.log("deposit tx", (await c.deposit(amt)).hash);
    return;
  }
  if (cmd !== "run") throw new Error(`unknown command ${cmd}`);

  let stop = false;
  process.once("SIGINT", () => (stop = true));
  process.once("SIGTERM", () => (stop = true));
  const every = num("TAKER_EVERY_SEC", 20) * 1000;
  const size = BigInt(num("TAKER_SIZE", 100000));
  const maxPos = BigInt(num("TAKER_MAX_POS", Number(size) * 3));
  let n = 0, failures = 0;
  console.log(`${ts()} TESTNET taker (simulated activity, test USDC) on ${name} from ${c.owner}: ${fromSize(size)} every ${every / 1000}s`);
  while (!stop) {
    const t0 = Date.now();
    try {
      const cfg = await c.marketConfig(market);
      const pos = (await c.positions(0)).find((p) => p.market === market)?.size ?? 0n;
      // alternate sides; if inventory has drifted past the cap, trade toward flat instead
      let isBuy = n++ % 2 === 0;
      if (pos > maxPos) isBuy = false; else if (-pos > maxPos) isBuy = true;
      const top = await c.bestPrice(market, !isBuy);
      if (top === 0n) { console.log(`${ts()} [taker] no ${isBuy ? "asks" : "bids"}, skipped`); }
      else {
        const px = isBuy ? top + cfg.tick : top - cfg.tick;
        const r = await c.placeOrder({ market, isBuy, price: px, size, tif: Tif.IOC, reduceOnly: false, cloid: 0n, expiry: 0n }, { sub: 0 });
        console.log(`${ts()} [taker] ${isBuy ? "buy" : "sell"} @ ${fromPrice(px)} (best ${fromPrice(top)}) order ${r.orderId} net ${fromSize(pos)}`);
        failures = 0;
      }
    } catch (e) {
      failures++;
      console.log(`${ts()} [taker] skipped (${failures}): ${String((e as Error).message).split("\n")[0]}`);
      if (failures >= 20) throw new Error("20 failures in a row, stopping");
    }
    await sleep(Math.max(0, every - (Date.now() - t0)));
  }
  console.log(`${ts()} taker stopped`);
}
main().catch((e) => { console.error(String((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]); process.exit(1); });
