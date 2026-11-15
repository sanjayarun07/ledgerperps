/** Builder onboarding: pure logic (no I/O). A builder is an operator who runs their own branded front end on this exchange. */
import type { Address } from "viem";

export const STEPS = ["profile", "frontend", "fees", "revenue", "launch"] as const;
export type StepId = (typeof STEPS)[number];

export interface BuilderState {
  name: string;
  /** wallet that signed the ownership message */
  owner?: Address;
  signature?: string;
  signedMessage?: string;
  referralCode: string;
  /** planned trader taker fee, bps */
  planTakerBps: number;
  /** planned monthly taker volume through this front end, USD */
  planVolumeUsd: number;
  payoutAddress: string;
  brandExported: boolean;
  testnetChecked: boolean;
}

export const EMPTY: BuilderState = { name: "", referralCode: "", planTakerBps: 6, planVolumeUsd: 1_000_000, payoutAddress: "", brandExported: false, testnetChecked: false };

export const nameIssue = (n: string): string | null => {
  const t = n.trim();
  if (t.length < 3) return "Use at least 3 characters.";
  if (t.length > 32) return "Use at most 32 characters.";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(t)) return "Use letters, numbers, spaces, dots, dashes or underscores.";
  return null;
};

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const addressIssue = (a: string): string | null => (ADDRESS.test(a) ? null : "Enter a 0x wallet address (42 characters).");

/** The exact text the wallet signs. Includes the origin so a signature for one site cannot be replayed as another's. */
export const ownershipMessage = (name: string, owner: Address, origin: string, chainId: number): string =>
  `Create builder profile\nName: ${name.trim()}\nWallet: ${owner}\nSite: ${origin}\nChain: ${chainId}\nThis signature only proves wallet ownership. It does not move funds.`;

/** Margin you keep per trade = the fee you charge minus the exchange's own fee. Negative means you would lose money per trade. */
export const marginBps = (traderBps: number, exchangeBps: number): number => Math.round((traderBps - exchangeBps) * 1e6) / 1e6;
/** USD earned on `volumeUsd` of taker volume at `margin` bps */
export const revenueUsd = (volumeUsd: number, margin: number): number => (volumeUsd * margin) / 10_000;

export function feeIssue(traderBps: number, exchangeBps: number): string | null {
  if (!Number.isFinite(traderBps) || traderBps < 0) return "Enter a fee of 0 or more.";
  if (traderBps > 50) return "Fees above 50 bps (0.5%) are very high for a perps venue.";
  if (traderBps < exchangeBps) return `Below the exchange fee of ${exchangeBps} bps, so you would lose money on every trade.`;
  return null;
}

export type StepStatus = "done" | "todo";
/** Which steps are complete. `brandName` is the brand config's name; `brandCustomised` when it differs from the default. */
export function progress(s: BuilderState, ctx: { exchangeBps: number }): Record<StepId, StepStatus> {
  const profile = !nameIssue(s.name) && !!s.owner && !!s.signature;
  return {
    profile: profile ? "done" : "todo",
    frontend: s.brandExported ? "done" : "todo",
    fees: !feeIssue(s.planTakerBps, ctx.exchangeBps) && s.planVolumeUsd > 0 ? "done" : "todo",
    revenue: !addressIssue(s.payoutAddress) ? "done" : "todo",
    launch: s.testnetChecked ? "done" : "todo",
  };
}

export const launchChecklist = (s: BuilderState): { label: string; ok: boolean }[] => [
  { label: "Builder profile signed by your wallet", ok: !!s.signature },
  { label: "brand.config.json exported", ok: s.brandExported },
  { label: "Payout address set", ok: !addressIssue(s.payoutAddress) },
  { label: "Tried the flow on testnet", ok: s.testnetChecked },
];

/** Environment lines for a builder's own deployment of this front end. Public values only. */
export function envFile(opts: { rpc: string; chainId: number; indexer: string; privyAppId?: string }): string {
  return [
    `NEXT_PUBLIC_CHAIN_ID=${opts.chainId}`,
    `NEXT_PUBLIC_RPC_URL=${opts.rpc}`,
    opts.indexer ? `NEXT_PUBLIC_INDEXER_URL=${opts.indexer}` : "# NEXT_PUBLIC_INDEXER_URL=",
    opts.privyAppId ? `NEXT_PUBLIC_PRIVY_APP_ID=${opts.privyAppId}` : "# NEXT_PUBLIC_PRIVY_APP_ID=   (optional: email sign-in)",
  ].join("\n");
}
