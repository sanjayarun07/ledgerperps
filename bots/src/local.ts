import { PerpClient } from "@perps/sdk";

/** The only chain id the demo tooling will run against: Hardhat / Anvil default dev chain. */
export const LOCAL_DEV_CHAIN_ID = 31337;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackUrl(rpcUrl: string): boolean {
  try {
    return LOOPBACK.has(new URL(rpcUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Hard guard for LOCAL DEMO tooling. Refuses unless the RPC is a loopback URL AND eth_chainId == 31337.
 * (A remote fork could report 31337, hence the loopback check as well.) There is deliberately no override.
 */
export async function assertLocalDev(client: PerpClient, rpcUrl: string, what: string): Promise<void> {
  const refuse = (id: unknown) =>
    new Error(`REFUSING to run ${what}: chainId=${id} rpc=${rpcUrl}. This SIMULATED-LIQUIDITY tool only runs on a local dev chain (chainId ${LOCAL_DEV_CHAIN_ID}, loopback RPC).`);
  if (!isLoopbackUrl(rpcUrl)) throw refuse("(not queried: RPC is not loopback)"); // no network traffic to non-local hosts
  const id = await client.chainId();
  if (id !== LOCAL_DEV_CHAIN_ID) throw refuse(id);
}
