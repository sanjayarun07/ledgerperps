"use client";
import { Tri } from "@/components/Icon";
import { useMemo, useState } from "react";
import { MARKETS } from "@/lib/config";
import { useAccountState, useBook, useConditionals, useFundingHistory, useMarketInfo, usePositionStats, usePositions, useSystem, useUserFills } from "@/lib/queries";
import { effectiveLeverage, entryPrice, estimateLiqPrice, mmrBpsFor, imrBpsFor, unrealizedPnl } from "@/lib/risk";
import { buildOrderParams, slippagePrice } from "@/lib/order";
import { allowedActions } from "@/lib/marketRules";
import { closeEstimate, impactBps, walkBook } from "@/lib/ticketMath";
import { useTx } from "@/lib/tx";
import { abs, fmtPrice, fmtSize, fmtSigned, fmtUsd, formatFixed, notionalFloor, parseDecimal } from "@/lib/units";
import { useWallet } from "@/lib/wallet";
import { focusTarget } from "@/lib/focus";
import { Empty, Tip } from "@/components/ui";
import { useBrand } from "@/brand/context";
import { useSort } from "@/components/useSort";
import type { PositionInfo } from "@/lib/data/types";

const name = (m: number) => MARKETS[m]?.name ?? `#${m}`;

/** Everything derived for one position, shared by the table row, the mobile card and the detail drawer. */
export function usePosView(p: PositionInfo) {
  const w = useWallet();
  const acct = useAccountState(w.acct).data;
  const sys = useSystem().data;
  const info = useMarketInfo(p.market).data;
  const sm = sys?.markets.find((m) => m.id === p.market);
  const mark = sm?.markPrice ?? null;
  const entry = entryPrice(p);
  const upnl = mark ? unrealizedPnl(p, mark) : null;
  const entryN = notionalFloor(p.size, entry);
  const pct = upnl !== null && entryN > 0n ? Number((upnl * 10000n) / entryN) / 100 : null;
  const notional = mark ? notionalFloor(p.size, mark) : null;
  const equity = p.isolated ? p.iso.equity : acct?.equity;
  const lev = notional !== null && equity !== undefined ? effectiveLeverage(notional, equity) : null;
  let liq: bigint | null = null;
  if (mark && info && acct) {
    const mmr = mmrBpsFor(notionalFloor(p.size, mark), info.tiers);
    liq = p.isolated ? estimateLiqPrice({ size: p.size, mark, equity: p.iso.equity, mm: p.iso.mm, mmrBps: mmr }) : estimateLiqPrice({ size: p.size, mark, equity: acct.equity, mm: acct.mm, mmrBps: mmr });
  }
  const margin = p.isolated ? p.isoMargin : notional !== null && info ? (notional * imrBpsFor(notional, info.tiers) + 9999n) / 10000n : null;
  const rules = allowedActions({ state: sm?.state ?? 0, globalPaused: sys?.globalPaused, oracleOk: sm?.oracleOk, name: name(p.market), oracle: MARKETS[p.market]?.oracle });
  return { w, acct, info, mark, entry, upnl, pct, notional, lev, liq, margin, rules };
}

function SideTag({ p }: { p: PositionInfo }) {
  return <span className={`sidetag ${p.size > 0n ? "long" : "short"}`}>{p.size > 0n ? "▲ Long" : "▼ Short"}</span>;
}

/** TP/SL attached to this position (reduce-only conditionals). They are listed as "not triggered yet" while still active on the chain. */
function useStops(p: PositionInfo) {
  const w = useWallet();
  const condData = useConditionals(w.acct).data;
  return useMemo(() => {
    const conds = condData ?? [];
    const long = p.size > 0n;
    const mine = conds.filter((c) => c.market === p.market && c.reduceOnly && c.active);
    const tp = mine.find((c) => (long ? !c.isBuy && c.above : c.isBuy && !c.above));
    const sl = mine.find((c) => (long ? !c.isBuy && !c.above : c.isBuy && c.above));
    return { tp, sl };
  }, [condData, p.market, p.size]);
}

function StopsCell({ p }: { p: PositionInfo }) {
  const { tp, sl } = useStops(p);
  if (!tp && !sl) return <span className="mute" title="No take-profit or stop-loss is attached to this position.">-</span>;
  return (
    <span className="num stops cell2" title="Not triggered yet. Stops fire only when the mark price reaches them and may fill worse than the trigger; they are not guaranteed protection.">
      {tp ? <span className="long">TP {fmtPrice(tp.trigger)}</span> : null}{sl ? <span className="short">SL {fmtPrice(sl.trigger)}</span> : null}
      <small>Not triggered yet</small>
    </span>
  );
}

function CloseDialog({ p, onClose }: { p: PositionInfo; onClose: () => void }) {
  const v = usePosView(p);
  const { send } = useTx();
  const book = useBook(p.market, 40).data;
  const [pct, setPct] = useState(100);
  const [txt, setTxt] = useState("");
  const full = abs(p.size);
  const parsed = txt ? parseDecimal(txt, 8) : null;
  const lot = v.info?.lot ?? 1n;
  const raw = parsed ?? (full * BigInt(pct)) / 100n;
  const size = raw > full ? full : (raw / lot) * lot;
  const isBuy = p.size < 0n; // closing a short means buying
  const levels = isBuy ? (book?.asks.px ?? []).map((x, i) => ({ p: x, s: book!.asks.sz[i] })) : (book?.bids.px ?? []).map((x, i) => ({ p: x, s: book!.bids.sz[i] }));
  const walk = walkBook(levels, size);
  const est = walk.avg && v.mark ? closeEstimate({ positionSize: p.size, entry: v.entry, avgExit: walk.avg, closeSize: size, feeBps: 5n, marginReleased: v.margin !== null && full > 0n ? (v.margin * size) / full : 0n }) : null;
  const imp = impactBps(walk.avg, v.mark ?? 0n, isBuy);
  const ok = v.rules.reduce && v.info && v.mark && size > 0n && walk.filled > 0n;
  const submit = () => {
    if (!v.info || !v.mark || !v.w.address) return;
    send({ label: `Close ${fmtSize(size)} ${MARKETS[p.market].base} of ${name(p.market)} (reduce-only)`, kind: "place", unit: MARKETS[p.market].base, functionName: "placeOrder", trading: true,
      args: [v.w.address, v.w.sub, buildOrderParams({ market: p.market, isBuy, price: slippagePrice(v.mark, isBuy, 100, v.info.tick), size, type: "market", tif: "IOC", reduceOnly: true })] });
    onClose();
  };
  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`Close ${name(p.market)}`} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <h2>Close {name(p.market)} <SideTag p={p} /></h2>
        <p className="hint">Reduce-only market order: it can only shrink this position, never flip it. Reversing is a separate order from the ticket.</p>
        <div className="quick">{[25, 50, 75, 100].map((x) => <button key={x} className={`btn sm ${pct === x && !txt ? "brand" : ""}`} onClick={() => { setPct(x); setTxt(""); }}>{x}%</button>)}</div>
        <div className="field" style={{ marginTop: 8 }}><label htmlFor="close-size">Size to close ({MARKETS[p.market].base})</label>
          <div className="inp"><input id="close-size" inputMode="decimal" value={txt || formatFixed(size, 8, 8, 0)} onChange={(e) => setTxt(e.target.value)} autoFocus /></div></div>
        <div className="kvl one">
          <div className="kv"><span>Position size</span><span className="num">{fmtSize(full)} {MARKETS[p.market].base}</span></div>
          <div className="kv"><span>Expected exit price</span><span className="num">{walk.avg ? fmtPrice(walk.avg) : "-"}</span></div>
          <div className="kv"><span>Price impact</span><span className="num">{imp === null ? "-" : `${imp.toFixed(2)} bps`}</span></div>
          <div className="kv"><span>Max slippage</span><span className="num">1.00%</span></div>
          <div className="kv"><span>Realised PnL (est.)</span><span className={`num ${est && est.pnl < 0n ? "short" : "long"}`}>{est ? `${est.pnl >= 0n ? "▲ " : "▼ "}${fmtSigned(est.pnl, 6, 2)} USDC` : "-"}</span></div>
          <div className="kv"><span>Fee (est.)</span><span className="num">{est ? `${fmtUsd(est.fee)} USDC` : "-"}</span></div>
          <div className="kv"><span>Expected proceeds</span><span className="num">{est ? `${fmtUsd(est.proceeds)} USDC` : "-"}</span></div>
        </div>
        {walk.filled < size && walk.filled > 0n && <p className="callout warn">The book only has {fmtSize(walk.filled)} {MARKETS[p.market].base} of depth: the rest of this order would be canceled.</p>}
        {!v.rules.reduce && <p className="callout bad">{v.rules.notice}</p>}
        <p className="hint">Proceeds are an estimate: margin released plus realised PnL minus the taker fee (5 bps assumed). The contract settles the real numbers.</p>
        <div className="row"><button className="btn" onClick={onClose}>Keep position</button><button className="btn sell" disabled={!ok} onClick={submit}>Close {fmtSize(size)} {MARKETS[p.market].base}</button></div>
      </div>
    </div>
  );
}

function MarginDialog({ p, onClose }: { p: PositionInfo; onClose: () => void }) {
  const v = usePosView(p);
  const { send } = useTx();
  const [amt, setAmt] = useState("");
  const a = parseDecimal(amt, 6);
  const run = (fn: "addIsoMargin" | "removeIsoMargin") => { if (!a) return; send({ label: `${fn === "addIsoMargin" ? "Add" : "Remove"} ${amt} USDC isolated margin on ${name(p.market)}`, functionName: fn, args: [v.w.sub, p.market, a] }); onClose(); };
  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Isolated margin" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <h2>Isolated margin: {name(p.market)}</h2>
        <p className="hint">Isolated margin protects the rest of your account: this position can lose at most the margin you put in. Adding margin moves the liquidation price further away; removing it brings it closer.</p>
        <div className="kvl one">
          <div className="kv"><span>Current margin</span><span className="num">{fmtUsd(p.isoMargin)} USDC</span></div>
          <div className="kv"><span>Available to add</span><span className="num">{v.acct ? fmtUsd(v.acct.withdrawable) : "-"} USDC</span></div>
          <div className="kv"><span>Est. liquidation price</span><span className="num">{v.liq ? fmtPrice(v.liq) : "-"}</span></div>
        </div>
        <div className="field"><label htmlFor="iso-amt">Amount (USDC)</label><div className="inp"><input id="iso-amt" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} autoFocus /></div></div>
        <div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn" disabled={!a} onClick={() => run("removeIsoMargin")}>Remove margin</button><button className="btn brand" disabled={!a} onClick={() => run("addIsoMargin")}>Add margin</button></div>
      </div>
    </div>
  );
}

function DetailDrawer({ p, onClose }: { p: PositionInfo; onClose: () => void }) {
  const v = usePosView(p);
  const w = useWallet();
  const stats = usePositionStats(w.acct).data;
  const funding = useFundingHistory(w.acct).data;
  const fills = (useUserFills(w.acct).data ?? []).filter((f) => f.market === p.market);
  const st = stats?.find((x) => x.market === p.market);
  const paid = funding ? funding.filter((f) => f.market === p.market).reduce((s, f) => s + f.owed, 0n) : null;
  const dash = (why: string) => <span className="dash" title={why}>- <small className="mute">{why}</small></span>;
  return (
    <div className="drawer-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${name(p.market)} position details`} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <h2>{name(p.market)} <SideTag p={p} /> <button className="btn sm" onClick={onClose} autoFocus>Close</button></h2>
        <div className="kvl one">
          <div className="kv"><span>Size</span><span className="num">{fmtSize(abs(p.size))} {MARKETS[p.market].base}</span></div>
          <div className="kv"><span>Entry price</span><span className="num">{fmtPrice(v.entry)}</span></div>
          <div className="kv"><span>Mark price</span><span className="num">{v.mark ? fmtPrice(v.mark) : "stale"}</span></div>
          <div className="kv"><span>Unrealized PnL</span><span className={`num ${v.upnl && v.upnl < 0n ? "short" : "long"}`}>{v.upnl !== null ? `${v.upnl >= 0n ? "▲ " : "▼ "}${fmtSigned(v.upnl, 6, 2)} USDC` : "-"}</span></div>
          <div className="kv"><span>Margin mode</span><span>{p.isolated ? `Isolated, ${fmtUsd(p.isoMargin)} USDC` : "Cross"}</span></div>
          <div className="kv"><span>Est. liquidation price</span><span className="num">{v.liq ? fmtPrice(v.liq) : "-"}</span></div>
          <div className="kv"><span>Funding paid / received</span><span className="num">{paid === null ? dash("needs the indexer") : `${fmtSigned(-paid, 6, 4)} USDC`}</span></div>
          <div className="kv"><span>Fees paid</span><span className="num">{st ? `${fmtUsd(st.feesPaid)} USDC` : dash("needs the indexer")}</span></div>
          <div className="kv"><span>Realised PnL</span><span className="num">{st ? `${fmtSigned(st.realizedPnl, 6, 2)} USDC` : dash("needs the indexer")}</span></div>
        </div>
        <h4>Execution history</h4>
        {fills.length === 0 ? <p className="hint">{w.acct ? "No fills for this market were found. History comes from the indexer (or recent chain events) and may be incomplete." : "-"}</p> : (
          <table style={{ minWidth: 0 }}><thead><tr><th>Time</th><th>Side</th><th className="r">Price</th><th className="r">Size</th></tr></thead>
            <tbody>{fills.slice(0, 20).map((f) => <tr key={f.tradeId.toString()}><td>{new Date(f.time * 1000).toLocaleTimeString()}</td><td className={f.takerIsBuy ? "long" : "short"}>{f.takerIsBuy ? "▲ Buy" : "▼ Sell"}</td><td className="r">{fmtPrice(f.price)}</td><td className="r">{fmtSize(f.size)}</td></tr>)}</tbody></table>
        )}
      </aside>
    </div>
  );
}

function Row({ p, onClose, onMargin, onDetail }: { p: PositionInfo; onClose: () => void; onMargin: () => void; onDetail: () => void }) {
  const v = usePosView(p);
  const up = v.upnl !== null && v.upnl >= 0n;
  return (
    <tr>
      <td><button className="linkish" onClick={onDetail} aria-label={`${name(p.market)} position details`}>{name(p.market)}</button><SideTag p={p} /> <span className="chip lev">{v.lev !== null ? `${v.lev.toFixed(1)}x` : "-"}</span></td>
      <td className="r num">{fmtSize(abs(p.size), 4)}</td>
      <td className="r num"><span className="cell2"><span>{fmtPrice(v.entry)}</span><small>{v.mark ? fmtPrice(v.mark) : "stale"}</small></span></td>
      <td className={`r num ${v.upnl !== null ? (up ? "long" : "short") : ""}`} title="Unrealized PnL = (mark price − entry price) × size. The percentage is the price move since entry, not the return on margin."><span className="cell2"><span>{v.upnl === null ? "-" : <><Tri up={up} size={7} />{fmtSigned(v.upnl, 6, 2)}</>}</span>{v.pct !== null ? <small>{v.pct >= 0 ? "+" : ""}{v.pct.toFixed(2)}%</small> : null}</span></td>
      <td className="r num"><span className="cell2"><span>{v.margin !== null ? fmtUsd(v.margin) : "-"}</span><small>{p.isolated ? "Isolated" : "Cross"}</small></span></td>
      <td className="r num">{v.liq ? fmtPrice(v.liq) : v.mark ? "none" : "-"}</td>
      <td className="r"><StopsCell p={p} /></td>
      <td className="r act">
        {p.isolated && <button className="btn sm ghost" onClick={onMargin}>Margin</button>}
        <button className="btn sm" onClick={onClose} disabled={!v.rules.reduce || !v.mark} title={v.rules.reduce ? "Close all or part of this position (reduce-only)" : v.rules.notice ?? ""}>Close</button>
      </td>
    </tr>
  );
}

function Card({ p, onClose, onMargin, onDetail }: { p: PositionInfo; onClose: () => void; onMargin: () => void; onDetail: () => void }) {
  const v = usePosView(p);
  const up = v.upnl !== null && v.upnl >= 0n;
  return (
    <article className="poscard" aria-label={`${name(p.market)} position`}>
      <header><button className="linkish" onClick={onDetail}>{name(p.market)}</button><SideTag p={p} /><span className="chip lev">{v.lev !== null ? `${v.lev.toFixed(1)}x` : "-"}</span></header>
      <div className={`big num ${v.upnl !== null ? (up ? "long" : "short") : ""}`}>{v.upnl === null ? "-" : `${up ? "▲" : "▼"} ${fmtSigned(v.upnl, 6, 2)} USDC`}{v.pct !== null ? <small> ({v.pct >= 0 ? "+" : ""}{v.pct.toFixed(2)}%)</small> : null}</div>
      <div className="kvl"><div className="kv"><span>Size</span><span className="num">{fmtSize(abs(p.size))}</span></div><div className="kv"><span>Entry</span><span className="num">{fmtPrice(v.entry)}</span></div>
        <div className="kv"><span>Mark</span><span className="num">{v.mark ? fmtPrice(v.mark) : "-"}</span></div><div className="kv"><span>Liq. (est.)</span><span className="num">{v.liq ? fmtPrice(v.liq) : "-"}</span></div>
        <div className="kv"><span>Margin</span><span className="num">{v.margin !== null ? fmtUsd(v.margin) : "-"}</span></div><div className="kv"><span>TP / SL</span><span><StopsCell p={p} /></span></div></div>
      <div className="row">{p.isolated && <button className="btn" onClick={onMargin}>Margin</button>}<button className="btn" onClick={onClose} disabled={!v.rules.reduce || !v.mark}>Close position</button></div>
    </article>
  );
}

export default function Positions() {
  const w = useWallet();
  const positions = usePositions(w.acct).data ?? [];
  const stats = usePositionStats(w.acct).data;
  const sort = useSort<"market" | "size">("size");
  const { copy } = useBrand().brand;
  const open = sort.apply(positions.filter((p) => p.size !== 0n), { market: (p) => p.market, size: (p) => Number(abs(p.size)) });
  const modes = positions.filter((p) => p.size === 0n && p.isolated);
  const [closing, setClosing] = useState<number | null>(null);
  const [margin, setMargin] = useState<number | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const by = (m: number | null) => open.find((p) => p.market === m) ?? null;
  if (!open.length) return <Empty title="No open positions" body={`${copy.emptyPositions ?? "When you buy or sell, your position shows up here with its profit, loss and a Close button."}${modes.length ? ` Isolated margin is on for ${modes.map((m) => name(m.market)).join(", ")}.` : ""}`} action={<button className="btn link" onClick={() => focusTarget("size")}>Place a first order</button>} />;
  return (
    <>
      <table className="postable desk-only">
        <thead><tr><sort.Th k="market">Market</sort.Th><sort.Th k="size" r>Size</sort.Th><th className="r">Entry / <Tip k="mark">Mark</Tip></th><th className="r"><Tip k="equity">PnL</Tip></th><th className="r"><Tip k="cross">Margin</Tip></th><th className="r"><Tip k="liq" align="right">Liq. price (est.)</Tip></th><th className="r">TP / SL</th><th className="r">Actions</th></tr></thead>
        <tbody>{open.map((p) => <Row key={p.market} p={p} onClose={() => setClosing(p.market)} onMargin={() => setMargin(p.market)} onDetail={() => setDetail(p.market)} />)}</tbody>
      </table>
      <div className="only-m cards">{open.map((p) => <Card key={p.market} p={p} onClose={() => setClosing(p.market)} onMargin={() => setMargin(p.market)} onDetail={() => setDetail(p.market)} />)}</div>
      {stats && <p className="hint">Realized PnL and fees come from the indexer and may be incomplete; size, entry and margin are read from the chain. Open a position&apos;s name for details.</p>}
      <p className="hint">Liquidation prices are estimates. Cross margin holds your other positions, funding and order reserves fixed; the contract&apos;s own check is authoritative. Take-profit and stop-loss orders are not guaranteed protection.</p>
      {closing !== null && by(closing) && <CloseDialog p={by(closing)!} onClose={() => setClosing(null)} />}
      {margin !== null && by(margin) && <MarginDialog p={by(margin)!} onClose={() => setMargin(null)} />}
      {detail !== null && by(detail) && <DetailDrawer p={by(detail)!} onClose={() => setDetail(null)} />}
    </>
  );
}
