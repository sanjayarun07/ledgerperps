"use client";
import { useMemo, useState } from "react";
import { useApp } from "@/lib/app";
import { useBook, useMarketInfo, useMark, useTrades } from "@/lib/queries";
import { groupLevels, pressure, spreadInfo } from "@/lib/terminal";
import { fmtPrice, fmtSize, fmtUsd, formatFixed, notionalFloor } from "@/lib/units";
import { Tip } from "@/components/ui";
import { Tri } from "@/components/Icon";

const ROWS = 10;
const GROUPS = [1n, 5n, 10n, 50n, 100n];

export default function BookPanel() {
  const { market, setPick, base, mkt, setMkt, setCtab } = useApp();
  const tab: "book" | "trades" = mkt === "trades" ? "trades" : "book";
  const setTab = (t: "book" | "trades") => setMkt(t);
  const [gi, setGi] = useState(0);
  const [quote, setQuote] = useState(true);
  const book = useBook(market, 40);
  const info = useMarketInfo(market).data;
  const mark = useMark(market);
  const trades = useTrades(market);
  const step = (info?.tick ?? 1n) * GROUPS[gi];

  const { asks, bids, maxCum, press, spread } = useMemo(() => {
    const b = book.data;
    const rawAsks = (b?.asks.px ?? []).map((p, i) => ({ p, s: b!.asks.sz[i] }));
    const rawBids = (b?.bids.px ?? []).map((p, i) => ({ p, s: b!.bids.sz[i] }));
    const a = groupLevels(rawAsks, step, "ask").slice(0, ROWS), d = groupLevels(rawBids, step, "bid").slice(0, ROWS);
    let c = 0n; const asksC = a.map((r) => ({ ...r, c: (c += r.s) }));
    c = 0n; const bidsC = d.map((r) => ({ ...r, c: (c += r.s) }));
    const maxCum = [...asksC, ...bidsC].reduce((m, r) => (r.c > m ? r.c : m), 1n);
    return { asks: asksC, bids: bidsC, maxCum, press: pressure(bidsC.at(-1)?.c ?? 0n, asksC.at(-1)?.c ?? 0n), spread: spreadInfo(rawBids[0]?.p, rawAsks[0]?.p) };
  }, [book.data, step]);

  const amt = (s: bigint, p: bigint) => (quote ? fmtUsd(notionalFloor(s, p), 0) : fmtSize(s));
  const pickPrice = (p: bigint) => setPick(formatFixed(p, 6));
  const Row = ({ r, side }: { r: { p: bigint; s: bigint; c: bigint }; side: "ask" | "bid" }) => (
    <div className="book-row num" role="button" tabIndex={0} title="Use this price in the order panel" aria-label={`${side === "ask" ? "Sell" : "Buy"} level ${fmtPrice(r.p)}, size ${fmtSize(r.s)}. Use this price`}
      onClick={() => pickPrice(r.p)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickPrice(r.p); } }}>
      <i className="bar" style={{ width: `${Number((r.c * 100n) / maxCum)}%`, background: side === "ask" ? "var(--short-bg)" : "var(--long-bg)" }} />
      <span className={side === "ask" ? "short" : "long"}>{fmtPrice(r.p)}</span><span>{amt(r.s, r.p)}</span><span>{amt(r.c, r.p)}</span>
    </div>
  );
  return (
    <div className="panel bookpanel">
      <div className="booktop">
        <span className="seg ctab-switch" role="group" aria-label="Chart or order book"><button onClick={() => setCtab("chart")}>Chart</button><button className="on" aria-pressed>Book</button></span>
        <div className="seg" role="tablist" aria-label="Book or trades"><button role="tab" aria-selected={tab === "book"} className={tab === "book" ? "on" : ""} onClick={() => setTab("book")}>Order book</button><button role="tab" aria-selected={tab === "trades"} className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>Recent trades</button></div>
      </div>
      {tab === "book" ? (
        <>
        <div className="book-sub">
          <span className="inp sm"><select aria-label="Price grouping" value={gi} onChange={(e) => setGi(Number(e.target.value))}>{GROUPS.map((g, i) => <option key={i} value={i}>{info ? formatFixed(info.tick * g, 6, 2, 1) : `x${g}`}</option>)}</select></span>
          <span className="seg" role="group" aria-label="Size unit"><button aria-pressed={!quote} className={!quote ? "on" : ""} onClick={() => setQuote(false)}>{base}</button><button aria-pressed={quote} className={quote ? "on" : ""} onClick={() => setQuote(true)}>USDC</button></span>
        </div>
        <div className="bookbody">
          <div className="book-head"><span>Price</span><span>Size ({quote ? "USDC" : base})</span><span>Total</span></div>
          {book.isLoading && <div role="status" className="book-skel">{Array.from({ length: 12 }, (_, i) => <span key={i} className="skel" />)}<span className="sr">Loading order book</span></div>}
          <div className="book-side asks">{[...asks].reverse().map((r) => <Row key={`a${r.p}`} r={r} side="ask" />)}
          {asks.length === 0 && !book.isLoading && <div className="empty">No sell orders on the book yet.</div>}</div>
          <div className="book-mid" aria-label="Spread">
            <b className="num">{mark.data ? fmtPrice(mark.data) : "stale"}</b>
            <span className="mute"><Tip k="spread" align="right">Spread</Tip> <span className="num" style={{ color: "var(--text)" }}>{spread ? `${fmtPrice(spread.abs)} (${spread.pct.toFixed(2)}%)` : "-"}</span></span>
          </div>
          <div className="book-side bids">{bids.map((r) => <Row key={`b${r.p}`} r={r} side="bid" />)}
          {bids.length === 0 && !book.isLoading && <div className="empty">No buy orders on the book yet. Place a limit order to start the book.</div>}</div>
        </div>
        </>
      ) : (
        <div className="bookbody">
          <div className="book-head"><span>Price</span><span>Size</span><span>Time</span></div>
          {trades.data?.length === 0 && <div className="empty"><b>No trades yet</b><p>Trades appear here as soon as two orders match.</p></div>}
          {trades.data?.map((t) => (
            <div key={t.tradeId.toString()} className="trade-row num">
              <span className={t.takerIsBuy ? "long" : "short"}><Tri up={t.takerIsBuy} size={7} />{fmtPrice(t.price)}</span><span>{fmtSize(t.size)}</span>
              <span className="mute">{new Date(t.time * 1000).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
      {tab === "book" && (
        <div className="pressure" role="img" aria-label={press ? `Buy pressure ${press.buy} percent, sell pressure ${press.sell} percent` : "No pressure data"}>
          {press ? <><i style={{ width: `${press.buy}%` }} /><span className="long num"><Tri up size={7} />Buyers {press.buy}%</span><span className="short num">Sellers {press.sell}%<Tri up={false} size={7} /></span></> : <span className="mute">No visible orders</span>}
        </div>
      )}
    </div>
  );
}
