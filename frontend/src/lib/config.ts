import { defineChain, type Abi, type Address, type Hex } from "viem";
import deployment from "@/generated/deployment.json";
import exchangeAbiJson from "@/generated/PerpExchange.merged.json";
import usdcAbiJson from "@/generated/MockUSDC.json";

// ABI is imported from the generated merged JSON; it is never hand-written here.
export const exchangeAbi = exchangeAbiJson as unknown as Abi;
export const usdcAbi = usdcAbiJson as unknown as Abi;

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? deployment.chainId ?? 31337);
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "";

export const EXCHANGE = deployment.exchange as Address;
export const USDC = deployment.usdc as Address;
export const ORACLE = deployment.oracle as Address;
export const DEPLOY_ENV = deployment.env as string;
export const DEPLOYED = EXCHANGE !== "0x0000000000000000000000000000000000000000";
/** LOCAL = chain id 31337/1337 (hardhat/anvil). Gates the mint button and burner mode. */
export const IS_LOCAL = CHAIN_ID === 31337 || CHAIN_ID === 1337;
export const FEEDS = deployment.feeds as Record<string, Hex>;

export const MARKETS = [
  { id: 0, name: "BTC-USD", base: "BTC" },
  { id: 1, name: "ETH-USD", base: "ETH" },
  { id: 2, name: "SOL-USD", base: "SOL" },
] as const;

export const chain = defineChain({
  id: CHAIN_ID,
  name: IS_LOCAL ? "Local demo chain" : "Perps chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
