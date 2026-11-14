import { createConfig, http, injected } from "wagmi";
import { connect, getAccount, switchChain } from "wagmi/actions";
import { defineChain } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "./mock-eip1193";
import { addChainParams, chainStatus, networkInfo } from "@/lib/network";

// Same chain shape as src/lib/config.ts in testnet mode (421614, explorer from the network table). Mock provider only: no real wallet or network.
const N = networkInfo(421614);
const sepolia = defineChain({ id: 421614, name: N.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [N.defaultRpc!] } }, blockExplorers: { default: { name: "Explorer", url: N.explorer! } } });
const other = defineChain({ id: 1, name: "Other", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } });
function setup(o: Parameters<typeof createMockProvider>[0]) {
  const provider = createMockProvider(o);
  const connector = injected({ target: () => ({ id: "mock", name: "Mock Wallet", provider: provider as never }) });
  const config = createConfig({ chains: [sepolia, other], connectors: [connector], transports: { [sepolia.id]: http(), [other.id]: http() }, multiInjectedProviderDiscovery: false });
  return { provider, config, connector: config.connectors[0] };
}
beforeAll(() => { vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }); });

describe("Arbitrum Sepolia wallet flow (mock EIP-1193)", () => {
  it("a wallet on another chain is asked to switch to 0x66eee", async () => {
    const { provider, config, connector } = setup({ chainId: 1, knownChains: [1, 421614] });
    await connect(config, { connector, chainId: 421614 });
    expect(provider.calls.find((c) => c.method === "wallet_switchEthereumChain")!.params).toEqual([{ chainId: "0x66eee" }]);
    expect(getAccount(config).chainId).toBe(421614);
  });
  it("an unknown chain is added with RPC and explorer, in the same shape as addChainParams", async () => {
    const { provider, config, connector } = setup({ chainId: 1, knownChains: [1] });
    await connect(config, { connector, chainId: 421614 });
    const add = (provider.calls.find((c) => c.method === "wallet_addEthereumChain")!.params as Record<string, unknown>[])[0];
    expect(add).toMatchObject({ chainId: "0x66eee", chainName: "Arbitrum Sepolia", rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"], blockExplorerUrls: ["https://sepolia.arbiscan.io"] });
    expect(add.chainId).toBe(addChainParams(N, N.defaultRpc!).chainId);
  });
  it("wrong network after connect disables trading until switched back", async () => {
    const { provider, config, connector } = setup({ chainId: 421614, knownChains: [1, 421614] });
    await connect(config, { connector, chainId: 421614 });
    provider.userSwitches(1); await new Promise((r) => setTimeout(r, 0));
    expect(chainStatus(getAccount(config).chainId, 421614)).toBe("wrong");
    await switchChain(config, { chainId: 421614 });
    expect(chainStatus(getAccount(config).chainId, 421614)).toBe("ok");
  });
});
