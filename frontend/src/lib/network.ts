/** Network / environment layer. Pure functions only (no env reads), so every rule is unit-testable; src/lib/config.ts wires in the env. */
export type NetworkKind = "local" | "testnet" | "mainnet";

export interface NetworkInfo {
  kind: NetworkKind; chainId: number; name: string; shortName: string; explorer?: string; defaultRpc?: string;
  faucets?: { usdc?: string; eth?: string[] }; nativeSymbol: string;
}
export const NETWORKS: Record<number, NetworkInfo> = {
  31337: { kind: "local", chainId: 31337, name: "Local demo chain", shortName: "Local", nativeSymbol: "ETH" },
  1337: { kind: "local", chainId: 1337, name: "Local demo chain", shortName: "Local", nativeSymbol: "ETH" },
  421614: {
    kind: "testnet", chainId: 421614, name: "Arbitrum Sepolia", shortName: "Arbitrum Sepolia", explorer: "https://sepolia.arbiscan.io", defaultRpc: "https://sepolia-rollup.arbitrum.io/rpc",
    faucets: { usdc: "https://faucet.circle.com", eth: ["https://www.alchemy.com/faucets/arbitrum-sepolia", "https://faucet.quicknode.com/arbitrum/sepolia"] }, nativeSymbol: "ETH",
  },
  42161: { kind: "mainnet", chainId: 42161, name: "Arbitrum One", shortName: "Arbitrum One", explorer: "https://arbiscan.io", defaultRpc: "https://arb1.arbitrum.io/rpc", nativeSymbol: "ETH" },
  1: { kind: "mainnet", chainId: 1, name: "Ethereum", shortName: "Ethereum", explorer: "https://etherscan.io", nativeSymbol: "ETH" },
};

const isKind = (s: unknown): s is NetworkKind => s === "local" || s === "testnet" || s === "mainnet";
/** Explicit NEXT_PUBLIC_NETWORK_KIND wins; otherwise inferred from the chain id. An unknown chain id is treated as mainnet-like (the safe, strict side). */
export function networkKind(chainId: number, explicit?: string): NetworkKind {
  if (isKind(explicit)) return explicit;
  return NETWORKS[chainId]?.kind ?? "mainnet";
}
export function networkInfo(chainId: number, kind: NetworkKind = networkKind(chainId), explorerOverride?: string): NetworkInfo {
  const base = NETWORKS[chainId] ?? { kind, chainId, name: kind === "local" ? "Local demo chain" : "Perps chain", shortName: "Perps chain", nativeSymbol: "ETH" };
  return { ...base, kind, explorer: explorerOverride || base.explorer };
}

const trim = (u: string) => u.replace(/\/+$/, "");
const HASH = /^0x[0-9a-fA-F]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/;
/** Explorer links; undefined when the network has no explorer (local) or the value is not a well-formed hash / address. */
export const explorerTx = (n: Pick<NetworkInfo, "explorer">, hash: string): string | undefined => (n.explorer && HASH.test(hash) ? `${trim(n.explorer)}/tx/${hash}` : undefined);
export const explorerAddress = (n: Pick<NetworkInfo, "explorer">, addr: string): string | undefined => (n.explorer && ADDR.test(addr) ? `${trim(n.explorer)}/address/${addr}` : undefined);

/** Banner text for the always-visible strip. */
export function bannerText(n: Pick<NetworkInfo, "kind" | "shortName">): string {
  if (n.kind === "testnet") return `TESTNET - ${n.shortName} - test funds only`;
  if (n.kind === "mainnet") return `MAINNET - ${n.shortName} - real funds at risk`;
  return "LOCAL DEMO - mock USDC, manual oracle, not real liquidity";
}
export const FOOTER_NOTICE = "Unaudited prototype contracts: do not use with real funds.";
/** Short status label for the footer ("Local demo chain", "Arbitrum Sepolia (testnet)"). */
export const footerNetworkLabel = (n: Pick<NetworkInfo, "kind" | "shortName" | "name">): string => (n.kind === "testnet" ? `${n.shortName} (testnet)` : n.kind === "mainnet" ? n.shortName : n.name);

/** A mainnet build is refused unless the operator explicitly declares a real deployment (the white-label disclaimer rule). */
export function mainnetGuard(kind: NetworkKind, realDeployment: boolean): { ok: true } | { ok: false; message: string } {
  if (kind === "mainnet" && !realDeployment) return { ok: false, message: "This build points at a mainnet but NEXT_PUBLIC_REAL_DEPLOYMENT=1 is not set, so it refuses to render. The contracts are unaudited prototypes; set the flag only for a deliberate real deployment." };
  return { ok: true };
}

/** wallet_addEthereumChain parameters for a network (what wagmi sends when the wallet does not know the chain). */
export function addChainParams(n: NetworkInfo, rpcUrl: string) {
  return { chainId: `0x${n.chainId.toString(16)}`, chainName: n.name, nativeCurrency: { name: "Ether", symbol: n.nativeSymbol, decimals: 18 }, rpcUrls: [rpcUrl], ...(n.explorer ? { blockExplorerUrls: [n.explorer] } : {}) };
}

/** Wallet <-> app chain relationship. Trading is allowed only for "ok". */
export type ChainStatus = "ok" | "wrong" | "unknown";
export function chainStatus(walletChainId: number | undefined, appChainId: number): ChainStatus { return walletChainId === undefined ? "unknown" : walletChainId === appChainId ? "ok" : "wrong"; }
export const switchLabel = (n: Pick<NetworkInfo, "shortName" | "kind">) => (n.kind === "local" ? "Switch network" : `Switch to ${n.shortName}`);

/** Confirmation depth text for slower chains. */
export function confirmationsText(txBlock: bigint | undefined, head: bigint | undefined): string {
  if (txBlock === undefined || head === undefined) return "Waiting for confirmation";
  const c = head >= txBlock ? head - txBlock + 1n : 1n;
  return `${c} confirmation${c === 1n ? "" : "s"}`;
}

/** Receipt polling with backoff: 1s, 1.5s, 2.25s ... capped at 8s; after an RPC rate limit (429 / "rate") jump straight to the cap. */
export function nextPollDelay(attempt: number, rateLimited = false): number { return rateLimited ? 8000 : Math.min(8000, Math.round(1000 * 1.5 ** Math.max(0, attempt))); }
export const isRateLimit = (e: unknown): boolean => /429|rate.?limit|too many requests|exceeded/i.test(String((e as { message?: string; shortMessage?: string })?.shortMessage ?? (e as { message?: string })?.message ?? e));

/** Approve + deposit as a small state machine. `allowance` and `bal` are in 6-decimal base units. */
export type DepositStep = "enter-amount" | "insufficient-balance" | "needs-approve" | "ready" | "approving" | "depositing";
export function depositStep(i: { amount: bigint | null; bal: bigint; allowance: bigint; pending?: "approve" | "deposit" }): DepositStep {
  if (i.pending === "approve") return "approving";
  if (i.pending === "deposit") return "depositing";
  if (i.amount === null || i.amount <= 0n) return "enter-amount";
  if (i.amount > i.bal) return "insufficient-balance";
  return i.allowance >= i.amount ? "ready" : "needs-approve";
}
export const DEPOSIT_TEXT: Record<DepositStep, string> = {
  "enter-amount": "Enter an amount to deposit.",
  "insufficient-balance": "You do not have enough USDC in your wallet.",
  "needs-approve": "Step 1 of 2: allow the exchange to use this USDC. Your wallet will ask you to approve.",
  ready: "Step 2 of 2: deposit. Your wallet will ask you to confirm.",
  approving: "Step 1 of 2: waiting for the approval to confirm on-chain.",
  depositing: "Step 2 of 2: waiting for the deposit to confirm on-chain.",
};
export const SIGN_ORDER_TEXT = "Approve this order in your wallet.";

/** Plain ERC-20 ABI (real USDC has no public mint). */
export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** Demo market (admin-set ManualOracle behind RoutingOracle): there is no Pyth or Chainlink feed to blame. */
export const demoStaleText = (name: string) => `${name} uses an admin-set demo price. It has not been refreshed recently, so new positions are paused on this market until the admin sets the price again. Other markets are unaffected.`;
/** Oracle explanation for a degraded market. `ageSec` is the age of the freshest source if known. */
export function oracleDegradedText(ageSec?: number, kind?: "demo" | "chainlink" | "median" | "manual", name = "This market"): string {
  if (kind === "demo") return demoStaleText(name);
  const age = ageSec === undefined ? "" : ` (last update ${ageSec < 120 ? `${ageSec}s` : `${Math.round(ageSec / 60)} min`} ago)`;
  if (kind === "chainlink") return `Price feed delayed${age}: the Chainlink price is stale, so the exchange cannot trust the price. New positions are temporarily unavailable; you can still cancel orders and add collateral. It recovers on the next Chainlink update.`;
  return `Price feed delayed${age}: the Pyth or Chainlink price source is stale, so the exchange cannot trust the median price. New positions are temporarily unavailable; you can still cancel orders and add collateral. It recovers on the next oracle update.`;
}
