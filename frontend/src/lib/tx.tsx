"use client";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { parseEventLogs, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { publicClient } from "./client";
import { EXCHANGE, exchangeAbi, IS_LOCAL } from "./config";
import { isRateLimit, nextPollDelay } from "./network";
import { explainError } from "./errors";
import { friendlyClient, type ErrorContext, type Friendly } from "./messages";
import { cancelReasonText } from "./order";
import { fmtPrice, fmtSize, fmtUsd } from "./units";
import { useWallet } from "./wallet";
import { summarizeOrder, type ChainEvent, type Kind, type OrderOutcome } from "./lifecycle";

/**
 * Transaction lifecycle, shown as DISTINCT states (never an optimistic "done"):
 *   signing -> submitted (hash returned by node) -> included (receipt obtained) -> executed (receipt.status=success, canonical events decoded)
 *   or reverted (receipt.status=reverted) / failed (rejected before submission, e.g. simulation revert or user rejected)
 * Parent-chain batch posting / finality / bridge withdrawal availability is NOT tracked (no parent chain on local).
 */
export type TxState = "signing" | "submitted" | "included" | "executed" | "reverted" | "failed";
export interface TxEntry {
  id: number; label: string; state: TxState; hash?: Hex; block?: bigint; gasUsed?: bigint; events: string[]; kind: Kind; unit?: string; outcome?: OrderOutcome; error?: Friendly; /** set when the entry has been shown as a toast and dismissed */ dismissed?: boolean; signer: "owner" | "session key" | "dev relayer"; at: number;
}

interface Req {
  label: string; /** what this transaction is, so the toast can speak about the ORDER (open, filled, canceled) and not only the transaction */ kind?: Kind; /** base asset for quantity wording, e.g. BTC */ unit?: string; address?: Address; abi?: Abi; functionName?: string; args?: readonly unknown[];
  /** plain native-token transfer (used to fund the session key with gas on local) */
  transfer?: { to: Address; value: bigint };
  /** use the trading-only session key if the user enabled it (only valid for trading calls) */
  trading?: boolean;
  /** submit from the dev relayer account (LOCAL): used for placeSigned, where the signature (not the sender) carries the authority */
  relayer?: boolean;
  /** async step run in the "signing" state that yields the call args (e.g. an EIP-712 signature). A throw marks the entry failed. */
  prepare?: () => Promise<readonly unknown[]>;
  /** context for friendlier errors (e.g. the USDC shortfall for an Unhealthy revert) */
  ctx?: ErrorContext;
}
interface TxCtx { txs: TxEntry[]; send(r: Req): Promise<TxEntry["state"]>; clear(): void; dismiss(id: number): void }
const Ctx = createContext<TxCtx | null>(null);
/** Fee caps with headroom on public testnets. Left to the wallet, MetaMask can pick a max fee equal to the current base fee on Arbitrum (0.02 gwei), and the base fee ticks up before the transaction lands ("max fee per gas less than block base fee"). You are charged the real base fee, not the cap. */
async function feeCaps(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  if (IS_LOCAL) return {};
  try {
    const f = await publicClient.estimateFeesPerGas();
    if (!f.maxFeePerGas) return {};
    const maxFeePerGas = f.maxFeePerGas * 2n;
    const prio = f.maxPriorityFeePerGas ?? 0n;
    return { maxFeePerGas, maxPriorityFeePerGas: prio < maxFeePerGas ? prio : maxFeePerGas };
  } catch { return {}; }
}

export const useTx = () => { const c = useContext(Ctx); if (!c) throw new Error("TxProvider missing"); return c; };

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Receipt wait with backoff. Local: fast and short. Testnet: slower chain and rate-limited public RPC, so back off and keep going for 3 minutes. */
async function waitReceipt(hash: Hex): Promise<TransactionReceipt> {
  const deadline = Date.now() + (IS_LOCAL ? 60_000 : 180_000);
  for (let attempt = 0; ; attempt++) {
    let limited = false;
    try { return await publicClient.getTransactionReceipt({ hash }); }
    catch (e) { if (!/not.?found|could not be found/i.test(String((e as Error)?.message ?? e)) && !isRateLimit(e)) throw e; limited = isRateLimit(e); }
    if (Date.now() > deadline) throw new Error("Timed out waiting for the receipt");
    await new Promise((r) => setTimeout(r, IS_LOCAL ? 500 : nextPollDelay(attempt, limited)));
  }
}

export function parseExchangeEvents(receipt: TransactionReceipt): ChainEvent[] {
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === EXCHANGE.toLowerCase());
  try { return (parseEventLogs({ abi: exchangeAbi, logs }) as any[]).map((e) => ({ name: e.eventName as string, args: (e.args ?? {}) as Record<string, unknown> })); } catch { return []; }
}
export function describeEvents(receipt: TransactionReceipt): string[] {
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === EXCHANGE.toLowerCase());
  let parsed: any[] = [];
  try { parsed = parseEventLogs({ abi: exchangeAbi, logs }) as any[]; } catch { /* ignore */ }
  return parsed.map((e) => {
    const a = e.args ?? {};
    switch (e.eventName) {
      case "OrderAccepted": return `OrderAccepted #${a.id} ${a.isBuy ? "buy" : "sell"} ${fmtSize(a.size)} @ ${fmtPrice(a.price)}`;
      case "Fill": return `Fill #${a.tradeId} ${fmtSize(a.size)} @ ${fmtPrice(a.price)} (taker ${a.takerIsBuy ? "bought" : "sold"})`;
      case "OrderRested": return `OrderRested #${a.id} remaining ${fmtSize(a.remaining)}`;
      case "OrderCanceled": return `OrderCanceled #${a.id} - ${cancelReasonText(Number(a.reason))}`;
      case "OrderTruncated": return `OrderTruncated #${a.id} remaining ${fmtSize(a.remaining)} (not rested)`;
      case "Deposit": return `Deposit ${fmtUsd(a.amount)} USDC`;
      case "Withdraw": return `Withdraw ${fmtUsd(a.amount)} USDC`;
      case "IsoMargin": return `IsoMargin ${a.delta > 0n ? "+" : ""}${fmtUsd(a.delta)}`;
      case "IsolatedMode": return `IsolatedMode ${a.on ? "on" : "off"} (market ${a.market})`;
      case "CondPlaced": return `CondPlaced #${a.id} trigger ${fmtPrice(a.trigger)}`;
      case "InternalTransfer": return `InternalTransfer ${fmtUsd(a.amount)} USDC (subaccount to subaccount)`;
      case "FundingUpdated": return `FundingUpdated market ${a.market}: ${a.intervals} interval(s), rate ${a.rate}`;
      case "AgentApproved": if (a.expiry === 0n) return `AgentRevoked ${String(a.agent).slice(0, 8)}…`; return `AgentApproved ${String(a.agent).slice(0, 8)}… until ${new Date(Number(a.expiry) * 1000).toLocaleString()}`;
      case "BadDebtUnresolved": return `BadDebtUnresolved ${fmtUsd(a.amount)} USDC (loss not covered by the insurance fund; deleveraging or recapitalization is needed)`;
      case "BackstopSynced": return (a.fromInsurance as bigint) + (a.toDebt as bigint) > 0n ? `BackstopSynced: backstop loss recorded ${fmtUsd((a.fromInsurance as bigint) + (a.toDebt as bigint))} USDC (insurance ${fmtUsd(a.fromInsurance)}, bad debt ${fmtUsd(a.toDebt)})` : `BackstopSynced: earlier backstop draws repaid ${fmtUsd((a.refundedInsurance as bigint) + (a.repaidDebt as bigint))} USDC`;
      case "BackstopElevated": return `BackstopElevated market ${a.market}: inventory ${fmtUsd(a.notional)} USDC is above its cap, the discount auction has started`;
      case "BackstopRelaxed": return `BackstopRelaxed market ${a.market}: inventory is back under its cap`;
      case "BackstopTaken": return `BackstopTaken market ${a.market}: ${a.takerSold ? "sold" : "bought"} ${fmtSize(a.size)} at ${fmtPrice(a.price)} (${a.discBps} bps from index, fee ${fmtUsd(a.fee)} USDC)`;
      case "BackstopUnwound": return `BackstopUnwound market ${a.market}: closed ${fmtSize(a.size)} at ${fmtPrice(a.price)}`;
      case "AdlSkipped": return `AdlSkipped market ${a.market}: target had no margin slack`;
      case "Recapitalized": return `Recapitalized market ${a.market}: ${fmtUsd(a.amount)} USDC`;
      case "AdlExecuted": return `AdlExecuted market ${a.market}: debt cleared ${fmtUsd(a.debtCleared)}`;
      case "TwapSlice": return `TwapSlice #${a.id} slice ${a.sliceIndex} filled ${fmtSize(a.filled)} (${a.ok ? "ok" : "failed"})`;
      case "MarketState": return `MarketState market ${a.market} -> ${a.s}`;
      case "TwapPlaced": return `TwapPlaced #${a.id} ${a.slices} slices`;
      default: return String(e.eventName);
    }
  });
}

export function TxProvider({ children }: { children: ReactNode }) {
  const [txs, setTxs] = useState<TxEntry[]>([]);
  const nextId = useRef(1);
  const qc = useQueryClient();
  const w = useWallet();

  const patch = useCallback((id: number, p: Partial<TxEntry>) => setTxs((l) => l.map((t) => (t.id === id ? { ...t, ...p } : t))), []);

  const send = useCallback(async (r: Req): Promise<TxState> => {
    const id = nextId.current++;
    const viaRelayer = !!r.relayer && !!w.relayerClient;
    const viaAgent = !viaRelayer && !!r.trading && w.useAgentKey && !!w.agentClient;
    const client = viaRelayer ? w.relayerClient : viaAgent ? w.agentClient : w.walletClient;
    const account = viaRelayer ? w.relayerAccount?.address : viaAgent ? w.agentAccount?.address : w.address;
    setTxs((l) => [{ id, label: r.label, state: "signing" as const, events: [], kind: r.kind ?? "other", unit: r.unit, signer: (viaRelayer ? "dev relayer" : viaAgent ? "session key" : "owner") as TxEntry["signer"], at: Date.now() }, ...l].slice(0, 25));
    if (!client || !account) { patch(id, { state: "failed", error: friendlyClient("no-wallet") }); return "failed"; }
    let hash: Hex;
    try {
      const args = r.prepare ? await r.prepare() : r.args ?? [];
      const req = { address: r.address ?? EXCHANGE, abi: r.abi ?? exchangeAbi, functionName: r.functionName, args, account } as any;
      if (r.transfer) {
        hash = await client.sendTransaction({ to: r.transfer.to, value: r.transfer.value, chain: client.chain, account: client.account ?? account, ...(await feeCaps()) });
      } else {
        // Pre-flight simulation: surfaces the decoded custom error before anything is signed. Not a result: just a guard.
        await publicClient.simulateContract(req);
        // A key held in the browser (session key, relayer) is sent with exactly the estimated gas, and on Arbitrum the estimate can land a few percent short of what the call then needs (first-touch storage, the fill path): "out of gas" with the gas spent. Add 40% headroom off-local; unused gas is not charged.
        const gas = IS_LOCAL ? undefined : await publicClient.estimateContractGas(req).then((g) => (g * 14n) / 10n).catch(() => undefined);
        hash = await client.writeContract({ ...req, chain: client.chain, account: client.account ?? account, ...(gas ? { gas } : {}), ...(await feeCaps()) });
      }
    } catch (e) { patch(id, { state: "failed", error: explainError(e, r.ctx) }); return "failed"; }
    patch(id, { state: "submitted", hash });
    try {
      const receipt = await waitReceipt(hash);
      patch(id, { state: "included", block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      if (receipt.status === "success") {
        patch(id, { state: "executed", events: describeEvents(receipt), outcome: summarizeOrder(parseExchangeEvents(receipt), w.acct) });
        await qc.invalidateQueries();
        return "executed";
      }
      patch(id, { state: "reverted", error: friendlyClient("reverted") });
      await qc.invalidateQueries();
      return "reverted";
    } catch (e) { patch(id, { error: friendlyClient("receipt-timeout", explainError(e).detail) }); return "submitted"; }
  }, [w, patch, qc]);

  return <Ctx.Provider value={{ txs, send, clear: () => setTxs([]), dismiss: (id) => patch(id, { dismissed: true }) }}>{children}</Ctx.Provider>;
}
