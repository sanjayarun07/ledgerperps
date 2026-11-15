"use client";
import { useEffect, useRef, useState } from "react";
import { generatePrivateKey } from "viem/accounts";
import { useUi } from "@/components/ui";
import { IS_LOCAL } from "@/lib/config";
import { shortAddr } from "@/lib/units";
import { useWallet } from "@/lib/wallet";
import { useApp, type View } from "@/lib/app";
import { useBrand } from "@/brand/context";
import { Wordmark } from "@/components/BrandBits";
import { useTx } from "@/lib/tx";
import { useNotifications } from "@/lib/notifications";
import { Icon } from "@/components/Icon";
import GettingStarted from "@/components/Guide";

const LABEL: Record<string, string> = { trade: "Trade", markets: "Markets", portfolio: "Portfolio", activity: "Activity" };

/** Click outside / Escape closes a popover. */
function usePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  return { open, setOpen, ref };
}

/** One 48px bar: wordmark, underline tabs, Deposit (the one primary action) and the wallet pill. Everything else lives in the menus. */
export default function Header() {
  const w = useWallet();
  const ui = useUi();
  const app = useApp();
  const { nav, features, ticket, brand } = useBrand();
  const { txs } = useTx();
  const { unread } = useNotifications();
  const wallet = usePop();
  const more = usePop();
  const pending = txs.filter((t) => t.state === "signing" || t.state === "submitted" || t.state === "included").length;
  const go = (v: View) => { app.setView(v); app.setMtab(v === "trade" ? "chart" : app.mtab); };
  return (
    <header className="hdr">
      <Wordmark />
      <nav className="topnav" aria-label="Sections (compact)">
        {nav.map((n) => (
          <button key={n} type="button" className={`navtab ${app.view === n ? "on" : ""}`} aria-current={app.view === n ? "page" : undefined} onClick={() => go(n)}>
            {LABEL[n]}{n === "activity" && pending ? <span className="badge" aria-label={`${pending} in progress`}>{pending}</span> : null}
          </button>
        ))}
      </nav>
      <div className="sp" />
      <div className="hdr-actions">
        {features.tour && <GettingStarted />}
        <button type="button" className="icon-btn" aria-label={`Switch to ${ui.theme === "dark" ? "light" : "dark"} theme`} title="Theme" onClick={ui.toggleTheme}><Icon name={ui.theme === "dark" ? "sun" : "moon"} /></button>
        {w.address ? (
          <>
            <button className="btn brand" onClick={() => ui.setDrawer("account")}>Deposit</button>
            <div className="popwrap" ref={wallet.ref}>
              <button className="pill-btn" aria-haspopup="menu" aria-expanded={wallet.open} onClick={() => wallet.setOpen(!wallet.open)} title={w.address}>
                <span className="avatar" aria-hidden />
                <span className="num">{shortAddr(w.address)}</span><Icon name="chevron" size={14} />
              </button>
              {wallet.open && (
                <div className="menu" role="menu">
                  {w.mode === "burner" && <p className="hint" style={{ margin: "0 0 8px" }}><span className="chip dev">Dev burner (mock)</span><br />Keys live in this browser. Dev only.</p>}
                  {w.mode === "privy" && <p className="hint" style={{ margin: "0 0 8px" }}>Signed in as {w.email ?? "email"}<br />{w.mfaEnrolled ? "Two-step verification is on." : "Two-step verification is off."}</p>}
                  {w.mode === "privy" && !w.mfaEnrolled && w.enrollMfa && <button role="menuitem" className="menu-item" onClick={() => { wallet.setOpen(false); w.enrollMfa?.(); }}>Turn on two-step verification</button>}
                  {ticket.subaccounts && <label className="menu-row">Subaccount
                    <span className="inp" style={{ width: 64, minHeight: 32 }}><select value={w.sub} onChange={(e) => w.setSub(Number(e.target.value))} aria-label="Subaccount">{Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></span>
                  </label>}
                  <CopyAddress address={w.address} />
                  <button role="menuitem" className="menu-item" onClick={() => { wallet.setOpen(false); ui.setDrawer("account"); }}>Account and security</button>
                  <button role="menuitem" className="menu-item" onClick={() => { wallet.setOpen(false); app.setView("notifications"); }}>Notifications{unread ? <span className="badge">{unread}</span> : null}</button>
                  <button role="menuitem" className="menu-item" onClick={() => { wallet.setOpen(false); w.disconnect(); }}>Disconnect</button>
                </div>
              )}
            </div>
          </>
        ) : (
          <ConnectButton />
        )}
        <div className="popwrap" ref={more.ref}>
          <button className="icon-btn" aria-label="More: search, help, theme" aria-haspopup="menu" aria-expanded={more.open} onClick={() => more.setOpen(!more.open)} id="palette-btn"><Icon name="more" /></button>
          {more.open && (
            <div className="menu" role="menu">
              {features.commandPalette && <button role="menuitem" className="menu-item" onClick={() => { more.setOpen(false); ui.setDrawer("palette"); }}>Search and commands <kbd>Ctrl K</kbd></button>}
              <button role="menuitem" className="menu-item" onClick={() => { more.setOpen(false); ui.openGlossary(); }}>Help and glossary</button>
              <button role="menuitem" className="menu-item" onClick={() => { more.setOpen(false); ui.setDrawer("shortcuts"); }}>Keyboard shortcuts <kbd>?</kbd></button>
              <button role="menuitem" className="menu-item" onClick={() => { more.setOpen(false); ui.setDrawer("activity"); }}>Activity log{pending ? ` (${pending} in progress)` : ""}</button>
              <button role="menuitem" className="menu-item" onClick={() => { ui.toggleTheme(); more.setOpen(false); }}>Switch to {ui.theme === "dark" ? "light" : "dark"} theme</button>
              {brand.links.docs && <a role="menuitem" className="menu-item" href={brand.links.docs} target="_blank" rel="noreferrer noopener">Docs</a>}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/** Shows the full address and copies it. Works for every wallet type (the email wallet has no extension to copy from). */
function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch {
      // clipboard blocked: select the text so Ctrl/Cmd+C works
      const el = document.getElementById("wallet-addr-full"); if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r); }
    }
  };
  return (
    <div style={{ padding: "4px var(--s3) 8px" }}>
      <div className="hint" style={{ margin: 0 }}>Your wallet address</div>
      <code id="wallet-addr-full" style={{ display: "block", fontSize: 11, wordBreak: "break-all", userSelect: "all", margin: "2px 0 6px" }}>{address}</code>
      <button type="button" role="menuitem" className="btn sm" onClick={() => void copy()} aria-live="polite">{copied ? "Copied" : "Copy address"}</button>
    </div>
  );
}

function ConnectButton() {
  const w = useWallet();
  const pop = usePop();
  return (
    <div className="popwrap" ref={pop.ref}>
      <button className="btn brand" id="connect-btn" onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open} aria-haspopup="true">Connect wallet</button>
      {pop.open && (
        <div className="menu wide" role="menu">
          {w.connectEmail && <button className="btn full" role="menuitem" onClick={() => { w.connectEmail?.(); pop.setOpen(false); }}>Sign in with email</button>}
          <button className="btn full" role="menuitem" onClick={() => { w.connectInjected(); pop.setOpen(false); }}>Browser wallet (injected)</button>
          {w.connectError && <p className="errs" role="alert">{w.connectError}</p>}
          {w.burnerAllowed && (
            <>
              <h4 style={{ margin: "12px 0 4px", fontSize: 12, color: "var(--mute)" }}>Dev accounts (local demo only)</h4>
              <p className="hint">These use the public Hardhat test mnemonic or a random key stored in this browser. They hold mock money. Never use them on a real network.</p>
              <div className="row wrap">
                {[0, 1, 2, 3, 4].map((i) => <button key={i} role="menuitem" className="btn sm" onClick={() => { w.connectBurner({ kind: "hardhat", index: i }); pop.setOpen(false); }}>Hardhat #{i}</button>)}
                <button className="btn sm" role="menuitem" onClick={() => { w.connectBurner({ kind: "random", pk: generatePrivateKey() }); pop.setOpen(false); }}>Random key</button>
              </div>
              {IS_LOCAL && <p className="hint">Hardhat accounts come with gas; a random key does not.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
