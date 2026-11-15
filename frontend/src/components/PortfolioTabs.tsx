"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { MARKETS } from "@/lib/config";
import { useAccountState, useChainClock, useConditionals, useUsdc, useFundingHistory, useLedger, useOpenOrders, useOrderHistory, usePositions, useTwaps, useUserFills } from "@/lib/queries";
import { useTx } from "@/lib/tx";
import { fmtPrice, fmtSize, fmtUsd } from "@/lib/units";
import { useWallet } from "@/lib/wallet";
import { focusTarget } from "@/lib/focus";
import { Empty, Tip } from "@/components/ui";
import { useBrand } from "@/brand/context";
import { useSort } from "@/components/useSort";
import Positions from "@/components/Positions";
import { cancelReasonText } from "@/lib/order";
import { stateText, TxBody } from "@/components/Toasts";
import type { DockTab } from "@/brand/gate";
import type { GlossaryKey } from "@/lib/glossary";

const name = (m: number) => MARKETS[m]?.name ?? `#${m}`;
const when = (t: number) => new Date(t * 1000).toLocaleString();

export default function PortfolioTabs() {
  const { dockTabs } = useBrand();
  const [tab, setTab] = useState<DockTab>("Positions");
  const w = useWallet();
  const nPos = (usePositions(w.acct).data ?? []).filter((p) => p.size !== 0n).length;
  const nOrd = (useOpenOrders(w.acct).data ?? []).length;
  const nTw = (useTwaps(w.acct).data ?? []).filter((t) => t.active).length;
  const nCond = (useConditionals(w.acct).data ?? []).length;
  const counts: Partial<Record<DockTab, number>> = { Positions: nPos, "Open orders": nOrd, TWAPs: nTw, Conditionals: nCond };
  const cur = dockTabs.includes(tab) ? tab : "Positions";
  const PRIMARY: DockTab[] = ["Balances", "Positions", "Open orders", "Conditionals", "TWAPs", "Trades", "Funding", "Order history"];
  const main = PRIMARY.filter((t) => dockTabs.includes(t));
  const more = dockTabs.filter((t) => !PRIMARY.includes(t));
  const label = (t: DockTab) => (t === "Trades" ? "Trade history" : t === "Funding" ? "Funding history" : t === "Conditionals" ? "Triggers" : t === "TWAPs" ? "TWAPs" : t);
  const { send } = useTx();
  const [menu, setMenu] = useState(false);
  return (
    <div className="panel dock" id="section-portfolio">
      <div className="docktabs" role="tablist" aria-label="Portfolio sections">
        {main.map((t) => <button key={t} role="tab" aria-selected={t === cur} data-portfolio-tab={t} className={t === cur ? "on" : ""} onClick={() => setTab(t)}>{label(t)}{counts[t] !== undefined && w.address ? <span className="count">{counts[t]}</span> : null}</button>)}
        {more.length > 0 && (
          <span className="popwrap more" onKeyDown={(e) => { if (e.key === "Escape") setMenu(false); }}>
            <button role="tab" aria-selected={more.includes(cur)} aria-haspopup="menu" aria-expanded={menu} className={more.includes(cur) ? "on" : ""} onClick={() => setMenu(!menu)}>{more.includes(cur) ? label(cur) : "More"} <Icon name="chevron" size={12} /></button>
            {menu && <div className="menu up" role="menu">{more.map((t) => <button key={t} role="menuitem" data-portfolio-tab={t} className="menu-item" onClick={() => { setTab(t); setMenu(false); }}>{label(t)}{counts[t] !== undefined && w.address ? <span className="count">{counts[t]}</span> : null}</button>)}</div>}
          </span>
        )}
        <span className="popwrap more dock-actions" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn sm danger" disabled={!w.address || nOrd === 0} title="Cancel every open limit order on this sub-account" onClick={() => send({ label: `Cancel all orders (subaccount ${w.sub})`, kind: "cancel", functionName: "cancelAll", args: [w.address, w.sub], trading: true })}>Cancel all orders</button>
        </span>
      </div>
      <div className="dockbody">
      {!w.address ? <Empty title="Nothing to show yet" body="Connect a wallet and your positions, orders and history will appear here." action={<button className="btn link" onClick={() => document.getElementById("connect-btn")?.click()}>Connect wallet</button>} /> : (
        <div className="tbl-wrap">
          {cur === "Positions" && <Positions />}
          {cur === "Open orders" && <Orders />}
          {cur === "Balances" && <Balances />}
          {cur === "Order history" && <OrderHistory />}
          {cur === "Trades" && <Fills />}
          {cur === "Funding" && <Funding />}
          {cur === "TWAPs" && <Twaps />}
          {cur === "Conditionals" && <Conditionals />}
          {cur === "Transfers" && <Ledger />}
          {cur === "Activity" && <ActivityTab />}
        </div>
      )}
      </div>
    </div>
  );
}

function Orders() {
  const w = useWallet();
  const { send } = useTx();
  const orders = useOpenOrders(w.acct).data ?? [];
  const { copy } = useBrand().brand;
  const sort = useSort<"id" | "price" | "size">("id");
  const rows = sort.apply(orders, { id: (o) => Number(o.id), price: (o) => Number(o.price), size: (o) => Number(o.size) });
  return (
    <>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn sm danger" disabled={!orders.length || !w.address} onClick={() => send({ label: `Cancel all orders (subaccount ${w.sub})`, kind: "cancel", functionName: "cancelAll", args: [w.address, w.sub], trading: true })} style={{ flex: "none" }}>Cancel all orders</button>
      </div>
      <table>
        <thead><tr><sort.Th k="id">ID</sort.Th><th>Market</th><th>Side</th><sort.Th k="price" r>Price</sort.Th><sort.Th k="size" r>Remaining</sort.Th><th>Flags</th><th className="r">Reserved</th><th className="desk-only" /></tr></thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id.toString()}><td className="num">#{o.id.toString()}<span className="only-m"><br /><button className="btn sm" onClick={() => send({ label: `Cancel order #${o.id}`, kind: "cancel", functionName: "cancelOrder", args: [o.id], trading: true })}>Cancel</button></span></td><td>{name(o.market)}</td><td className={o.isBuy ? "long" : "short"}>{o.isBuy ? "▲ Buy" : "▼ Sell"}</td>
              <td className="r num">{fmtPrice(o.price)}</td><td className="r num">{fmtSize(o.size)}</td><td>{o.reduceOnly ? "reduce-only" : ""}</td><td className="r num">{fmtUsd(o.reserve)}</td>
              <td className="desk-only"><button className="btn sm" onClick={() => send({ label: `Cancel order #${o.id}`, kind: "cancel", functionName: "cancelOrder", args: [o.id], trading: true })}>Cancel</button></td></tr>
          ))}
          {!orders.length && <tr><td colSpan={8}><Empty title="No open orders" body={copy.emptyOrders ?? "Limit orders that are waiting for a price show here. You can cancel them any time."} action={<button className="btn link" onClick={() => focusTarget("size")}>Place a limit order</button>} /></td></tr>}
        </tbody>
      </table>
    </>
  );
}

function Conditionals() {
  const w = useWallet();
  const { send } = useTx();
  const conds = useConditionals(w.acct).data ?? [];
  if (!conds.length) return <Empty title="No take-profit, stop-loss or trigger orders" body="Add them from the order panel (checkbox) or the Advanced tab. They fire automatically when the price is reached." />;
  return (
    <table><thead><tr><th>ID</th><th>Market</th><th>Side</th><th>Fires when price</th><th className="r">Limit</th><th className="r">Size</th><th>Linked</th><th /></tr></thead>
      <tbody>{conds.map((c) => (
        <tr key={c.id.toString()}><td className="num">#{c.id.toString()}</td><td>{name(c.market)}</td><td className={c.isBuy ? "long" : "short"}>{c.isBuy ? "▲ Buy" : "▼ Sell"}{c.reduceOnly ? " (reduce)" : ""}</td>
          <td className="num">{c.above ? "≥" : "≤"} {fmtPrice(c.trigger)}</td><td className="r num">{fmtPrice(c.limit)}</td><td className="r num">{fmtSize(c.size)}</td><td className="num">{c.sibling ? `#${c.sibling}` : ""}</td>
          <td><button className="btn sm" onClick={() => send({ label: `Cancel conditional #${c.id}`, functionName: "cancelConditional", args: [c.id], trading: true })}>Cancel</button>{" "}
            <button className="btn sm" title="Anyone can try to trigger; it only succeeds if the price condition is met" onClick={() => send({ label: `Trigger conditional #${c.id}`, functionName: "executeConditional", args: [c.id] })}>Trigger</button></td></tr>
      ))}</tbody></table>
  );
}

function Twaps() {
  const w = useWallet();
  const { send } = useTx();
  const twaps = useTwaps(w.acct).data ?? [];
  const clock = useChainClock();
  if (!twaps.length) return <Empty title="No TWAP orders" body="A TWAP splits a big order into slices over time. Start one from the Advanced tab of the order panel." />;
  return (
    <table><thead><tr><th>ID</th><th>Market</th><th>Side</th><th>Slices done / failed / total</th><th className="r">Filled / total</th><th>Next slice</th><th>Status</th><th /></tr></thead>
      <tbody>{twaps.map((t) => (
        <tr key={t.id.toString()}><td className="num">#{t.id.toString()}</td><td>{name(t.market)}</td><td className={t.isBuy ? "long" : "short"}>{t.isBuy ? "▲ Buy" : "▼ Sell"}</td>
          <td className="num">{t.done} / {t.failed} / {t.slices}</td><td className="r num">{fmtSize(t.filled)} / {fmtSize(t.total)}</td><td>{t.active ? (t.nextTime > clock.now ? `${when(t.nextTime)} (in ${t.nextTime - clock.now}s chain time)` : "due now") : "-"}</td><td>{t.active ? "active" : t.status ?? "finished"}</td>
          <td>{t.active && (<><button className="btn sm" disabled={t.nextTime > clock.now} title={t.nextTime > clock.now ? "Not due yet in chain time: the contract rejects an early slice" : "Anyone can run a due slice; it executes as an IOC order at mark ± slippage"} onClick={() => send({ label: `Run TWAP #${t.id} slice`, functionName: "executeTwapSlice", args: [t.id] })}>Run slice</button>{" "}
            <button className="btn sm danger" onClick={() => send({ label: `Cancel TWAP #${t.id}`, functionName: "cancelTwap", args: [t.id], trading: true })}>Cancel</button></>)}</td></tr>
      ))}</tbody></table>
  );
}

function Balances() {
  const w = useWallet();
  const acct = useAccountState(w.acct).data;
  const usdc = useUsdc(w.address).data;
  const label = useBrand().collateral.label;
  if (!acct) return <Empty title="Loading balances" body="Reading your account from the chain." />;
  const rows: [string, string, GlossaryKey | null][] = [["Equity", fmtUsd(acct.equity), "equity"], ["Collateral deposited", fmtUsd(acct.collateral), "collateral"], ["Available to trade", fmtUsd(acct.avail), "available"], ["Withdrawable", fmtUsd(acct.withdrawable), "withdrawable"], ["Margin in use", fmtUsd(acct.im), "im"], ["Maintenance margin", fmtUsd(acct.mm), "mm"], ["Reserved for open orders", fmtUsd(acct.resv), null], [`${label} in wallet`, usdc ? fmtUsd(usdc.bal) : "-", null]];
  return (
    <table style={{ minWidth: 0, maxWidth: 520 }}><thead><tr><th>Balance</th><th className="r">{label}</th></tr></thead>
      <tbody>{rows.map(([l, v, k]) => <tr key={l}><td>{l} {k && <Tip k={k} />}</td><td className="r num">{v}</td></tr>)}</tbody></table>
  );
}

function ActivityTab() {
  const { txs } = useTx();
  if (!txs.length) return <Empty title="No activity yet" body="Every deposit, order and cancellation you send is listed here with its final result." />;
  return <div>{txs.map((t) => <div className="logitem" key={t.id}><b>{t.label}</b> <small className="mute">{new Date(t.at).toLocaleTimeString()} · {stateText(t)} · {t.signer}</small><TxBody t={t} compact /></div>)}</div>;
}

function OrderHistory() {
  const w = useWallet();
  const q = useOrderHistory(w.acct);
  if (q.data === null) return <p className="empty">Full order history needs the indexer, which is not connected in this setup. Your currently open orders are in the Open orders tab.</p>;
  const rows = q.data ?? [];
  if (!rows.length) return <Empty title="No orders yet" body="Every order you place, filled or cancelled, is listed here." />;
  return (
    <table><thead><tr><th>Time</th><th>ID</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">Size</th><th className="r">Filled</th><th>TIF</th><th>Status</th></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id.toString()}><td>{when(o.time)}</td><td className="num">#{o.id.toString()}</td><td>{name(o.market)}</td><td className={o.isBuy ? "long" : "short"}>{o.isBuy ? "Buy" : "Sell"}{o.reduceOnly ? " (reduce)" : ""}</td>
          <td className="r num">{fmtPrice(o.price)}</td><td className="r num">{fmtSize(o.size)}</td><td className="r num">{fmtSize(o.filled)}{o.avgFillPrice ? ` @ ${fmtPrice(o.avgFillPrice)}` : ""}</td><td>{o.tif}</td><td>{o.status}{o.cancelReason ? ` (${o.cancelReason.replace(/_/g, " ")})` : ""}{o.cancelReason === "price_band" && <small className="mute"> {cancelReasonText("price_band")}</small>}</td></tr>
      ))}</tbody></table>
  );
}

function Fills() {
  const w = useWallet();
  const fills = useUserFills(w.acct).data ?? [];
  if (!fills.length) return <Empty title="No trades yet" body="Your filled orders appear here with price, size and fee." />;
  return (
    <table><thead><tr><th>Time</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">Size</th><th>Role</th><th className="r">Fee (+paid / -rebate)</th></tr></thead>
      <tbody>{fills.slice(0, 100).map((f) => {
        const taker = f.taker === w.acct;
        const buy = taker ? f.takerIsBuy : !f.takerIsBuy;
        return (<tr key={f.tradeId.toString()}><td>{when(f.time)}</td><td>{name(f.market)}</td><td className={buy ? "long" : "short"}>{buy ? "Buy" : "Sell"}</td><td className="r num">{fmtPrice(f.price)}</td><td className="r num">{fmtSize(f.size)}</td><td>{taker ? "taker" : "maker"}</td><td className="r num">{fmtUsd(taker ? f.takerFee : f.makerFee)}</td></tr>);
      })}</tbody></table>
  );
}

function Funding() {
  const w = useWallet();
  const rows = useFundingHistory(w.acct).data ?? [];
  if (!rows.length) return <Empty title="No funding payments yet" body="Funding is a small payment between longs and shorts. It is settled when you next touch an open position." />;
  return (
    <table><thead><tr><th>Time</th><th>Market</th><th className="r">Payment (USDC)</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{when(r.time)}</td><td>{name(r.market)}</td><td className={`r num ${r.owed > 0n ? "short" : "long"}`}>{r.owed > 0n ? "-" : "+"}{fmtUsd(r.owed < 0n ? -r.owed : r.owed)}</td></tr>)}</tbody></table>
  );
}

function Ledger() {
  const w = useWallet();
  const rows = useLedger(w.acct).data ?? [];
  if (!rows.length) return <Empty title="No deposits or withdrawals yet" body="Move money in or out from the account panel and it is recorded here." action={<button className="btn link" onClick={() => focusTarget("deposit")}>Deposit USDC</button>} />;
  return (
    <table><thead><tr><th>Time</th><th>Type</th><th className="r">Amount</th><th>Block</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{when(r.time)}</td><td className={r.kind === "Liquidated" ? "short" : ""}>{r.kind}{r.market !== undefined ? ` ${name(r.market)}` : ""}</td><td className="r num">{r.kind === "Liquidated" ? `${fmtSize(r.amount)} (size)` : r.kind === "InternalTransfer" ? `${r.amount < 0n ? "-" : "+"}${fmtUsd(r.amount < 0n ? -r.amount : r.amount)} USDC (${r.amount < 0n ? "sent" : "received"})` : `${r.amount < 0n ? "-" : ""}${fmtUsd(r.amount < 0n ? -r.amount : r.amount)} USDC`}</td><td className="num">{r.block.toString()}</td></tr>)}</tbody></table>
  );
}
