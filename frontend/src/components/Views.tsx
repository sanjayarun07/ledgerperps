"use client";
import { useBrand } from "@/brand/context";
import { useApp } from "@/lib/app";
import { MARKETS } from "@/lib/config";
import { useFunding, useMark, useMarketInfo, useStats24h, useSystem, useAccountState, useLedger, useSolvency } from "@/lib/queries";
import { allowedActions } from "@/lib/marketRules";
import { MARKET_STATES } from "@/lib/order";
import { fmtPrice, fmtRatePct, formatFixed, fmtUsd } from "@/lib/units";
import { useTx } from "@/lib/tx";
import { stateText, TxBody } from "@/components/Toasts";
import { useNotifications } from "@/lib/notifications";
import { useWallet } from "@/lib/wallet";
import { useUi } from "@/components/ui";
import StateView from "@/components/StateView";
import AccountSummary from "@/components/AccountSummary";
import PortfolioTabs from "@/components/PortfolioTabs";
import MarketInfo from "@/components/MarketInfo";
import { Icon, Tri } from "@/components/Icon";

const SOLVENCY_LABEL: Record<string, string> = {
  bad_debt_unresolved: "Bad debt recorded (not covered by insurance)", liquidation_bad_debt: "Liquidation left bad debt",
  adl: "Auto-deleveraging", recapitalized: "Recapitalized", backstop_deficit: "Backstop loss recorded (insurance + bad debt)",
  backstop_repaid: "Backstop gains repaid earlier draws", adl_skipped: "ADL skipped an account with no margin slack",
};
/** Protocol-wide loss events: liquidations, fills, delist settlement or a permissionless write-off can all record bad debt. */
function SolvencyEventsPanel() {
  const sol = useSolvency().data;
  const rows = (sol?.events ?? []).slice(0, 8);
  return (
    <div className="panel" data-testid="solvency-events">
      <h3>Bad debt, write-offs and deleveraging</h3>
      {!rows.length ? <p className="hint">No bad-debt, auto-deleveraging or recapitalization events seen.</p> : (
        <div className="tbl-wrap"><table><thead><tr><th>Time</th><th>Event</th><th className="r">Amount (USDC)</th><th>Block</th></tr></thead>
          <tbody>{rows.map((e) => <tr key={`${e.txHash}${e.kind}${e.block}`}><td>{new Date(e.time * 1000).toLocaleString()}</td><td>{SOLVENCY_LABEL[e.kind] ?? e.kind}{e.market !== null ? ` (${MARKETS[e.market]?.name ?? "#" + e.market})` : ""}</td><td className="r num">{fmtUsd(e.amount)}</td><td className="num">{e.block.toString()}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

function MarketRow({ id }: { id: number }) {
  const app = useApp();
  const m = MARKETS[id];
  const mark = useMark(id).data, info = useMarketInfo(id).data, fund = useFunding(id).data;
  const s = useStats24h(id).stats;
  const sys = useSystem().data;
  const sm = sys?.markets.find((x) => x.id === id);
  const rules = allowedActions({ state: sm?.state ?? 0, globalPaused: sys?.globalPaused, oracleOk: sm?.oracleOk, name: m.name });
  const open = () => { app.setMarket(id); app.setView("trade"); };
  return (
    <tr>
      <td><button className="linkbtn" onClick={open} aria-label={`Open ${m.name}`}><span className="coin" aria-hidden>{m.base.slice(0, 1)}</span> <b>{m.name}</b> <span className="tagpill">Perpetual</span></button></td>
      <td className="r num">{mark ? fmtPrice(mark) : <span title="No fresh oracle price">-</span>}</td>
      <td className={`r num ${s && s.changePct !== null ? (s.changePct >= 0 ? "long" : "short") : "mute"}`}>{s && s.changePct !== null ? <><Tri up={s.changePct >= 0} />{Math.abs(s.changePct).toFixed(2)}%</> : <span title="Needs at least 24h of trade history">-</span>}</td>
      <td className="r num">{fund ? fmtRatePct(fund.rate) : "-"}</td>
      <td className="r num">{info ? `${formatFixed(info.oi, 8, 3)} ${m.base}` : "-"}</td>
      <td><span className={`state-tag ${rules.tone === "ok" ? "safe" : rules.tone === "bad" ? "bad" : "warn"}`}>{rules.tone === "ok" ? <Icon name="check" size={11} /> : <Icon name="alert" size={11} />}{info ? MARKET_STATES[info.state] : "-"}</span></td>
      <td className="r"><button className="btn sm" onClick={open}>Trade</button></td>
    </tr>
  );
}

export function MarketsView() {
  const { markets } = useBrand();
  const app = useApp();
  return (
    <main className="view" id="main" aria-label="Markets">
      <div className="panel">
        <h3>Markets</h3>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Market</th><th className="r">Mark price</th><th className="r">24h change</th><th className="r">Funding rate</th><th className="r">Open interest</th><th>Status</th><th /></tr></thead>
          <tbody>{markets.map((m) => <MarketRow key={m.id} id={m.id} />)}</tbody>
        </table></div>
      </div>
      <div className="viewcols"><MarketInfo market={app.market} /></div>
    </main>
  );
}

export function PortfolioView() {
  const w = useWallet();
  const ui = useUi();
  const acct = useAccountState(w.acct);
  return (
    <main className="view" id="main" aria-label="Portfolio">
      {!w.address ? <div className="panel"><StateView state="disconnected" subject="portfolio" action={<button className="btn brand" onClick={() => document.getElementById("connect-btn")?.click()}>Connect wallet</button>} /></div> : (
        <>
          <div className="viewcols"><AccountSummary />
            <div className="panel"><h3>Collateral</h3>
              {acct.isError ? <StateView state="failed" subject="your balance" compact /> : <p className="hint">Deposit mock USDC to start trading, or withdraw what is not backing a position. Both are on-chain transactions that show up in Activity.</p>}
              <div className="row auto"><button className="btn brand" onClick={() => ui.setDrawer("account")}>Deposit or withdraw</button></div>
            </div>
          </div>
          <PortfolioTabs />
        </>
      )}
    </main>
  );
}

export function ActivityView() {
  const { txs, clear } = useTx();
  const w = useWallet();
  const ledger = useLedger(w.acct);
  return (
    <main className="view" id="main" aria-label="Activity">
      <div className="panel">
        <h3>This session <button className="btn sm" onClick={clear} disabled={!txs.length}>Clear</button></h3>
        <p className="hint">An action moves through: Waiting for wallet, Sent, Included in block, Confirmed on-chain (or Failed). Only Confirmed on-chain means it worked.</p>
        {!txs.length ? <StateView state="empty" subject="activity this session" compact /> : txs.map((t) => (
          <div className="logitem" key={t.id}><b>{t.label}</b><br /><small className="mute">{stateText(t)} · {t.signer}</small><TxBody t={t} /></div>
        ))}
      </div>
      <SolvencyEventsPanel />
      <div className="panel">
        <h3>Deposits, withdrawals and liquidations</h3>
        {!w.address ? <StateView state="disconnected" subject="transfers" compact /> : ledger.isLoading ? <StateView state="loading" subject="transfers" compact /> : ledger.isError ? <StateView state="failed" subject="transfers" compact action={<button className="btn sm" onClick={() => ledger.refetch()}>Retry</button>} /> : !(ledger.data ?? []).length ? <StateView state="empty" subject="transfers" compact /> : (
          <div className="tbl-wrap"><table><thead><tr><th>Time</th><th>Type</th><th className="r">Amount (USDC)</th><th>Block</th></tr></thead>
            <tbody>{(ledger.data ?? []).slice(0, 50).map((e, i) => <tr key={i}><td>{new Date(e.time * 1000).toLocaleString()}</td><td>{e.kind}</td><td className="r num">{fmtUsd(e.amount)}</td><td className="num">{e.block.toString()}</td></tr>)}</tbody></table></div>
        )}
      </div>
    </main>
  );
}

export function NotificationsView() {
  const n = useNotifications();
  return (
    <main className="view" id="main" aria-label="Notifications">
      <div className="panel">
        <h3>Notifications <span className="row" style={{ flex: "none" }}><button className="btn sm" onClick={n.markAllRead} disabled={!n.unread}>Mark all read</button><button className="btn sm" onClick={n.clear} disabled={!n.items.length}>Clear</button></span></h3>
        <p className="hint">Saved in this browser only. They come from real events: order and transfer results, market state changes and margin warnings.</p>
        {!n.items.length ? <StateView state="empty" subject="notifications" compact /> : n.items.map((x) => (
          <div className={`logitem note ${x.read ? "" : "unread"}`} key={x.id}><b>{x.kind === "error" || x.kind === "margin" || x.kind === "incident" ? <Icon name="alert" size={14} /> : <Icon name="check" size={14} />}{" "}{x.title}</b><br /><small className="mute">{new Date(x.at).toLocaleString()}</small><p>{x.body}</p></div>
        ))}
      </div>
    </main>
  );
}
