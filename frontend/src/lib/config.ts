import { defineChain, type Abi, type Address, type Hex } from "viem";
import deployment from "@/generated/deployment.json";
import exchangeAbiJson from "@/generated/PerpExchange.merged.json";
import usdcAbiJson from "@/generated/MockUSDC.json";
import { ERC20_ABI, networkInfo, networkKind } from "./network";

// ABI is imported from the generated merged JSON; it is never hand-written here.
export const exchangeAbi = exchangeAbiJson as unknown as Abi;

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? deployment.chainId ?? 31337);
export const NETWORK_KIND = networkKind(CHAIN_ID, process.env.NEXT_PUBLIC_NETWORK_KIND);
export const NETWORK = networkInfo(CHAIN_ID, NETWORK_KIND, process.env.NEXT_PUBLIC_EXPLORER_URL);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? NETWORK.defaultRpc ?? "http://127.0.0.1:8545";
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || "";

export const EXCHANGE = deployment.exchange as Address;
export const USDC = deployment.usdc as Address;
export const ORACLE = deployment.oracle as Address;
export const DEPLOY_ENV = deployment.env as string;
export const DEPLOYED = EXCHANGE !== "0x0000000000000000000000000000000000000000";
/** LOCAL = chain id 31337/1337 (hardhat/anvil). Gates the mint button and burner mode. */
export const IS_LOCAL = NETWORK_KIND === "local";
export const IS_TESTNET = NETWORK_KIND === "testnet";
/** The local MockUSDC ABI has mint; every other network uses a plain ERC-20 ABI. */
export const usdcAbi = (IS_LOCAL ? usdcAbiJson : ERC20_ABI) as unknown as Abi;
export const FEEDS = deployment.feeds as Record<string, Hex>;

export interface MarketDef { id: number; name: string; base: string; /** Testnet demo market whose price is set by the admin; never a real feed. */ demo: boolean }
export const DEMO_TAG = "DEMO - admin-set price";
export const DEMO_BANNER = "Demo market: the price is set by the deployer account, not a real feed. It exists to show the backstop; do not read it as market data.";
/** Markets come from the deployment (`marketIds`), so a testnet deployment with a DEMO-USD market shows it and a local one never does. */
export function marketsFromDeployment(dep: { marketIds?: Record<string, number>; demo?: { market?: string } | null }): MarketDef[] {
  const ids = dep.marketIds && Object.keys(dep.marketIds).length ? dep.marketIds : { "BTC-USD": 0, "ETH-USD": 1, "SOL-USD": 2 };
  return Object.entries(ids)
    .map(([name, id]) => ({ id: Number(id), name, base: name.split("-")[0], demo: dep.demo?.market === name || name.startsWith("DEMO") }))
    .sort((a, b) => a.id - b.id);
}
export const MARKETS: readonly MarketDef[] = marketsFromDeployment(deployment as unknown as Parameters<typeof marketsFromDeployment>[0]);

export const chain = defineChain({
  id: CHAIN_ID,
  name: NETWORK.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  ...(NETWORK.explorer ? { blockExplorers: { default: { name: "Explorer", url: NETWORK.explorer } } } : {}),
});
