"use client";
import { DEPLOYED, MARKETS, RPC_URL } from "@/lib/config";
import { DemoBanner } from "@/components/BrandBits";
import { useApp } from "@/lib/app";
import { focusTarget } from "@/lib/focus";
import { MARKET_STATES } from "@/lib/order";
import { useSystem } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";

interface A { cls: "bad" | "warn" | "info"; title: string; body: string; act?: { label: string; run: () => void } }

/** Persistent demo banner + system banners. Each banner says what is wrong AND what the user can still do. */
export default function Banners() {
  const sys = useSystem();
  const { market } = useApp();
  const w = useWallet();
  const alerts: A[] = [];
  if (!DEPLOYED) alerts.push({ cls: "bad", title: "Contracts not deployed.", body: "Run the deploy script, then `pnpm sync` in frontend/ and restart." });
  if (sys.isError) alerts.push({ cls: "bad", title: "Cannot reach the chain.", body: `The node at ${RPC_URL} is not responding, so the numbers on screen may be out of date. Nothing you see is final until it is back. Check that the node is running.` });
  if (sys.data?.globalPaused) alerts.push({ cls: "bad", title: "The whole exchange is paused.", body: "New orders are blocked everywhere. You can still cancel orders and add collateral.", act: { label: "Show my orders", run: () => focusTarget("orders") } });
  const stale = (sys.data?.markets ?? []).filter((m) => !m.oracleOk);
  if (stale.length)
    alerts.push({ cls: "warn", title: `Degraded: the price feed is stale for ${stale.map((m) => MARKETS[m.id].name).join(", ")}${stale.some((m) => m.id === market) ? " (including the selected market)" : ""}.`, body: "With no fresh price, new orders are rejected and withdrawals are blocked while you hold a position in an affected market. You can still cancel orders and add collateral. Trading resumes after the next oracle update.", act: { label: "Show my orders", run: () => focusTarget("orders") } });
  for (const m of sys.data?.markets ?? []) {
    const name = MARKETS[m.id].name;
    const sel = m.id === market ? " (selected market)" : "";
    if (!m.oracleOk) continue;
    else if (m.state === 3) alerts.push({ cls: "bad", title: `${name} is paused${sel}.`, body: "New orders are blocked. You can still cancel orders and add collateral.", act: { label: "Show my orders", run: () => focusTarget("orders") } });
    else if (m.state === 1) alerts.push({ cls: "warn", title: `${name} is reduce-only${sel}.`, body: "You can only place orders that shrink an existing position. You can still close positions, cancel orders and add collateral.", act: { label: "Show positions", run: () => focusTarget("positions") } });
    else if (m.state === 2) alerts.push({ cls: "warn", title: `${name}: price feed degraded${sel}.`, body: "New orders are blocked until the oracle recovers. You can still cancel orders and add collateral." });
    else if (m.state === 5) alerts.push({ cls: "bad", title: `${name} is delisted${sel}.`, body: "The market is closed at its settlement price. No new orders; you can still cancel orders and withdraw free collateral." });
    else if (m.state === 4) alerts.push({ cls: "info", title: `${name} is recovering${sel}.`, body: `Market state: ${MARKET_STATES[m.state]}. Trading is limited until it returns to normal.` });
  }
  if (w.wrongChain) alerts.push({ cls: "warn", title: "Your wallet is on the wrong network.", body: "Switch to the exchange network before sending any transaction.", act: { label: "Switch network", run: () => void w.switchChain() } });
  return (
    <>
      <DemoBanner />
      {alerts.map((a, i) => (
        <div key={i} className={`alert ${a.cls}`} role="alert"><b>{a.title}</b><span>{a.body}</span>{a.act && <button className="btn sm" onClick={a.act.run}>{a.act.label}</button>}</div>
      ))}
    </>
  );
}
