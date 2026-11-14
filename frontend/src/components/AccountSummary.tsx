"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { useAccountState } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { fmtUsd } from "@/lib/units";
import { useUi, Tip, Val } from "@/components/ui";
import { healthState } from "@/lib/risk";
import { focusTarget } from "@/lib/focus";

/** Account overview card: equity, available margin, maintenance requirement, withdrawable, margin usage. Deposit and Withdraw open the account drawer. */
export default function AccountSummary() {
  const w = useWallet();
  const ui = useUi();
  // below 940px of height the card starts collapsed (equity, available and the usage bar stay visible); the choice is remembered
  const [open, setOpen] = useState(true);
  useEffect(() => { try { const v = localStorage.getItem("terminal.acct.open"); setOpen(v !== null ? v === "1" : window.innerHeight >= 940); } catch { /* ignore */ } }, []);
  const toggle = () => { setOpen((o) => { try { localStorage.setItem("terminal.acct.open", o ? "0" : "1"); } catch { /* ignore */ } return !o; }); };
  const acct = useAccountState(w.acct).data;
  const used = acct && acct.equity > 0n ? Math.min(100, Math.max(0, Number(((acct.im + acct.resv) * 10000n) / acct.equity) / 100)) : 0;
  const h = acct ? healthState(acct.equity, acct.mm) : null;
  if (!w.address) return (
    <section className="panel acct-card" aria-label="Account overview">
      <h3>Account overview</h3>
      <p className="hint" style={{ margin: 0 }}>Connect a wallet to see your equity, available margin and maintenance requirement.</p>
    </section>
  );
  return (
    <section className="panel acct-card" aria-label="Account overview" data-open={open ? "1" : "0"}>
      <h3><span className="row auto">Account overview {h && <span className={`state-tag ${h.key}`}>{h.key === "safe" ? <Icon name="check" size={11} /> : <Icon name="alert" size={11} />}{h.label}</span>}</span><button type="button" className="x acct-toggle" aria-expanded={open} aria-label={open ? "Collapse account overview" : "Expand account overview"} onClick={toggle}><Icon name="chevron" size={14} /></button></h3>
      <div className="acct-pair">
        <div><span className="lbl"><Tip k="equity">Equity</Tip></span><span className="num big"><Val v={acct && fmtUsd(acct.equity)} w={80} /><small> USDC</small></span></div>
        <div><span className="lbl"><Tip k="available">Available</Tip></span><span className="num big"><Val v={acct && fmtUsd(acct.avail)} w={80} /><small> USDC</small></span></div>
      </div>
      <details className="more rowsum acct-more">
        <summary><span>Margin usage</span><span className="num">{acct ? `${used.toFixed(1)}%` : "-"}</span><Icon name="chevron" size={12} /></summary>
        <div className="kvl">
          <div className="kv"><span><Tip k="mm">Maintenance requirement</Tip></span><span className="num"><Val v={acct && fmtUsd(acct.mm)} /> USDC</span></div>
          <div className="kv"><span><Tip k="withdrawable">Withdrawable</Tip></span><span className="num"><Val v={acct && fmtUsd(acct.withdrawable)} /> USDC</span></div>
        </div>
      </details>
      <div className="usage" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)} aria-label="Margin usage"><i style={{ width: `${used}%` }} /></div>
      <div className="acct-actions acct-more">
        <button className="btn brand" onClick={() => { ui.setDrawer("account"); setTimeout(() => focusTarget("deposit"), 120); }}>Deposit</button>
        <button className="btn" onClick={() => { ui.setDrawer("account"); setTimeout(() => focusTarget("withdraw"), 120); }}>Withdraw</button>
      </div>
    </section>
  );
}
