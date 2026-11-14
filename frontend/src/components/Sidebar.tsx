"use client";
import { useEffect, useState } from "react";
import { useApp, type View } from "@/lib/app";
import { useBrand } from "@/brand/context";
import { useNotifications } from "@/lib/notifications";
import { useTx } from "@/lib/tx";
import { Icon } from "@/components/Icon";

const META: Record<string, [string, string]> = { trade: ["Trade", "trade"], markets: ["Markets", "markets"], portfolio: ["Portfolio", "portfolio"], activity: ["Activity", "activity"] };

/** Left navigation rail (desktop). Collapses to icons; the choice is remembered. Below 1024px the header tabs and the mobile bottom bar take over. */
export default function Sidebar() {
  const { view, setView, setMtab, mtab } = useApp();
  const { nav } = useBrand();
  const { txs } = useTx();
  const { unread } = useNotifications();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { try { const v = localStorage.getItem("terminal.sidebar"); setCollapsed(v !== null ? v === "1" : window.innerWidth < 1600); } catch { /* ignore */ } }, []);
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem("terminal.sidebar", c ? "0" : "1"); } catch { /* ignore */ } return !c; });
  const pending = txs.filter((t) => t.state === "signing" || t.state === "submitted" || t.state === "included").length;
  const go = (v: View) => { setView(v); setMtab(v === "trade" ? "chart" : mtab); };
  return (
    <aside className="sidebar" data-collapsed={collapsed ? "1" : "0"} aria-label="Sections">
      <nav>
        {nav.map((n) => (
          <button key={n} type="button" className={`sb-item ${view === n ? "on" : ""}`} aria-current={view === n ? "page" : undefined} title={META[n][0]} onClick={() => go(n)}>
            <Icon name={META[n][1]} size={16} /><span className="sb-label">{META[n][0]}</span>
            {n === "activity" && (pending || unread) ? <i className="badge" aria-label={`${pending || unread} waiting`}>{pending || unread}</i> : null}
          </button>
        ))}
      </nav>
      <button type="button" className="sb-item sb-collapse" aria-expanded={!collapsed} onClick={toggle} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}><Icon name="collapse" size={16} /><span className="sb-label">Collapse</span></button>
    </aside>
  );
}
