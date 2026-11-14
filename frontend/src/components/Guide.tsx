"use client";
import { useApp } from "@/lib/app";
import { IS_LOCAL } from "@/lib/config";
import { focusTarget } from "@/lib/focus";
import { useAccountState, useOpenOrders, usePositions, useUsdc, useUserFills } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useUi } from "@/components/ui";
import { useBrand } from "@/brand/context";

const STEPS = ["Connect a wallet", "Fund your account", "Choose a market", "Place a trade", "Manage it", "Withdraw"] as const;

/** Persistent "what do I do next" guide: derives the current step from real account state, never from clicks alone. */
export function useGuide() {
  const w = useWallet();
  const { touched } = useApp();
  const acct = useAccountState(w.acct).data;
  const usdc = useUsdc(w.address).data;
  const pos = (usePositions(w.acct).data ?? []).filter((p) => p.size !== 0n);
  const orders = useOpenOrders(w.acct).data ?? [];
  const fills = useUserFills(w.acct).data ?? [];

  const connected = !!w.address;
  const funded = !!acct && acct.collateral > 0n;
  const traded = pos.length > 0 || orders.length > 0 || fills.length > 0;
  const managing = pos.length > 0 || orders.length > 0;
  const chosen = funded && (touched || traded);
  let cur = 0;
  if (connected) cur = 1;
  if (funded) cur = 2;
  if (chosen) cur = 3;
  if (traded) cur = managing ? 4 : 5;
  const done = [connected, funded, chosen, traded, traded && !managing, false];

  let text: React.ReactNode, cta: { label: string; run: () => void } | null = null;
  switch (cur) {
    case 0: text = <><b>Next:</b> {IS_LOCAL ? "pick a dev account from Connect wallet. It holds mock money only." : "connect your wallet. It signs every action; we never hold your keys."}</>; cta = { label: "Connect wallet", run: () => document.getElementById("connect-btn")?.click() }; break;
    case 1: text = <><b>Next:</b> {usdc && usdc.bal === 0n && IS_LOCAL ? "mint mock USDC, then deposit it." : "deposit USDC as collateral."} It backs your trades and stays yours to withdraw.</>; cta = { label: "Deposit USDC", run: () => focusTarget("deposit") }; break;
    case 2: text = <><b>Next:</b> pick a market above, check its price and funding, then enter a size.</>; cta = { label: "Enter a size", run: () => focusTarget("size") }; break;
    case 3: text = <><b>Next:</b> enter a size, read the preview (cost, fee, liquidation price), then press Buy or Sell. Start small.</>; cta = { label: "Enter a size", run: () => focusTarget("size") }; break;
    case 4: text = <><b>Next:</b> keep an eye on account health. Close at market, cancel orders, or add a take-profit and stop-loss.</>; cta = { label: pos.length ? "Show positions" : "Show open orders", run: () => focusTarget(pos.length ? "positions" : "orders") }; break;
    default: text = <><b>Next:</b> everything is closed. Withdraw your free collateral, or place another trade.</>; cta = { label: "Withdraw USDC", run: () => focusTarget("withdraw") };
  }
  return { cur, done, text, cta, usdc };
}

const KEY = "terminal.tour.done";

/** "Getting started" lives in the header: a chip with progress that opens a popover. It never covers the chart or the dock, and the chip
 *  is highlighted (not auto-opened) on a first visit. Also reachable from the footer, the Help menu and the command palette. */
export default function GettingStarted() {
  const { cur, done, text, cta } = useGuide();
  const { welcome, setWelcome, setTour } = useUi();
  const { brand } = useBrand();
  const [fresh, setFresh] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { try { setFresh(!localStorage.getItem(KEY)); } catch { /* storage unavailable */ } }, []);
  useEffect(() => {
    if (!welcome) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setWelcome(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setWelcome(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [welcome, setWelcome]);
  const close = () => { try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ } setFresh(false); setWelcome(false); };
  const n = done.filter(Boolean).length;
  return (
    <div className="popwrap hide-m" ref={ref}>
      <button type="button" className={`gschip ${fresh ? "new" : ""}`} aria-haspopup="dialog" aria-expanded={welcome} onClick={() => (welcome ? close() : setWelcome(true))}>
        <Icon name="check" size={14} /><span>Getting started</span><span className="prog num">{n}/{STEPS.length}</span>
      </button>
      {welcome && (
        <aside className="welcome" role="dialog" aria-label="Getting started">
          <button className="x" aria-label="Close getting started" onClick={close}><Icon name="x" size={14} /></button>
          <b className="ttl">{brand.copy.welcomeTitle ?? "Getting started"}</b>
          <div className="gs-bar" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={n} aria-label={`${n} of ${STEPS.length} steps done`}><i style={{ width: `${(n / STEPS.length) * 100}%` }} /></div>
          <ol className="gs-list">
            {STEPS.map((s, i) => (
              <li key={s} className={i === cur ? "cur" : done[i] ? "done" : ""} aria-current={i === cur ? "step" : undefined}>
                <span className="n" aria-hidden>{done[i] && i !== cur ? <Icon name="check" size={10} /> : null}</span><span>{s}</span>{done[i] && i !== cur && <span className="sr"> (done)</span>}
              </li>
            ))}
          </ol>
          <p role="status">{text}</p>
          <div className="row auto">
            {cta && <button className="btn brand sm" onClick={() => { cta.run(); setWelcome(false); }}>{cta.label}</button>}
            <button className="btn sm ghost" onClick={() => { setTour(true); close(); }}>Take the tour</button>
          </div>
        </aside>
      )}
    </div>
  );
}
