// Shared by the examples. LOCAL DEMO ONLY: uses the public hardhat mnemonic and MockUSDC.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mnemonicToAccount } from "viem/accounts";
import { loadDeployment, PerpClient, toUsdc } from "../src/index.js";

export const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const MNEMONIC = "test test test test test test test test test test test junk"; // PUBLIC hardhat dev mnemonic
const here = path.dirname(fileURLToPath(import.meta.url));
export const deployment = await loadDeployment(process.env.DEPLOYMENT ?? path.resolve(here, "../../../contracts/deployments/localhost.json"));
export const key = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
export function clientFor(i: number, o: { sub?: number } = {}): PerpClient {
  const a = key(i);
  const c = PerpClient.fromPrivateKey({ rpcUrl: RPC, privateKey: `0x${Buffer.from(a.getHdKey().privateKey!).toString("hex")}`, deployment, sub: o.sub });
  return c;
}
export async function fundIfNeeded(c: PerpClient, usd = 10_000) {
  if ((await c.collateral()) >= toUsdc(usd)) return;
  await c.mintMockUsdc(c.owner, toUsdc(usd));
  await c.approveUsdc();
  await c.deposit(toUsdc(usd));
}
