// Shared helpers for the dev scripts (viem against the isolated frontend node). DEV ONLY: uses the public Hardhat mnemonic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, defineChain } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const gen = (f) => JSON.parse(fs.readFileSync(path.join(here, "../src/generated", f), "utf8"));
export const deployment = gen("deployment.json");
export const exchangeAbi = gen("PerpExchange.merged.json");
export const usdcAbi = gen("MockUSDC.json");
export const oracleAbi = JSON.parse(fs.readFileSync(path.join(here, "../../contracts/abi/ManualOracle.json"), "utf8"));
export const RPC = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:18647";
export const chain = defineChain({ id: deployment.chainId, name: "fe", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const pub = createPublicClient({ chain, transport: http(RPC) });
export const MNEMONIC = "test test test test test test test test test test test junk";
export const account = (i) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
export const wallet = (i) => createWalletClient({ account: account(i), chain, transport: http(RPC) });
export const acctKey = (owner, sub = 0) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint8" }], [owner, sub]));
export const usd = (n) => BigInt(Math.round(n * 1e6));
export const btc = (n) => BigInt(Math.round(n * 1e8));
export const TIF = { GTC: 0, IOC: 1, FOK: 2, PostOnly: 3 };

export async function write(i, address, abi, functionName, args = []) {
  const w = wallet(i);
  let hash;
  try { hash = await w.writeContract({ address, abi, functionName, args }); }
  catch (e) { throw new Error(`${functionName} failed: ${e.metaMessages?.[0] ?? e.shortMessage ?? e.message}`); }
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}
export const ex = (i, fn, args) => write(i, deployment.exchange, exchangeAbi, fn, args);
export const rpc = (method, params = []) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
export const order = (o) => ({ market: 0, isBuy: true, price: 0n, size: 0n, tif: TIF.GTC, reduceOnly: false, cloid: 0n, expiry: 0n, ...o });
export const setPrice = (name, px) => write(0, deployment.oracle, oracleAbi, "set", [deployment.feeds[name], usd(px)]);
