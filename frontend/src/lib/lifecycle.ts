/**
 * Order status vs transaction status, as a pure state machine. An order is never shown as filled/open until the receipt (and its events) say so.
 * The local chain automines, so intermediate stages may never be observed: this module only reports what the data proves.
 */
import { CANCEL_PRICE_BAND } from "./order";
export type TxPhase = "signing" | "submitted" | "included" | "executed" | "reverted" | "failed";
export type Kind = "place" | "cancel" | "other";
export type OrderStatus = "awaiting-wallet" | "submitted" | "open" | "partial" | "filled" | "remainder-canceled" | "not-filled" | "cancel-submitted" | "canceled" | "nothing-to-cancel" | "rejected" | "not-sent" | "done";

export interface ChainEvent { name: string; args: Record<string, unknown> }
export interface OrderOutcome { size: bigint; filled: bigint; rested: bigint; canceled: bigint; cancelReason?: number; orderId?: bigint }

const big = (v: unknown) => (typeof v === "bigint" ? v : 0n);

/** Fold the exchange events of one transaction into what happened to the order(s). `acct` limits fills to the user's own. */
export function summarizeOrder(events: ChainEvent[], acct?: string): OrderOutcome {
  const o: OrderOutcome = { size: 0n, filled: 0n, rested: 0n, canceled: 0n };
  const mine = (v: unknown) => !acct || String(v).toLowerCase() === acct.toLowerCase();
  for (const e of events) {
    const a = e.args;
    switch (e.name) {
      case "OrderAccepted": if (mine(a.acct)) { o.size += big(a.size); o.orderId ??= a.id as bigint; } break;
      case "Fill": if (mine(a.taker) || mine(a.maker)) o.filled += big(a.size); break;
      case "OrderRested": o.rested += big(a.remaining); break;
      case "OrderTruncated": o.canceled += big(a.remaining); break;
      case "OrderCanceled":
        // A fill can cancel OTHER people's resting orders (PriceBand): those are not part of this user's order outcome.
        if (Number(a.reason) === CANCEL_PRICE_BAND && a.id !== o.orderId) break;
        o.canceled += big(a.remaining); o.cancelReason = Number(a.reason); break;
    }
  }
  return o;
}

export interface Phrase {
  status: OrderStatus;
  headline: string;
  detail: string;
  tone: "pending" | "ok" | "warn" | "bad";
  /** the transaction line, kept separate from the order status */
  tx: string;
  /** true once the receipt is final for this action */
  final: boolean;
}

const txLine = (s: TxPhase, block?: bigint) =>
  s === "signing" ? "Transaction: waiting for your wallet" : s === "submitted" ? "Transaction: sent, not yet in a block" : s === "included" ? `Transaction: in block ${block ?? "-"}, checking the result`
    : s === "executed" ? `Transaction: confirmed in block ${block ?? "-"}` : s === "reverted" ? `Transaction: rejected by the chain${block ? ` in block ${block}` : ""}` : "Transaction: not sent";

export function lifecycle(i: { kind: Kind; state: TxPhase; outcome?: OrderOutcome; unit?: string; block?: bigint; label?: string }): Phrase {
  const { kind, state, outcome: o } = i;
  const u = i.unit ?? "";
  const tx = txLine(state, i.block);
  const fmt = (n: bigint) => { const s = (Number(n) / 1e8).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); return s || "0"; };
  const sp = (n: bigint) => `${fmt(n)}${u ? ` ${u}` : ""}`;
  if (kind === "place") {
    if (state === "signing") return { status: "awaiting-wallet", headline: "Approve this order in your wallet", detail: "Nothing has been sent yet.", tone: "pending", tx, final: false };
    if (state === "submitted" || state === "included") return { status: "submitted", headline: "Order submitted", detail: "Waiting for the chain to confirm it. Nothing has executed yet.", tone: "pending", tx, final: false };
    if (state === "reverted") return { status: "rejected", headline: "Order rejected by the chain", detail: "No position was opened and no money moved.", tone: "bad", tx, final: true };
    if (state === "failed") return { status: "not-sent", headline: "Order not sent", detail: "Nothing was changed.", tone: "bad", tx, final: true };
    if (!o || o.size === 0n) return { status: "done", headline: "Order confirmed", detail: "The chain confirmed the transaction.", tone: "ok", tx, final: true };
    const total = o.size;
    if (o.filled >= total) return { status: "filled", headline: "Order filled", detail: `${sp(o.filled)} filled. Open Fills to view the execution.`, tone: "ok", tx, final: true };
    if (o.filled > 0n && o.rested > 0n) return { status: "partial", headline: `${fmt(o.filled)} / ${sp(total)} filled`, detail: `The remaining ${sp(o.rested)} is open on the book.`, tone: "warn", tx, final: true };
    if (o.filled > 0n) return { status: "remainder-canceled", headline: `${fmt(o.filled)} / ${sp(total)} filled`, detail: "Remaining quantity canceled.", tone: "warn", tx, final: true };
    if (o.rested > 0n) return { status: "open", headline: "Limit order open", detail: `${sp(o.rested)} is resting on the book until it fills or you cancel it.`, tone: "ok", tx, final: true };
    if (o.cancelReason === CANCEL_PRICE_BAND) return { status: "not-filled", headline: "Order canceled, nothing filled", detail: "Its price was too far from the oracle price. No position was opened.", tone: "warn", tx, final: true };
    return { status: "not-filled", headline: "Order canceled, nothing filled", detail: "Remaining quantity canceled. No position was opened.", tone: "warn", tx, final: true };
  }
  if (kind === "cancel") {
    if (state === "signing") return { status: "awaiting-wallet", headline: "Approve the cancellation in your wallet", detail: "The order stays open until the cancellation is confirmed.", tone: "pending", tx, final: false };
    if (state === "submitted" || state === "included") return { status: "cancel-submitted", headline: "Cancellation submitted", detail: "The order is still open until the chain confirms.", tone: "pending", tx, final: false };
    if (state === "reverted") return { status: "rejected", headline: "Cancellation rejected", detail: "The order may still be open. Check Open orders.", tone: "bad", tx, final: true };
    if (state === "failed") return { status: "not-sent", headline: "Cancellation not sent", detail: "The order is unchanged.", tone: "bad", tx, final: true };
    if (o && o.canceled > 0n) return { status: "canceled", headline: "Remaining quantity canceled", detail: `${sp(o.canceled)} removed from the book.`, tone: "ok", tx, final: true };
    return { status: "nothing-to-cancel", headline: "Nothing to cancel", detail: "The order had already filled or been removed.", tone: "warn", tx, final: true };
  }
  const label = i.label ?? "Action";
  if (state === "signing") return { status: "awaiting-wallet", headline: `Approve in your wallet: ${label}`, detail: "Nothing has been sent yet.", tone: "pending", tx, final: false };
  if (state === "submitted" || state === "included") return { status: "submitted", headline: `${label}: submitted`, detail: "Waiting for confirmation.", tone: "pending", tx, final: false };
  if (state === "executed") return { status: "done", headline: `${label}: confirmed`, detail: "Done.", tone: "ok", tx, final: true };
  if (state === "reverted") return { status: "rejected", headline: `${label}: rejected by the chain`, detail: "Nothing was changed.", tone: "bad", tx, final: true };
  return { status: "not-sent", headline: `${label}: not sent`, detail: "Nothing was changed.", tone: "bad", tx, final: true };
}
