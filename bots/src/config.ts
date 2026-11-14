import path from "node:path";
import { fileURLToPath } from "node:url";
import { PerpClient, loadDeployment, type Deployment } from "@perps/sdk";
import { mnemonicToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// PUBLIC hardhat dev mnemonic. LOCAL DEMO ONLY - never put value behind these keys.
export const MNEMONIC = process.env.BOT_MNEMONIC ?? "test test test test test test test test test test test junk";
const here = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT_PATH = process.env.DEPLOYMENT ?? path.resolve(here, "../../contracts/deployments/localhost.json");

export const OWNER_INDEX = 0; // hardhat account #0: deployer == ManualOracle owner
export const MM_INDEXES = (process.env.MM_ACCOUNTS ?? "17,18,19").split(",").map(Number);
export const TAKER_INDEX = Number(process.env.TAKER_ACCOUNT ?? 16);
/** side-set subaccounts: bids from sub 0, asks from sub 1 */
export const BID_SUB = 0;
export const ASK_SUB = 1;

export function privateKeyFor(index: number): Hex {
  const k = mnemonicToAccount(MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!k) throw new Error("no private key");
  return `0x${Buffer.from(k).toString("hex")}`;
}

export async function getDeployment(): Promise<Deployment> {
  return loadDeployment(DEPLOYMENT_PATH);
}
export function clientFor(index: number, d: Deployment, sub = 0): PerpClient {
  return PerpClient.fromPrivateKey({ rpcUrl: RPC_URL, privateKey: privateKeyFor(index), deployment: d, sub });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ts = () => new Date().toISOString().slice(11, 23);
