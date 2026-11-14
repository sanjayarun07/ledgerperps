"use client";
import dynamic from "next/dynamic";
import { useEffect, useState, type CSSProperties } from "react";
import AccountSummary from "@/components/AccountSummary";
import Banners from "@/components/Banners";
import BookPanel from "@/components/BookPanel";
import Header from "@/components/Header";
import IndexerLive from "@/components/IndexerLive";
import MarketBar from "@/components/MarketBar";
import MarketStrip from "@/components/MarketStrip";
import Sidebar from "@/components/Sidebar";
import MarketInfo from "@/components/MarketInfo";
import NotificationFeed from "@/components/NotificationFeed";
import PortfolioTabs from "@/components/PortfolioTabs";
import Splitter from "@/components/Splitter";
import Ticket from "@/components/Ticket";
import Toasts from "@/components/Toasts";
import { ActivityView, MarketsView, NotificationsView, PortfolioView } from "@/components/Views";
import { CommandPalette, Footer, Shortcuts } from "@/components/Terminal";
import { AccountDrawer, ActivityDrawer, GlossaryDrawer, Tour } from "@/components/Drawers";
import { useApp, type View } from "@/lib/app";
import { DEFAULT_LAYOUT, LIMITS, clampLayout, loadLayout, saveLayout, type Layout } from "@/lib/layout";
import { useNotifications } from "@/lib/notifications";
import { Icon, Tri } from "@/components/Icon";

const Chart = dynamic(() => import("@/components/Chart"), { ssr: false, loading: () => <div className="panel chart-ph" role="status"><span className="skel" style={{ width: "60%", height: 160 }} aria-hidden /><span className="sr">Loading chart</span></div> });

const NAV: [View, string, string][] = [["trade", "Trade", "trade"], ["markets", "Markets", "markets"], ["portfolio", "Portfolio", "portfolio"], ["activity", "Activity", "activity"]];

function MobileNav() {
  const { view, setView } = useApp();
  const { unread } = useNotifications();
  return (
    <nav className="mnav" aria-label="Main">
      {NAV.map(([k, l, g]) => <button key={k} className={view === k ? "on" : ""} aria-current={view === k ? "page" : undefined} onClick={() => setView(k)}><Icon name={g} size={20} />{l}{k === "activity" && unread ? <i className="badge" aria-label={`${unread} unread`}>{unread}</i> : null}</button>)}
    </nav>
  );
}

export default function Page() {
  const { view, setIsBuy, sheet, setSheet, ctab, mkt, setMkt } = useApp();
  const [lay, setLay] = useState<Layout>(DEFAULT_LAYOUT);
  useEffect(() => { setLay(clampLayout(loadLayout(), window.innerWidth, window.innerHeight)); }, []);
  const set = (k: keyof Layout) => (n: number) => setLay((l) => { const v = clampLayout({ ...l, [k]: n }, window.innerWidth, window.innerHeight); saveLayout(v); return v; });
  const style = { "--book-w": `${lay.book}px`, "--side-w": `${lay.side}px`, "--dock-h": `${lay.dock}px` } as CSSProperties;
  const quick = (buy: boolean) => { setIsBuy(buy); setSheet(true); };
  useEffect(() => { document.body.dataset.sheet = sheet ? "1" : ""; }, [sheet]);
  return (
    <div className="shell term" data-view={view}>
      <Banners />
      <Header />
      <IndexerLive />
      <div className="stage"><Sidebar /><div className="stage-main">
      <div className="tview" hidden={view !== "trade"}>
        <main className="grid" id={view === "trade" ? "main" : undefined} data-ctab={ctab} data-mkt={mkt} data-sheet={sheet ? "1" : "0"} style={style}>
          <section className="g-strip" aria-label="Markets"><MarketStrip /></section>
          <section className="g-pair"><MarketBar /></section>
          <section className="g-chart" aria-label="Chart"><Chart /></section>
          <Splitter area="vs1" orient="v" value={lay.book} min={LIMITS.book[0]} max={LIMITS.book[1]} onChange={set("book")} reset={DEFAULT_LAYOUT.book} label="Resize order book" />
          <div className="mkt-tabs only-m" role="tablist" aria-label="Market data">
            {(["book", "trades", "info"] as const).map((k) => <button key={k} role="tab" aria-selected={mkt === k} className={mkt === k ? "on" : ""} onClick={() => setMkt(k)}>{k === "book" ? "Book" : k === "trades" ? "Trades" : "Info"}</button>)}
          </div>
          <section className="g-book" aria-label="Order book and trades">{mkt === "info" ? <MarketInfo /> : <BookPanel />}</section>
          <Splitter area="vs2" orient="v" value={lay.side} min={LIMITS.side[0]} max={LIMITS.side[1]} onChange={set("side")} reset={DEFAULT_LAYOUT.side} label="Resize order ticket" />
          <Splitter area="hs" orient="h" value={lay.dock} min={LIMITS.dock[0]} max={LIMITS.dock[1]} onChange={set("dock")} reset={DEFAULT_LAYOUT.dock} label="Resize positions panel" />
          <section className="g-tabs" aria-label="Positions and orders"><PortfolioTabs /></section>
          <section className="g-side" aria-label="Order ticket and account">
            <div className="sheet-head only-m"><b>Place order</b><button className="btn sm" onClick={() => setSheet(false)}>Close</button></div>
            <div className="sidepane"><Ticket /></div>
            <div className="acctwrap"><AccountSummary /></div>
          </section>
        </main>
        <div className="mbottom" role="group" aria-label="Quick trade">
          <button className="btn buy" onClick={() => quick(true)}><Tri up />Long</button>
          <button className="btn sell" onClick={() => quick(false)}><Tri up={false} />Short</button>
        </div>
      </div>
      {view === "markets" && <MarketsView />}
      {view === "portfolio" && <PortfolioView />}
      {view === "activity" && <ActivityView />}
      {view === "notifications" && <NotificationsView />}
      </div></div>
      <Footer />
      <MobileNav />
      <NotificationFeed />
      <Toasts />
      <GlossaryDrawer />
      <ActivityDrawer />
      <AccountDrawer />
      <Tour />
      <CommandPalette />
      <Shortcuts />
    </div>
  );
}
