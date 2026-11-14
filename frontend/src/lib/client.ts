import { createPublicClient, http } from "viem";
import { chain, IS_LOCAL, RPC_URL } from "./config";

// JSON-RPC batching: lets us fan out many eth_calls in one HTTP request without needing a Multicall3 deployment.
export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { batch: { wait: 10, batchSize: IS_LOCAL ? 100 : 20 }, retryCount: IS_LOCAL ? 3 : 5, retryDelay: 400 }),
  pollingInterval: IS_LOCAL ? 1000 : 4000, // public testnet RPCs rate-limit: poll gently
});
