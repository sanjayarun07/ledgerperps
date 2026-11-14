/**
 * Minimal scriptable EIP-1193 provider standing in for a browser-extension wallet (none is available in CI / this sandbox).
 * It records every request so tests can assert which prompts the app triggered (eth_requestAccounts, wallet_switchEthereumChain,
 * wallet_addEthereumChain ...). Behaviour knobs model real wallet quirks: unknown chain (4902) and user rejection (4001).
 */
export interface MockOptions { chainId: number; accounts?: string[]; knownChains?: number[]; rejectConnect?: boolean; rejectSwitch?: boolean }
export class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }

export function createMockProvider(o: MockOptions) {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const state = { chainId: o.chainId, accounts: [] as string[], connected: false, known: new Set(o.knownChains ?? [o.chainId]) };
  const calls: { method: string; params?: unknown }[] = [];
  const emit = (ev: string, ...a: unknown[]) => listeners.get(ev)?.forEach((f) => f(...a));
  const hex = (n: number) => `0x${n.toString(16)}`;
  const provider = {
    isMock: true,
    calls, state,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId": return hex(state.chainId);
        case "net_version": return String(state.chainId);
        case "eth_accounts": return state.connected ? state.accounts : [];
        case "eth_requestAccounts":
          if (o.rejectConnect) throw new RpcError(4001, "User rejected the request.");
          state.connected = true; state.accounts = o.accounts ?? ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"];
          emit("connect", { chainId: hex(state.chainId) });
          return state.accounts;
        case "wallet_switchEthereumChain": {
          const id = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16);
          if (o.rejectSwitch) throw new RpcError(4001, "User rejected the request.");
          if (!state.known.has(id)) throw new RpcError(4902, "Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain.");
          state.chainId = id; emit("chainChanged", hex(id)); return null;
        }
        case "wallet_addEthereumChain": {
          const id = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16);
          state.known.add(id); state.chainId = id; emit("chainChanged", hex(id)); return null;
        }
        case "wallet_requestPermissions": return [{ parentCapability: "eth_accounts" }];
        case "wallet_revokePermissions": return null;
        default: throw new RpcError(-32601, `mock: unsupported method ${method}`);
      }
    },
    on(ev: string, fn: (...a: unknown[]) => void) { (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(fn); },
    removeListener(ev: string, fn: (...a: unknown[]) => void) { listeners.get(ev)?.delete(fn); },
    /** simulate the user switching networks inside the wallet UI */
    userSwitches(id: number) { state.chainId = id; emit("chainChanged", hex(id)); },
    userDisconnects() { state.connected = false; state.accounts = []; emit("accountsChanged", []); },
  };
  return provider;
}
export type MockProvider = ReturnType<typeof createMockProvider>;
