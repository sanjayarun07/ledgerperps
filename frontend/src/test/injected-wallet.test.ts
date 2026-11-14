import { createConfig, http, injected } from "wagmi";
import { connect, disconnect, getAccount, switchChain } from "wagmi/actions";
import { defineChain } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "./mock-eip1193";

// The app's own chain definition shape (src/lib/config.ts) with the dev id; no network is touched by connect/switch.
const APP_CHAIN_ID = 31337;
const appChain = defineChain({ id: APP_CHAIN_ID, name: "Local demo chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:18647"] } } });
const mainnetish = defineChain({ id: 1, name: "Other", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } });

/** Same connector wiring as src/components/Providers.tsx, but pointing `injected` at a mock provider instead of window.ethereum. */
function setup(opts: Parameters<typeof createMockProvider>[0]) {
  const provider = createMockProvider(opts);
  const connector = injected({ target: () => ({ id: "mock", name: "Mock Wallet", provider: provider as never }) });
  const config = createConfig({ chains: [appChain, mainnetish], connectors: [connector], transports: { [appChain.id]: http(), [mainnetish.id]: http() }, multiInjectedProviderDiscovery: false });
  return { provider, config, connector: config.connectors[0] };
}
const methods = (p: ReturnType<typeof createMockProvider>) => p.calls.map((c) => c.method);

// wagmi's injected connector refuses to resolve a provider unless a `window` exists; the provider itself is the mock.
beforeAll(() => { vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }); });

describe("injected wallet (mock EIP-1193 provider)", () => {
  it("connect asks the wallet for accounts and reports the account + chain", async () => {
    const { provider, config, connector } = setup({ chainId: APP_CHAIN_ID });
    const r = await connect(config, { connector, chainId: APP_CHAIN_ID });
    expect(methods(provider)).toContain("eth_requestAccounts");
    expect(r.accounts[0].toLowerCase()).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(getAccount(config)).toMatchObject({ isConnected: true, chainId: APP_CHAIN_ID });
    expect(methods(provider)).not.toContain("wallet_switchEthereumChain"); // already on the right chain: no switch prompt
  });

  it("connecting while the wallet is on another chain prompts a chain switch to the app chain", async () => {
    const { provider, config, connector } = setup({ chainId: 1, knownChains: [1, APP_CHAIN_ID] });
    await connect(config, { connector, chainId: APP_CHAIN_ID });
    expect(methods(provider)).toEqual(expect.arrayContaining(["eth_requestAccounts", "wallet_switchEthereumChain"]));
    expect(provider.calls.find((c) => c.method === "wallet_switchEthereumChain")!.params).toEqual([{ chainId: "0x7a69" }]);
    expect(getAccount(config).chainId).toBe(APP_CHAIN_ID);
  });

  it("detects a wrong chain after connect (what drives the 'Switch network' banner) and switchChain prompts the wallet", async () => {
    const { provider, config, connector } = setup({ chainId: APP_CHAIN_ID, knownChains: [1, APP_CHAIN_ID] });
    await connect(config, { connector, chainId: APP_CHAIN_ID });
    provider.userSwitches(1); // user flips network in the extension
    await new Promise((r) => setTimeout(r, 0));
    expect(getAccount(config).chainId).toBe(1); // app compares this against CHAIN_ID => wrongChain === true
    await switchChain(config, { chainId: APP_CHAIN_ID });
    expect(methods(provider).filter((m) => m === "wallet_switchEthereumChain")).toHaveLength(1);
    expect(getAccount(config).chainId).toBe(APP_CHAIN_ID);
  });

  it("falls back to wallet_addEthereumChain when the wallet does not know the chain (error 4902)", async () => {
    const { provider, config, connector } = setup({ chainId: 1, knownChains: [1] });
    await connect(config, { connector, chainId: APP_CHAIN_ID });
    const seq = methods(provider);
    expect(seq.indexOf("wallet_switchEthereumChain")).toBeGreaterThan(-1);
    expect(seq.indexOf("wallet_addEthereumChain")).toBeGreaterThan(seq.indexOf("wallet_switchEthereumChain"));
    const add = provider.calls.find((c) => c.method === "wallet_addEthereumChain")!.params as [{ chainId: string; rpcUrls: string[]; chainName: string }];
    expect(add[0]).toMatchObject({ chainId: "0x7a69", rpcUrls: ["http://127.0.0.1:18647"], chainName: "Local demo chain" });
    expect(getAccount(config).chainId).toBe(APP_CHAIN_ID);
  });

  it("surfaces a user rejection of the connect prompt (4001) and stays disconnected", async () => {
    const { config, connector } = setup({ chainId: APP_CHAIN_ID, rejectConnect: true });
    await expect(connect(config, { connector, chainId: APP_CHAIN_ID })).rejects.toMatchObject({ message: expect.stringMatching(/reject/i) });
    expect(getAccount(config).isConnected).toBe(false);
  });

  it("a rejected chain-switch prompt leaves the wallet on the old chain (the app then keeps showing the wrong-network banner)", async () => {
    const { provider, config, connector } = setup({ chainId: APP_CHAIN_ID, knownChains: [1, APP_CHAIN_ID] });
    await connect(config, { connector, chainId: APP_CHAIN_ID });
    provider.userSwitches(1);
    await new Promise((r) => setTimeout(r, 0));
    const rejecting = setup({ chainId: 1, knownChains: [1, APP_CHAIN_ID], rejectSwitch: true });
    await expect(connect(rejecting.config, { connector: rejecting.connector, chainId: APP_CHAIN_ID })).rejects.toBeTruthy();
    expect(getAccount(config).chainId).toBe(1);
  });

  it("disconnect clears the account", async () => {
    const { config, connector } = setup({ chainId: APP_CHAIN_ID });
    await connect(config, { connector, chainId: APP_CHAIN_ID });
    await disconnect(config);
    expect(getAccount(config).isConnected).toBe(false);
  });
});
