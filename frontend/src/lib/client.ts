import { createPublicClient, http } from "viem";
import { chain, RPC_URL } from "./config";

// JSON-RPC batching: lets us fan out many eth_calls in one HTTP request without needing a Multicall3 deployment.
export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { batch: { wait: 10, batchSize: 100 } }),
  pollingInterval: 1000,
});
