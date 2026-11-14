"use client";
import { useEffect, useRef } from "react";
import { useTx } from "@/lib/tx";
import { lifecycle } from "@/lib/lifecycle";
import { pushNote } from "@/lib/notifications";
import { useAccountState, useOrderHistory, useSolvency, useSystem } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { MARKETS } from "@/lib/config";
import { cancelReasonText, MARKET_STATES } from "@/lib/order";
import { fmtUsd } from "@/lib/units";

/** Turns real events into stored notifications: final order/tx results, market-state changes, and margin alerts. Nothing here is synthetic. */
export default function NotificationFeed() {
  const { txs } = useTx();
  const sys = useSystem().data;
  const w = useWallet();
  const acct = useAccountState(w.acct).data;
  const last = useRef<Record<number, number>>({});
  const paused = useRef<boolean | null>(null);
  useEffect(() => {
    for (const t of txs) {
      if (!["executed", "reverted", "failed"].includes(t.state)) continue;
      const p = lifecycle({ kind: t.kind, state: t.state, outcome: t.outcome, unit: t.unit, block: t.block, label: t.label });
      pushNote({ id: `tx-${t.id}-${t.hash ?? t.state}`, kind: t.state === "executed" ? (t.kind === "place" ? "fill" : t.kind === "cancel" ? "order" : "transfer") : "error", title: p.headline, body: `${p.detail} ${p.tx}` });
    }
  }, [txs]);
  useEffect(() => {
    if (!sys) return;
    if (paused.current !== null && paused.current !== sys.globalPaused) pushNote({ id: `paused-${sys.blockNumber}`, kind: "incident", title: sys.globalPaused ? "Trading paused for all markets" : "Trading resumed", body: sys.globalPaused ? "New orders are blocked. You can still cancel orders." : "New orders are accepted again." });
    paused.current = sys.globalPaused;
    for (const m of sys.markets) {
      const prev = last.current[m.id];
      if (prev !== undefined && prev !== m.state) pushNote({ id: `mstate-${m.id}-${m.state}-${sys.blockNumber}`, kind: "incident", title: `${MARKETS[m.id]?.name ?? "Market"} is now ${MARKET_STATES[m.state]}`, body: "The market state changed. See Market info for what is allowed." });
      last.current[m.id] = m.state;
    }
  }, [sys]);
  // Own resting orders cancelled because their price drifted outside the oracle price band (reason PriceBand). Needs the indexer's order history.
  const hist = useOrderHistory(w.acct).data;
  const histSeeded = useRef(false);
  useEffect(() => {
    if (!hist) return;
    for (const o of hist) {
      if (o.cancelReason !== "price_band") continue;
      const id = `band-${o.id}`;
      if (!histSeeded.current && Date.now() / 1000 - o.time > 120) continue; // do not replay old history on first load
      pushNote({ id, kind: "order", title: `${MARKETS[o.market]?.name ?? "Market"} order #${o.id} cancelled`, body: cancelReasonText("price_band") });
    }
    histSeeded.current = true;
  }, [hist]);
  // Bad debt that insurance could not cover (from liquidations, fills, delisting or a permissionless write-off). Existing events at load time are not replayed.
  const sol = useSolvency().data;
  const solSeeded = useRef(false);
  const solSeen = useRef(new Set<string>());
  useEffect(() => {
    if (!sol) return;
    for (const e of sol.events) {
      if (e.kind !== "bad_debt_unresolved" && e.kind !== "liquidation_bad_debt" && e.kind !== "backstop_deficit") continue;
      const id = `baddebt-${e.txHash}-${e.kind}-${e.block}`;
      if (solSeen.current.has(id)) continue;
      solSeen.current.add(id);
      if (!solSeeded.current) continue; // events already on chain when the page opened are not "new"
      pushNote({ id, kind: "incident", title: e.kind === "backstop_deficit" ? `Backstop loss recorded: ${fmtUsd(e.amount)} USDC` : `Bad debt recorded: ${fmtUsd(e.amount)} USDC`, body: "A loss exceeded the insurance fund. Deleveraging (ADL) or a recapitalization will clear it. See Account > Solvency." });
    }
    solSeeded.current = true;
  }, [sol]);
  const warned = useRef(false);
  useEffect(() => {
    if (!acct || acct.mm === 0n) { warned.current = false; return; }
    const close = acct.equity * 100n < acct.mm * 125n;
    if (close && !warned.current) pushNote({ id: `margin-${w.acct}-${Date.now() >> 16}`, kind: "margin", title: "Margin is getting thin", body: "Your equity is within 25% of the maintenance requirement. Add collateral or reduce positions to avoid liquidation." });
    warned.current = close;
  }, [acct, w.acct]);
  return null;
}
