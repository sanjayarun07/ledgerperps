"use client";
import { useEffect, useMemo, useState } from "react";
import { MARKETS } from "@/lib/config";
import { useApp } from "@/lib/app";
import { allowedActions } from "@/lib/marketRules";
import { focusTarget } from "@/lib/focus";
import { shortcutAction, SHORTCUTS } from "@/lib/terminal";
import { useWallet } from "@/lib/wallet";
import { useUi } from "@/components/ui";
import { useChainClock, useFunding, useHealth, useIndexerStatus, useSystem } from "@/lib/queries";
import { useTx } from "@/lib/tx";
import { INDEXER_URL } from "@/lib/config";
import { fmtDuration, fmtUsd } from "@/lib/units";
import { useBrand } from "@/brand/context";
import { NoticeLine } from "@/components/BrandBits";
import { Icon } from "@/components/Icon";

function Overlay({ title, onClose, children, label }: { title: string; onClose: () => void; children: React.ReactNode; label: string }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  return <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" aria-label={label}><h2>{title}</h2>{children}</div></div>;
}

/** Global key handler (see lib/terminal.ts for the pure map) + shortcut help overlay. */
export function Shortcuts() {
  const { setIsBuy, setOtab, setSidetab, setMtab } = useApp();
  const ui = useUi();
  const { features } = useBrand();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const a = shortcutAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, targetTag: t?.tagName, editable: !!t?.isContentEditable });
      if (!a) return;
      if (a === "palette") { if (!features.commandPalette) return; e.preventDefault(); ui.setDrawer(ui.drawer === "palette" ? null : "palette"); }
      else if (a === "escape") { if (ui.drawer) ui.setDrawer(null); }
      else if (ui.drawer === "palette") return;
      else if (a === "help") ui.setDrawer("shortcuts");
      else if (a === "buy" || a === "sell") { setSidetab("trade"); setMtab("trade"); setIsBuy(a === "buy"); }
      else if (a === "limit" || a === "market") { setSidetab("trade"); setMtab("trade"); setOtab(a); }
      else if (a === "focus-size") { e.preventDefault(); focusTarget("size"); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [ui, features.commandPalette, setIsBuy, setOtab, setSidetab, setMtab]);
  if (ui.drawer !== "shortcuts") return null;
  return (
    <Overlay title="Keyboard shortcuts" label="Keyboard shortcuts" onClose={() => ui.setDrawer(null)}>
      <table style={{ minWidth: 0 }}><tbody>{SHORTCUTS.map((s) => <tr key={s.keys}><td><kbd>{s.keys}</kbd></td><td>{s.label}</td></tr>)}</tbody></table>
      <p className="hint">Letter shortcuts are ignored while you type in a field.</p>
      <button className="btn brand" autoFocus onClick={() => ui.setDrawer(null)}>Close</button>
    </Overlay>
  );
}

interface Cmd { id: string; label: string; hint?: string; run: () => void }
export function CommandPalette() {
  const ui = useUi();
  const { setMarket, name } = useApp();
  const w = useWallet();
  const { markets, features, ticket } = useBrand();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const cmds = useMemo<Cmd[]>(() => [
    ...markets.map((m) => ({ id: `m${m.id}`, label: `Go to market ${m.name}`, hint: "Market", run: () => setMarket(m.id) })),
    { id: "dep", label: "Open deposit", hint: "Account", run: () => focusTarget("deposit") },
    { id: "wd", label: "Open withdraw", hint: "Account", run: () => focusTarget("withdraw") },
    { id: "pos", label: "Show positions", hint: "Portfolio", run: () => focusTarget("positions") },
    { id: "ord", label: "Show open orders", hint: "Portfolio", run: () => focusTarget("orders") },
    { id: "gl", label: "Open glossary", hint: "Learn", run: () => ui.openGlossary() },
    ...(features.tour ? [{ id: "tour", label: "Start the welcome tour", hint: "Learn", run: () => ui.setTour(true) }, { id: "gs", label: "Show the getting started checklist", hint: "Learn", run: () => ui.setWelcome(true) }] : []),
    { id: "act", label: "Open activity log", hint: "Account", run: () => ui.setDrawer("activity") },
    { id: "sc", label: "Show keyboard shortcuts", hint: "Help", run: () => ui.setDrawer("shortcuts") },
    { id: "th", label: `Switch to ${ui.theme === "dark" ? "light" : "dark"} theme`, hint: "View", run: () => ui.toggleTheme() },
    ...(w.address && ticket.subaccounts ? Array.from({ length: 8 }, (_, s) => ({ id: `s${s}`, label: `Switch to subaccount ${s}`, hint: "Account", run: () => w.setSub(s) })) : []),
  ], [ui, setMarket, w, markets, features.tour, ticket.subaccounts]);
  const items = cmds.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => { setI(0); }, [q]);
  useEffect(() => { if (ui.drawer !== "palette") setQ(""); }, [ui.drawer]);
  if (ui.drawer !== "palette" || !features.commandPalette) return null;
  const go = (c?: Cmd) => { if (!c) return; ui.setDrawer(null); setTimeout(c.run, 30); };
  return (
    <div className="modal pal" onMouseDown={(e) => { if (e.target === e.currentTarget) ui.setDrawer(null); }}>
      <div role="dialog" aria-modal="true" aria-label="Search and commands">
        <div className="inp"><input autoFocus role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={items[i] ? `pal-${items[i].id}` : undefined} aria-label="Search markets and actions" placeholder={`Type a command, e.g. deposit (now on ${name})`} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } else if (e.key === "Enter") go(items[i]); }} /></div>
        <ul id="pal-list" role="listbox" className="pal-list">
          {items.map((c, n) => <li key={c.id} id={`pal-${c.id}`} role="option" aria-selected={n === i} className={n === i ? "on" : ""} onMouseEnter={() => setI(n)} onClick={() => go(c)}><span>{c.label}</span><small className="mute">{c.hint}</small></li>)}
          {!items.length && <li className="mute" style={{ padding: 8 }}>No match. Try &quot;market&quot;, &quot;deposit&quot; or &quot;glossary&quot;.</li>}
        </ul>
      </div>
    </div>
  );
}

/** Chain status popover: block, chain clock, oracle freshness and the permissionless "update funding" action live here, not in the stat strip. */
function ChainStatus({ tone, text, onClose }: { tone: string; text: string; onClose: () => void }) {
  const { market } = useApp();
  const sys = useSystem().data;
  const fund = useFunding(market);
  const clock = useChainClock();
  const w = useWallet();
  const { send } = useTx();
  const m = MARKETS[market];
  const next = fund.data ? fund.data.lastFunding + fund.data.interval : 0;
  const due = !!fund.data && next <= clock.now;
  const ms = sys?.markets.find((x) => x.id === market);
  const health = useHealth().data;
  const usd = (v: bigint | null | undefined) => (v === null || v === undefined ? "-" : `${fmtUsd(v)} USDC`);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="statuspop" role="dialog" aria-label="Chain status">
      <div className="kv"><span>Connection</span><span><i className={`dot ${tone}`} aria-hidden /> {text}</span></div>
      <div className="kv"><span>Latest block</span><span className="num">{sys ? sys.blockNumber.toString() : "-"}</span></div>
      <div className="kv"><span>Chain clock</span><span className="num">{clock.block !== null ? new Date(clock.now * 1000).toLocaleTimeString() : "-"}</span></div>
      <div className="kv"><span>{m.name} price feed</span><span>{ms ? (ms.oracleOk ? "Fresh" : "Stale") : "-"}</span></div>
      <div className="kv"><span>Unresolved bad debt</span><span className={`num ${health && health.unresolvedBadDebt > 0n ? "short" : ""}`}>{usd(health?.unresolvedBadDebt)}</span></div>
      <div className="kv"><span>Backstop equity</span><span className={`num ${health?.backstopEquity !== null && health?.backstopEquity !== undefined && health.backstopEquity < 0n ? "short" : ""}`}>{usd(health?.backstopEquity)}</span></div>
      <div className="kv"><span>Withdrawal limit</span><span>{health?.gateActive === null || health === undefined ? "-" : health.gateActive ? "Active (up to deposited amount)" : "Off"}</span></div>
      <div className="kv"><span>Next funding</span><span className="num">{fund.data ? (due ? "due now" : fmtDuration(next - clock.now)) : "-"}</span></div>
      <button id="poke-btn" className={`btn sm ${due ? "brand" : ""}`} disabled={!w.address || w.wrongChain} onClick={() => send({ label: `Update funding on ${m.name}`, functionName: "pokeFunding", args: [market] })}>Update funding on {m.name}</button>
      <p className="hint" style={{ margin: 0 }}>Anyone can trigger the funding update once the interval has passed.{!w.address ? " Connect a wallet to do it." : ""}</p>
    </div>
  );
}

export function Footer() {
  const { brand, features } = useBrand();
  const sys = useSystem();
  const ui = useUi();
  const ix = useIndexerStatus().data;
  const health = useHealth().data;
  const [open, setOpen] = useState(false);
  const app = useApp();
  const sm = sys.data?.markets.find((x) => x.id === app.market);
  const rules = sys.data ? allowedActions({ state: sm?.state ?? 0, globalPaused: sys.data.globalPaused, oracleOk: sm?.oracleOk, name: MARKETS[app.market]?.name }) : null;
  const tradeText = !rules ? "Trading: unknown" : rules.open ? "Trading: open" : rules.reduce ? "Trading: reduce only" : "Trading: paused (cancel only)";
  let tone: "ok" | "warn" | "bad" = "ok", text = "Connected";
  if (sys.isError) { tone = "bad"; text = "Chain unreachable"; }
  else if (INDEXER_URL && ix && !ix.ok) { tone = "warn"; text = "Indexer down - using chain"; }
  else if (INDEXER_URL && ix && !ix.synced) { tone = "warn"; text = "Indexer behind - chain is authoritative"; }
  else if (!INDEXER_URL) text = "Connected (chain only)";
  return (
    <footer className="foot" aria-label="Status bar">
      <button type="button" className="status" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><i className={`dot ${tone}`} aria-hidden />{text}{sys.data ? <span className="num mute">block {sys.data.blockNumber.toString()}</span> : null}<span className="sr"> (open chain status)</span></button>
      {open && <ChainStatus tone={tone} text={text} onClose={() => setOpen(false)} />}
      {health && (health.unresolvedBadDebt > 0n || (health.backstopEquity !== null && health.backstopEquity < 0n)) && <span className="tradestate restricted" title="Losses exceeded the insurance fund. See the status popover and Account > Solvency." data-testid="baddebt-indicator"><Icon name="alert" size={12} />{health.gateActive ? "Bad debt: withdrawals limited" : "Bad debt outstanding"}</span>}
      <span className={`tradestate ${rules?.open ? "" : "restricted"}`} title={rules?.notice ?? "New orders are accepted in this market."}>{rules && !rules.open ? <Icon name="alert" size={12} /> : null}{tradeText}</span>
      <div className="sp" />
      {[["Support", brand.links.support], ["Docs", brand.links.docs], ["Status", brand.links.status], ["Terms", brand.links.terms], ["Privacy", brand.links.privacy], ...brand.social.map((x) => [x.label, x.url] as const)].filter(([, u]) => u).map(([l, u]) => <a key={l} className="navlink" href={u} target="_blank" rel="noreferrer noopener">{l}</a>)}
      {features.tour && <button type="button" className="navlink" onClick={() => ui.setWelcome(true)}>Getting started</button>}
      <button type="button" className="navlink" onClick={() => ui.setDrawer("shortcuts")} aria-label="Keyboard shortcuts">Shortcuts <kbd>?</kbd></button>
      <NoticeLine />
    </footer>
  );
}
