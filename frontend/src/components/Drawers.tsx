"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";
import { useTx } from "@/lib/tx";
import { TxBody, stateText } from "@/components/Toasts";
import { useUi } from "@/components/ui";
import { useBrand } from "@/brand/context";
import AccountPanel from "@/components/AccountPanel";

function Dialog({ title, onClose, children, modal }: { title: string; onClose: () => void; children: ReactNode; modal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !ref.current) return; // keep focus inside the dialog
      const f = [...ref.current.querySelectorAll<HTMLElement>("button, input, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !x.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className={modal ? "modal" : "drawer-back"} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={modal ? undefined : "drawer"} role="dialog" aria-modal="true" aria-label={title}>{children}</div>
    </div>
  );
}

export function GlossaryDrawer() {
  const { drawer, setDrawer, glossaryFocus } = useUi();
  const [q, setQ] = useState("");
  useEffect(() => { if (drawer === "glossary" && glossaryFocus) setTimeout(() => document.getElementById(`gl-${glossaryFocus}`)?.scrollIntoView({ block: "center" }), 50); }, [drawer, glossaryFocus]);
  if (drawer !== "glossary") return null;
  const items = (Object.keys(GLOSSARY) as GlossaryKey[]).filter((k) => `${GLOSSARY[k].term} ${GLOSSARY[k].def}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog title="Glossary" onClose={() => setDrawer(null)}>
      <h2>Glossary <button className="btn sm" data-autofocus onClick={() => setDrawer(null)}>Close</button></h2>
      <div className="inp"><input aria-label="Search the glossary" style={{ textAlign: "left" }} placeholder="Search terms, e.g. margin" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <dl className="gl">
        {items.map((k) => <div key={k} id={`gl-${k}`} style={k === glossaryFocus ? { background: "var(--info-bg)", borderRadius: 8, padding: "0 8px" } : undefined}><dt>{GLOSSARY[k].term}</dt><dd>{GLOSSARY[k].def}</dd></div>)}
        {!items.length && <p className="empty">No term matches &quot;{q}&quot;.</p>}
      </dl>
      <p className="hint" style={{ marginTop: 16 }}>Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer noopener" style={{ color: "var(--brand)" }}>TradingView</a> Lightweight Charts.</p>
    </Dialog>
  );
}

export function ActivityDrawer() {
  const { drawer, setDrawer } = useUi();
  const { txs, clear } = useTx();
  if (drawer !== "activity") return null;
  return (
    <Dialog title="Activity log" onClose={() => setDrawer(null)}>
      <h2>Activity <span className="row" style={{ flex: "none" }}><button className="btn sm" onClick={clear} disabled={!txs.length}>Clear</button><button className="btn sm" data-autofocus onClick={() => setDrawer(null)}>Close</button></span></h2>
      <p className="hint">Every action moves through: Waiting for wallet, Sent, Included in block, Confirmed on-chain (or Failed). Only &quot;Confirmed on-chain&quot; means it worked.</p>
      {!txs.length && <div className="empty"><b>Nothing yet</b><p>Your deposits, orders and cancellations will be listed here with their final result.</p></div>}
      {txs.map((t) => (
        <div className="logitem" key={t.id}>
          <b>{t.label}</b><br /><small className="mute">{new Date(t.at).toLocaleTimeString()} · {stateText(t)} · {t.signer}</small>
          <TxBody t={t} />
        </div>
      ))}
    </Dialog>
  );
}

const SLIDES = (name: string, title?: string, body?: string) => [
  { h: title ?? `Welcome to ${name}`, p: body ?? "This is a practice exchange for perpetual futures (\"perps\"): contracts that follow a price, like BTC, with no expiry. Everything here uses mock money on a local chain, so you can learn without risk." },
  { h: "Six steps, in order", p: "Connect a wallet, fund your account with USDC, choose a market, place a trade, manage your positions, and withdraw when you are done. The strip at the top always shows where you are and what to do next." },
  { h: "Simple first, advanced when you want it", p: "The order ticket starts with just side, size and leverage. Order types, post-only, reduce-only, take-profit and stop-loss, TWAP, isolated margin, session keys and signed orders sit under \"Advanced\". Tap the small i icons for plain-language help, or open the glossary." },
  { h: "Know the risks", p: "Leverage multiplies losses as well as gains. Watch the account health meter: if it reaches Liquidatable your positions can be closed by force. Nothing is shown as done until it is Confirmed on-chain." },
];
const KEY = "terminal.tour.done";
export function Tour() {
  const { tour, setTour } = useUi();
  const [i, setI] = useState(0);
  const { brand, features } = useBrand();
  const SL = SLIDES(brand.name, brand.copy.welcomeTitle, brand.copy.welcomeBody);
  if (!tour || !features.tour) return null;
  const end = () => { try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ } setTour(false); setI(0); };
  const s = SL[i];
  return (
    <Dialog title="Welcome tour" modal onClose={end}>
      <h2>{s.h}</h2><p>{s.p}</p>
      <div className="dots" aria-hidden>{SL.map((_, k) => <i key={k} className={k <= i ? "on" : ""} />)}</div>
      <div className="row">
        <button className="btn ghost" onClick={end}>Skip tour</button>
        {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Back</button>}
        {i < SL.length - 1 ? <button className="btn brand" data-autofocus onClick={() => setI(i + 1)}>Next ({i + 1}/{SL.length})</button> : <button className="btn brand" data-autofocus onClick={end}>Start trading</button>}
      </div>
    </Dialog>
  );
}

/** Full account controls (deposit, withdraw, margin mode, transfers, session keys, safety) in a right-hand drawer, so the terminal keeps a compact account card. */
export function AccountDrawer() {
  const { drawer, setDrawer } = useUi();
  if (drawer !== "account") return null;
  return (
    <Dialog title="Account and security" onClose={() => setDrawer(null)}>
      <h2>Account and security <button className="btn sm" data-autofocus onClick={() => setDrawer(null)}>Close</button></h2>
      <AccountPanel />
    </Dialog>
  );
}
