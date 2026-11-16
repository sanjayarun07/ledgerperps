"use client";
// Maker console: place and manage a ladder of resting quotes by hand, to test market making against the testnet book.
// Testnet only, simulated liquidity, unaudited. Every order is a real on-chain transaction (gas), so enable a session key
// (Account -> Session keys) to avoid one wallet prompt per order.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/app";
import { MARKETS } from "@/lib/config";
import { buildOrderParams } from "@/lib/order";
import { useAccountState, useBook, useMark, useMarketInfo, useOpenOrders, usePositions } from "@/lib/queries";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { fmtPrice, fmtSize, fmtUsd, formatFixed, parseDecimal } from "@/lib/units";
import Toasts from "@/components/Toasts";

const MAX_OPEN = 32; // per account/subaccount, enforced by the exchange
const SUBS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function MakerConsole() {
  const { market, setMarket, base, name } = useApp();
  const w = useWallet();
  const { send } = useTx();
  const info = useMarketInfo(market).data;
  const mark = useMark(market).data ?? 0n;
  const book = useBook(market).data;
  const acct = useAccountState(w.acct).data;
  const orders = (useOpenOrders(w.acct).data ?? []).filter((o) => o.market === market);
  const pos = usePositions(w.acct).data?.find((p) => p.market === market);

  const [levels, setLevels] = useState("5");
  const [first, setFirst] = useState("10");   // bps from the mark to the first level
  const [step, setStep] = useState("10");     // bps between levels
  const [clip, setClip] = useState("0.001");  // base size per level
  const [post, setPost] = useState(true);
  const [ttl, setTtl] = useState("600");      // seconds; 0 = good till cancelled
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const bid = book?.bids.px[0]; const ask = book?.asks.px[0];
  const spreadBps = bid && ask && ask > bid ? Number(((ask - bid) * 10000n) / ((ask + bid) / 2n)) : null;
  const n = Math.max(0, Math.min(16, Math.floor(Number(levels) || 0)));
  const sizeRaw = parseDecimal(clip, 8);

  const plan = useMemo(() => {
    if (!info || !mark || !sizeRaw || sizeRaw % info.lot !== 0n || n === 0) return [];
    const f = Number(first), s = Number(step);
    if (!(f > 0) || !(s >= 0)) return [];
    const out: { isBuy: boolean; price: bigint; level: number }[] = [];
    for (let i = 0; i < n; i++) {
      const bps = BigInt(Math.round((f + s * i) * 100)); // in 1/100 bp
      const off = (mark * bps) / 1_000_000n;
      out.push({ isBuy: true, price: ((mark - off) / info.tick) * info.tick, level: i + 1 });
      out.push({ isBuy: false, price: ((mark + off + info.tick - 1n) / info.tick) * info.tick, level: i + 1 });
    }
    return out;
  }, [info, mark, sizeRaw, n, first, step]);

  const notional = sizeRaw ? plan.reduce((a, q) => a + (q.price * sizeRaw) / 100_000_000n, 0n) : 0n;
  const problems: string[] = [];
  if (!w.address) problems.push("Connect a wallet first.");
  if (sizeRaw && info && sizeRaw % info.lot !== 0n) problems.push(`Size must be a multiple of ${formatFixed(info.lot, 8)} ${base}.`);
  if (sizeRaw && info && plan[0] && (plan[0].price * sizeRaw) / 100_000_000n < info.minNotional) problems.push(`Each order must be at least ${fmtUsd(info.minNotional)} USDC.`);
  if (orders.length + plan.length > MAX_OPEN) problems.push(`This would make ${orders.length + plan.length} open orders; a subaccount can hold ${MAX_OPEN}. Use another subaccount or cancel some first.`);
  if (acct && notional > acct.avail * 10n) problems.push("Resting notional is far above your available margin; some orders may be rejected.");
  if (info && sizeRaw && plan.length === 0 && n > 0) problems.push("Check the offsets and size.");

  const expiry = () => { const t = Math.floor(Number(ttl) || 0); return t > 0 ? BigInt(Math.floor(Date.now() / 1000) + t) : 0n; };

  async function placeAll(cancelFirst: boolean) {
    if (!w.address || !sizeRaw || busy) return;
    setBusy(true); setNote("");
    try {
      if (cancelFirst && orders.length) {
        const st = await send({ label: `Cancel all orders (subaccount ${w.sub})`, kind: "cancel", functionName: "cancelAll", args: [w.address, w.sub], trading: true });
        if (st !== "executed") { setNote("Stopped: the cancel did not go through."); return; }
      }
      let ok = 0;
      for (const q of plan) {
        const p = buildOrderParams({ market, isBuy: q.isBuy, price: q.price, size: sizeRaw, type: "limit", tif: post ? "PostOnly" : "GTC", reduceOnly: false, cloid: BigInt(Math.floor(Math.random() * 2 ** 52) + 1), expiry: expiry() });
        const st = await send({ label: `${post ? "Post-only" : "Limit"} ${q.isBuy ? "buy" : "sell"} ${fmtSize(sizeRaw)} ${base} @ ${fmtPrice(q.price)} (level ${q.level})`, kind: "place", unit: base, functionName: "placeOrder", args: [w.address, w.sub, p], trading: true });
        if (st !== "executed") { setNote(`Stopped after ${ok} of ${plan.length} orders: the next one did not go through (see the notification).`); return; }
        ok++;
      }
      setNote(`Placed ${ok} orders.`);
    } finally { setBusy(false); }
  }

  const cancelAll = () => w.address && send({ label: `Cancel all orders (subaccount ${w.sub})`, kind: "cancel", functionName: "cancelAll", args: [w.address, w.sub], trading: true });

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "24px 16px 64px", display: "grid", gap: 16 }}>
      <header style={{ display: "grid", gap: 4 }}>
        <Link href="/" className="btn link" style={{ justifySelf: "start" }}>Back to the terminal</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>Maker console</h1>
        <p className="hint" style={{ display: "block", margin: 0 }}>Place a ladder of resting quotes by hand and watch how the book and your account respond. Testnet only: free test USDC, simulated liquidity, unaudited contracts. Each order is an on-chain transaction that costs gas. Turn on a session key under Account to avoid a wallet prompt per order.</p>
      </header>

      <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }} aria-label="Market and account">
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <label>Market <select value={market} onChange={(e) => setMarket(Number(e.target.value))}>{MARKETS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label>Subaccount <select value={w.sub} onChange={(e) => w.setSub(Number(e.target.value))}>{SUBS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        </div>
        <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
          <span>Mark <b className="num">{mark ? fmtPrice(mark) : "-"}</b></span>
          <span>Best bid <b className="num">{bid ? fmtPrice(bid) : "-"}</b></span>
          <span>Best ask <b className="num">{ask ? fmtPrice(ask) : "-"}</b></span>
          <span>Spread <b className="num">{spreadBps === null ? "-" : `${spreadBps} bps`}</b></span>
          <span>Available <b className="num">{acct ? `${fmtUsd(acct.avail)} USDC` : "-"}</b></span>
          <span>Position <b className="num">{pos ? `${fmtSize(pos.size)} ${base}` : `0 ${base}`}</b></span>
        </div>
      </section>

      <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }} aria-label="Ladder">
        <h2 style={{ margin: 0, fontSize: 16 }}>Quote ladder around the mark</h2>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <label>Levels per side <input value={levels} onChange={(e) => setLevels(e.target.value)} inputMode="numeric" style={{ width: 70 }} /></label>
          <label>First level (bps from mark) <input value={first} onChange={(e) => setFirst(e.target.value)} inputMode="decimal" style={{ width: 80 }} /></label>
          <label>Step between levels (bps) <input value={step} onChange={(e) => setStep(e.target.value)} inputMode="decimal" style={{ width: 80 }} /></label>
          <label>Size per level ({base}) <input value={clip} onChange={(e) => setClip(e.target.value)} inputMode="decimal" style={{ width: 100 }} /></label>
          <label>Expire after (seconds, 0 = never) <input value={ttl} onChange={(e) => setTtl(e.target.value)} inputMode="numeric" style={{ width: 90 }} /></label>
          <label className="check"><input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} /> Post-only (reject instead of crossing)</label>
        </div>
        <table>
          <thead><tr><th>Level</th><th className="r">Bid</th><th className="r">Ask</th></tr></thead>
          <tbody>
            {Array.from({ length: n }, (_, i) => {
              const b = plan.find((q) => q.isBuy && q.level === i + 1); const a = plan.find((q) => !q.isBuy && q.level === i + 1);
              return <tr key={i}><td>{i + 1}</td><td className="r num">{b ? fmtPrice(b.price) : "-"}</td><td className="r num">{a ? fmtPrice(a.price) : "-"}</td></tr>;
            })}
            {n === 0 && <tr><td colSpan={3} className="hint">Set at least one level.</td></tr>}
          </tbody>
        </table>
        <p className="hint" style={{ display: "block", margin: 0 }}>{plan.length} orders, about {fmtUsd(notional)} USDC resting. {orders.length} already open on this subaccount (limit {MAX_OPEN}).</p>
        {problems.map((p) => <p key={p} className="hint" role="alert" style={{ display: "block", margin: 0, color: "var(--warn, #e0a030)" }}>{p}</p>)}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy || problems.length > 0 || plan.length === 0} onClick={() => placeAll(false)}>{busy ? "Working..." : `Place ${plan.length} orders`}</button>
          <button className="btn" disabled={busy || problems.length > 0 || plan.length === 0} onClick={() => placeAll(true)} title="Cancel everything on this subaccount first, then place the ladder at the current mark">Re-center on the mark</button>
        </div>
        {note && <p role="status" className="hint" style={{ display: "block", margin: 0 }}>{note}</p>}
      </section>

      <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }} aria-label="Open orders">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Your open orders on {name} (subaccount {w.sub})</h2>
          <button className="btn sm danger" disabled={!orders.length || !w.address} onClick={cancelAll}>Cancel all</button>
        </div>
        <table>
          <thead><tr><th>ID</th><th>Side</th><th className="r">Price</th><th className="r">Remaining</th><th /></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id.toString()}><td className="num">#{o.id.toString()}</td><td>{o.isBuy ? "Buy" : "Sell"}</td><td className="r num">{fmtPrice(o.price)}</td><td className="r num">{fmtSize(o.size)}</td>
                <td><button className="btn sm" onClick={() => send({ label: `Cancel order #${o.id}`, kind: "cancel", functionName: "cancelOrder", args: [o.id], trading: true })}>Cancel</button></td></tr>
            ))}
            {!orders.length && <tr><td colSpan={5} className="hint">No open orders on this market and subaccount.</td></tr>}
          </tbody>
        </table>
      </section>
      <Toasts />
    </main>
  );
}
