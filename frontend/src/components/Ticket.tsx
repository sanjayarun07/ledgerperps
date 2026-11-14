"use client";
import { sizeTouched, tpslTouched } from "@/lib/touched";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApp, type OrderTab } from "@/lib/app";
import { publicClient } from "@/lib/client";
import { CHAIN_ID, DEMO_BANNER, DEMO_TAG, EXCHANGE, exchangeAbi, IS_LOCAL, MARKETS, NETWORK } from "@/lib/config";
import { switchLabel } from "@/lib/network";
import { buildOrderParams, slippagePrice, suggestSize, validateBracket, validateTicket, validateTwap, type TifName } from "@/lib/order";
import { quoteToBase, sizeFromPercent } from "@/lib/terminal";
import { allowedActions, canPlace } from "@/lib/marketRules";
import { impactBps, ticketAmounts, walkBook } from "@/lib/ticketMath";
import { useBrand } from "@/brand/context";
import { useAccountState, useBook, useChainClock, useMarketInfo, useMark, usePositions, useSystem } from "@/lib/queries";
import { effectiveLeverage, estimateLiqPrice, imrBpsFor, leverageWarning, mmrBpsFor, maxLeverageFromImr } from "@/lib/risk";
import { orderTypedData, placeSignedArgs, randomNonce } from "@/lib/signed";
import { useTx } from "@/lib/tx";
import { abs, fmtPrice, fmtSigned, fmtSize, fmtUsd, formatFixed, notionalCeil, notionalFloor, parseDecimal, shortAddr } from "@/lib/units";
import { useWallet } from "@/lib/wallet";
import { focusTarget } from "@/lib/focus";
import { Advanced, Field, Label, Row, Tip } from "@/components/ui";
import { Icon, Tri } from "@/components/Icon";

function useCtx() {
  const { market, base, name, pick, isBuy, setIsBuy, otab, setOtab } = useApp();
  const w = useWallet();
  const info = useMarketInfo(market).data;
  const mark = useMark(market).data ?? 0n;
  const book = useBook(market).data;
  const acct = useAccountState(w.acct).data;
  const pos = usePositions(w.acct).data?.find((p) => p.market === market);
  const sys = useSystem().data;
  const ms = sys?.markets.find((m) => m.id === market);
  return { market, base, name, pick, isBuy, setIsBuy, otab, setOtab, w, info, mark, book, acct, pos, ms, sys };
}

function Side({ isBuy, set }: { isBuy: boolean; set: (b: boolean) => void }) {
  return (
    <div className="sidebuy" role="group" aria-label="Direction">
      <button type="button" aria-pressed={isBuy} className={`b ${isBuy ? "on" : ""}`} onClick={() => set(true)}><Tri up />Buy / Long</button>
      <button type="button" aria-pressed={!isBuy} className={`s ${!isBuy ? "on" : ""}`} onClick={() => set(false)}><Tri up={false} />Sell / Short</button>
    </div>
  );
}

function useBlockedReason() {
  const { w } = useCtx();
  if (!w.address) return "Connect wallet to trade";
  if (w.wrongChain) return NETWORK.kind === "local" ? "Switch your wallet to the exchange network" : switchLabel(NETWORK);
  return null;
}

type Kind = "pass" | "fail" | "warn" | "na";
interface Check { kind: Kind; text: string; soft?: boolean; fix?: { label: string; run: () => void } }
const ICON: Record<Kind, string> = { pass: "check", fail: "alert", warn: "alert", na: "circle" };
const CLS: Record<Kind, string> = { pass: "pass", fail: "fail", warn: "warnrow", na: "na" };
function Checks({ items }: { items: Check[] }) {
  return (
    <ul className="checks" aria-label="Order checks">
      {items.map((c, i) => <li key={i} className={CLS[c.kind]}><span className="ic" aria-hidden><Icon name={ICON[c.kind]} size={11} /></span><span><span className="sr">{c.kind === "pass" ? "Passed: " : c.kind === "fail" ? "Problem: " : c.kind === "warn" ? "Warning: " : ""}</span>{c.text}{c.fix && <> <button type="button" className="btn link" onClick={c.fix.run}>{c.fix.label}</button></>}</span></li>)}
    </ul>
  );
}

function Popover({ label, children, chip }: { label: string; chip: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="tipwrap" style={{ position: "relative" }} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="chipbtn" aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>{chip}<Icon name="chevron" size={12} /></button>
      {open && <div className="panel pop" role="dialog" aria-label={label}>{children}<button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setOpen(false)}>Done</button></div>}
    </span>
  );
}

export default function Ticket() {
  const { name, isBuy, otab } = useApp();
  const { ticket } = useBrand();
  const adv = ticket.advancedTab;
  const tab = otab === "advanced" && !adv ? "limit" : otab;
  return (
    <div className={`panel ticket ${isBuy ? "side-buy" : "side-sell"}`} id="ticket" aria-labelledby="ticket-h">
      <h3 id="ticket-h" className="sr">Trade {name}</h3>
      <OrderForm tab={tab} />
      {tab === "advanced" && ticket.tpsl && <Advanced title="Take-profit / stop-loss on an existing position" hint="protect a position"><TpSl /></Advanced>}
      {tab === "advanced" && ticket.twap && <Advanced title="Split a big order over time (TWAP)" hint="advanced"><Twap /></Advanced>}
    </div>
  );
}

function OrderForm({ tab }: { tab: "market" | "limit" | "advanced" }) {
  const { market, base, name, pick, isBuy, setIsBuy, w, info, mark, book, acct, pos, ms, sys, setOtab } = useCtx();
  const { send } = useTx();
  const { ticket } = useBrand();
  const type: "limit" | "market" = tab === "market" ? "market" : "limit";
  const [price, setPrice] = useState("");
  const [sizeIn, setSizeIn] = useState("");
  const [unit, setUnit] = useState<"base" | "quote">("base");
  const [pct, setPct] = useState(0);
  const [levSel, setLevSel] = useState(1);
  const [tif, setTif] = useState<TifName>("GTC");
  const [post, setPost] = useState(false);
  const [ro, setRo] = useState(false);
  const [slip, setSlip] = useState(50);
  const [ack, setAck] = useState(false);
  const [withTpsl, setWithTpsl] = useState(false);
  const [tp, setTp] = useState(""); const [sl, setSl] = useState("");
  const blocked = useBlockedReason();
  const clock = useChainClock();
  const feeBps = useQuery({ queryKey: ["takerFee"], queryFn: () => publicClient.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "takerFeeBps" }) as Promise<number> });

  useEffect(() => { if (pick) setPrice(pick.px); }, [pick]);
  useEffect(() => { setPrice(""); setAck(false); setPct(0); setSizeIn(""); setTp(""); setSl(""); setWithTpsl(false); }, [market]);
  const advOpts = tab === "advanced"; // time-in-force / post-only / reduce-only live on the Advanced tab
  const tifEff: TifName = type === "limit" && post ? "PostOnly" : type === "limit" ? tif : "GTC";
  const roEff = advOpts && ro;

  const top = isBuy ? book?.asks.px[0] : book?.bids.px[0];
  const refPx0 = type === "limit" ? parseDecimal(price, 6) ?? mark : top ?? mark;
  const sizeBase = unit === "base" ? sizeIn : (() => { const q = parseDecimal(sizeIn, 6); const b = q && info ? quoteToBase(q, refPx0, info.lot) : null; return b ? formatFixed(b, 8) : ""; })();
  const size = sizeBase;
  const v = useMemo(() => info ? validateTicket({ type, isBuy, priceStr: price, sizeStr: size, tif: tifEff, reduceOnly: roEff, slippageBps: slip, refPrice: mark, bookTop: top, position: pos?.size ?? 0n }, { ...info, unit: base }) : null, [info, type, isBuy, price, size, tifEff, roEff, slip, mark, top, pos, base]);
  const touched = sizeTouched(sizeIn);
  const maxLev = info?.tiers[0] ? maxLeverageFromImr(info.tiers[0].imrBps) : 0;
  const ro2 = roEff;

  // ---- preview numbers (all estimates; the contract's check is authoritative) ----
  const cur = pos?.size ?? 0n;
  const newPos = cur + (v?.size ? (isBuy ? v.size : -v.size) : 0n);
  const refPx = v?.price ?? mark;
  const notional = v?.notional;
  const incNotional = refPx && v?.size ? (() => { const n = notionalCeil(newPos, refPx), o = notionalCeil(cur, refPx); return ro2 || n <= o ? 0n : n - o; })() : 0n;
  const imr = info && notional ? imrBpsFor(notionalCeil(newPos, refPx || 1n), info.tiers) : 0n;
  const margin = info && v?.size ? (incNotional * imr + 9999n) / 10000n : null;
  const fee = notional !== undefined && feeBps.data != null ? (notional * BigInt(feeBps.data) + 9999n) / 10000n : null;
  const lev = v?.price && acct && v.size ? effectiveLeverage(notionalCeil(newPos, v.price), pos?.isolated ? pos.iso.equity : acct.equity) : null;
  const liqAll = useMemo(() => {
    if (!info || !acct || !v?.size || !mark || newPos === 0n) return null;
    const mmrNew = mmrBpsFor(notionalCeil(newPos, mark), info.tiers), mmrOld = mmrBpsFor(notionalCeil(cur, mark), info.tiers);
    const oldMm = (notionalCeil(cur, mark) * mmrOld + 9999n) / 10000n;
    const equity = pos?.isolated ? pos.iso.equity : acct.equity;
    const mm = (pos?.isolated ? pos.iso.mm : acct.mm) - oldMm + (notionalCeil(newPos, mark) * mmrNew + 9999n) / 10000n;
    return { liq: estimateLiqPrice({ size: newPos, mark, equity, mm, mmrBps: mmrNew }), mm };
  }, [info, acct, v, mark, newPos, cur, pos]);
  const liq = liqAll?.liq ?? null;
  const newMm = liqAll?.mm ?? null;
  const maxLoss = liq && v?.size && refPx ? notionalFloor(abs(newPos), liq > refPx ? liq - refPx : refPx - liq) : null; // loss if the estimated liquidation price is reached
  const bookSide = (isBuy ? book?.asks : book?.bids);
  const walk = v?.size && bookSide ? walkBook(bookSide.px.map((p0, i) => ({ p: p0, s: bookSide.sz[i] })), v.size) : null;
  const estEntry = type === "market" ? walk?.avg ?? null : v?.price ?? null;
  const impact = type === "market" && walk ? impactBps(walk.avg, mark, isBuy) : null;
  const need = margin !== null && fee !== null && acct ? margin + fee : null;
  // isolated markets draw on their own margin, not on the shared pool
  const free = acct ? (pos?.isolated ? (pos.iso.margin > pos.iso.im + pos.iso.resv ? pos.iso.margin - pos.iso.im - pos.iso.resv : 0n) : acct.avail) : 0n;
  const amounts = notional !== undefined && imr !== undefined && fee !== null ? ticketAmounts({ orderNotional: notional, incNotional, imrBps: imr, fee, available: free }) : null;
  const shortfall = need !== null && acct && need > free ? need - free : 0n;
  const levWarn = leverageWarning(lev, maxLev);
  const highLev = lev !== null && lev >= Math.max(5, maxLev * 0.8);
  const slipWorst = type === "market" ? v?.price : undefined;

  // ---- inline TP/SL (second transaction after the order is Confirmed on-chain) ----
  const tpV = parseDecimal(tp, 6), slV = parseDecimal(sl, 6);
  const tpslErrs = withTpsl && info ? validateBracket({ isLong: isBuy, mark, tp: tpV ?? undefined, sl: slV ?? undefined, tick: info.tick }) : [];

  // ---- checks ----
  const checks: Check[] = [];
  if (v) {
    if (touched) for (const e of v.errors) checks.push({ kind: "fail", text: e });
  }
  const rules = allowedActions({ state: ms?.state ?? 0, globalPaused: sys?.globalPaused, oracleOk: ms?.oracleOk, name });
  const reducing = (isBuy && cur < 0n) || (!isBuy && cur > 0n);
  if (touched && v?.size) {
    const cp = canPlace(rules, reducing || ro2);
    if (!cp.ok) checks.push({ kind: "fail", soft: true, text: cp.why ?? `${name} is not accepting this order right now.` });
  } else if (touched && !rules.open) checks.push({ kind: "warn", text: rules.notice ?? "" });
  if (acct && v?.size && touched && margin !== null && fee !== null) {
    if (shortfall > 0n) checks.push({ kind: "fail", soft: true, text: `Not enough free margin: you need ${fmtUsd(shortfall)} USDC more (${pos?.isolated ? "free isolated margin" : "free"}: ${fmtUsd(free)}, needed: ${fmtUsd(margin + fee)}). ${pos?.isolated ? "Add isolated margin or reduce the size." : "Deposit more or reduce the size."}` });
  }
  if (levWarn && touched) checks.push({ kind: highLev && !ack ? "fail" : "warn", text: levWarn + (highLev && !ack ? " Tick the box below to confirm." : ""), soft: false });
  if (tpslTouched(withTpsl, tp, sl) || (withTpsl && touched)) for (const e of tpslErrs) checks.push({ kind: "fail", text: `TP/SL: ${e}` });
  const hardFail = checks.some((c) => c.kind === "fail" && !c.soft && !c.text.startsWith("High leverage"));
  const softFail = checks.some((c) => c.kind === "fail" && c.soft);
  const levBlocked = highLev && !ack;

  const sizeFix = (() => { const s = parseDecimal(size, 8); return info && s && s % info.lot !== 0n ? suggestSize(s, info.lot) : null; })();
  const priceFix = (() => { const p = parseDecimal(price, 6); return info && p && p % info.tick !== 0n ? ((p + info.tick / 2n) / info.tick) * info.tick : null; })();

  const checksF: Check[] = checks.map((c) => {
    if (c.kind !== "fail") return c;
    if (sizeFix !== null && /multiple of the lot/.test(c.text)) return { ...c, fix: { label: `Use ${formatFixed(sizeFix, 8, 4, 4)}`, run: () => { setUnit("base"); setSizeIn(formatFixed(sizeFix, 8)); } } };
    if (priceFix !== null && /multiple of the tick/.test(c.text)) return { ...c, fix: { label: `Use ${formatFixed(priceFix, 6, 2, 2)}`, run: () => setPrice(formatFixed(priceFix, 6)) } };
    return c;
  });
  const setFromPct = (p: number) => {
    setPct(p);
    if (!info || !acct) return;
    if (p === 0) { setSizeIn(""); return; }
    const maxBase = ro2 ? abs(cur) : undefined;
    const s = sizeFromPercent({ pct: p, avail: free, leverage: levSel, price: refPx0, lot: info.lot, maxBase });
    setSizeIn(s ? (unit === "base" ? formatFixed(s, 8) : formatFixed(notionalFloor(s, refPx0), 6, 2, 2)) : "");
  };

  const submit = () => {
    if (!v?.size || !v.price || !w.address) return;
    const p = buildOrderParams({ market, isBuy, price: v.price, size: v.size, type, tif: tifEff, reduceOnly: roEff });
    const desc = `${type === "market" ? "Market" : tifEff === "GTC" ? "Limit" : tifEff === "PostOnly" ? "Post-only limit" : `${tifEff} limit`} ${isBuy ? "buy" : "sell"} ${fmtSize(v.size)} ${base}`;
    const ctx = { shortfall: shortfall > 0n ? shortfall : margin !== null && fee !== null ? margin + fee : undefined, fmtUsd, market: name };
    const afterOk = (st: string) => {
      // TP/SL needs a position to protect, so it is a SECOND transaction, sent only after the order is Confirmed on-chain
      if (st !== "executed" || !withTpsl || !tpV || !slV || !info || !w.address) return;
      const sz = v.size!, closeBuy = !isBuy;
      send({ label: `Take-profit ${tp} / stop-loss ${sl} on ${base}`, functionName: "placeBracket", args: [w.address, w.sub, market, tpV, slippagePrice(tpV, closeBuy, 100, info.tick), slV, slippagePrice(slV, closeBuy, 100, info.tick), sz], trading: true });
    };
    if (ticket.signedRelay && w.useRelayer && w.relayerAccount) {
      // Sign in the browser (session key if enabled, else the owner wallet), submit from a DIFFERENT account (dev relayer).
      const owner = w.address, sub = w.sub, signerLabel = w.useAgentKey && w.agentAccount ? "session key" : "owner";
      send({
        label: `${desc} (signed by ${signerLabel}, relayed by ${shortAddr(w.relayerAccount.address)})`, functionName: "placeSigned", kind: "place", unit: base, relayer: true, ctx,
        prepare: async () => {
          const input = { owner, sub, p, nonce: randomNonce(), deadline: BigInt(clock.now + 300), chainId: CHAIN_ID, verifyingContract: EXCHANGE }; // deadline in CHAIN time
          const td = orderTypedData(input);
          const sig = w.useAgentKey && w.agentAccount ? await w.agentAccount.signTypedData(td) : await w.walletClient!.signTypedData({ ...td, account: owner });
          return placeSignedArgs(input, sig);
        },
      }).then(afterOk);
      return;
    }
    send({ label: desc, kind: "place", unit: base, functionName: "placeOrder", args: [w.address, w.sub, p], trading: true, ctx }).then(afterOk);
  };

  const canSubmit = !blocked && !!v?.ok && !hardFail && !softFail && !levBlocked;
  const noFunds = !!w.address && !!acct && acct.collateral === 0n;
  const sizeEmpty = !v?.size;
  const label = blocked ?? (noFunds ? "Deposit to trade" : sizeEmpty && !touched ? "Enter a size" : `${isBuy ? "Buy / Long" : "Sell / Short"} ${name}`);
  const guide = !!blocked || noFunds || (sizeEmpty && !touched);
  const onPrimary = () => { if (!w.address) document.getElementById("connect-btn")?.click(); else if (w.wrongChain) void w.switchChain(); else if (noFunds) focusTarget("deposit"); else if (sizeEmpty && !touched) focusTarget("size"); else submit(); };
  const liqSide = liq && mark ? (newPos > 0n ? liq < mark : liq > mark) : true;
  const modeChip = pos?.isolated ? "Isolated" : "Cross";

  return (
    <>
      {MARKETS[market]?.demo && <p className="callout warn" role="note" data-testid="demo-banner"><b>{DEMO_TAG}.</b> {DEMO_BANNER}</p>}
      <div className="chiprow" aria-label="Risk setup">
        <Popover label="Margin mode" chip={modeChip}>
          <p className="hint"><b>{modeChip}</b> margin on {name}. Cross shares one pool of collateral across positions; isolated gives this market its own margin, so the most you can lose on it is that margin.</p>
          {ticket.isolated ? <button type="button" className="btn sm" onClick={() => { focusTarget("margin"); }}>Change margin mode</button> : <p className="hint">Isolated margin is not offered here.</p>}
        </Popover>
        <Popover label="Leverage for the size slider" chip={`${levSel}x`}>
          <p className="hint">Leverage sizes the slider: size = percent of available margin x leverage. Higher leverage means a bigger position for the same collateral and a closer liquidation price.</p>
          <div className="quick">{[1, 2, 3, 5, 10].filter((x) => !maxLev || x <= maxLev).map((x) => <button key={x} type="button" className={`btn sm ${levSel === x ? "brand" : ""}`} aria-pressed={levSel === x} onClick={() => { setLevSel(x); setAck(false); }}>{x}x</button>)}</div>
        </Popover>
      </div>
      <div className="seg wide" role="tablist" aria-label="Order type">
        {(["market", "limit", ...(ticket.advancedTab ? ["advanced"] : [])] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setOtab(t as OrderTab)}>{t === "market" ? "Market" : t === "limit" ? "Limit" : "Advanced"}</button>)}
      </div>
      <Side isBuy={isBuy} set={setIsBuy} />
      <div className="kvl acctline">
        <Row label="Available to trade" tip="available">{acct ? `${fmtUsd(free)} USDC` : "-"}</Row>
        <Row label="Current position">{pos ? `${fmtSize(pos.size)} ${base}` : `0 ${base}`}</Row>
      </div>
      {type === "limit" && (
        <Field id="px" label="Limit price" tip="limit" value={price} onChange={setPrice} suffix="USDC" ph={mark ? formatFixed(mark, 6, 1, 1) : ""} error={touched && !!v && v.price === undefined}
          help={info ? `Steps of ${formatFixed(info.tick, 6)} USDC. Click a book price to fill it in.` : undefined} />
      )}
      <Field id="sz" label="Position size" value={sizeIn} onChange={(x) => { setSizeIn(x); setPct(0); }} suffix={<span className="seg" role="group" aria-label="Size unit"><button type="button" aria-pressed={unit === "base"} className={unit === "base" ? "on" : ""} onClick={() => { setUnit("base"); setSizeIn(size); }}>{base}</button><button type="button" aria-pressed={unit === "quote"} className={unit === "quote" ? "on" : ""} onClick={() => { setUnit("quote"); setSizeIn(v?.notional ? formatFixed(v.notional, 6, 2, 2) : ""); }}>USDC</button></span>} ph={unit === "base" ? "0.0010" : "100"} error={touched && !!v && v.size === undefined}
        help={info ? `Steps of ${formatFixed(info.lot, 8)} ${base}. Your position: ${pos ? fmtSize(pos.size) : "0"} ${base}.${unit === "quote" && size ? ` = ${size} ${base}` : ""}` : undefined} />
      <div className="slider">
        <label htmlFor="pct" className="sr">{`Size as percent of available margin at ${levSel}x`}</label>
        <input id="pct" type="range" min={0} max={100} step={1} value={pct} disabled={!acct || (acct && free <= 0n && !ro2)} aria-valuetext={`${pct} percent of available margin`} onChange={(e) => setFromPct(Number(e.target.value))} />
        <div className="chips" role="group" aria-label="Size shortcuts">{[25, 50, 75, 100].map((t) => <button key={t} type="button" className={`chip-btn ${pct === t ? "on" : ""}`} disabled={!acct} onClick={() => setFromPct(t)}>{t}%</button>)}</div>
      </div>
      {type === "market" ? (
        <div className="field"><Label text="Max slippage" tip="slippage" htmlFor="slip" />
          <div className="row">
            <div className="inp"><input id="slip" type="number" min={0} max={1000} value={slip} onChange={(e) => setSlip(Number(e.target.value))} /><em>bps ({(slip / 100).toFixed(2)}%)</em></div>
            {[10, 50, 100].map((s) => <button key={s} type="button" className="chip-btn" style={{ flex: "none" }} onClick={() => setSlip(s)}>{s / 100}%</button>)}
          </div>
        </div>
      ) : (
        <div className="row exec">
          <div className="field inline"><Label text="Time in force" tip="tif" htmlFor="tif" />
            <div className="inp"><select id="tif" value={post ? "GTC" : tif} disabled={post} onChange={(e) => setTif(e.target.value as TifName)} title="GTC: wait on the book until filled or canceled. IOC: fill what you can now, cancel the rest. FOK: fill everything now or fail.">
              <option value="GTC">GTC</option><option value="IOC">IOC</option><option value="FOK">FOK</option>
            </select></div>
          </div>
          <label className="check"><input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} /><Tip k="postonly">Post-only</Tip></label>
        </div>
      )}

      {advOpts && (
        <div className="advbox">
          <label className="check"><input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} /><Tip k="reduceonly">Reduce-only</Tip></label>
          {IS_LOCAL && ticket.signedRelay && w.relayerAccount && (
            <label className="check">
              <input type="checkbox" checked={w.useRelayer} onChange={(e) => w.setUseRelayer(e.target.checked)} /><Tip k="signed">Signed order</Tip>: sign here, another account ({shortAddr(w.relayerAccount.address)}) sends it
            </label>
          )}
        </div>
      )}

      {ticket.tpsl && (
        <div className="tpsl">
          <label className="switch"><input type="checkbox" role="switch" checked={withTpsl} onChange={(e) => setWithTpsl(e.target.checked)} /><span className="knob" aria-hidden /><Tip k="tpsl">Take-profit / stop-loss</Tip> <span className="mute">(optional)</span></label>
          {withTpsl && (
            <>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <Field id="tp" label="Take-profit price" value={tp} onChange={setTp} suffix="USDC" />
                <Field id="sl" label="Stop-loss price" value={sl} onChange={setSl} suffix="USDC" />
              </div>
              <p className="hint" style={{ display: "block" }}>Sent as a second transaction after this order is confirmed. Stops fire only when the price reaches them and may fill worse than the trigger: they are not guaranteed protection. Attached stops show &quot;not triggered yet&quot; until they actually fire.</p>
            </>
          )}
        </div>
      )}

        <details className="more ticket-details"><summary>Details <Icon name="chevron" size={12} /></summary>
          <div className="kvl">
            <Row label="Position notional" tip="perp">{amounts ? `${fmtUsd(amounts.positionNotional)} USDC` : "-"}</Row>
            <Row label="Collateral committed" tip="im">{amounts ? `${fmtUsd(amounts.collateral)} USDC` : "-"}</Row>
            <Row label="Available after" tip="available">{amounts ? <span className={amounts.availableAfter < 0n ? "short" : ""}>{fmtUsd(amounts.availableAfter)}</span> : "-"}</Row>
            <Row label="Account maintenance" tip="mm">{newMm !== null ? fmtUsd(newMm) : acct ? fmtUsd(acct.mm) : "-"}</Row>
            {type === "market" && <Row label="Price impact" tip="slippage">{impact === null ? "-" : `${impact.toFixed(1)} bps`}</Row>}
            {type === "market" && <Row label="Max slippage" tip="slippage">{`${(slip / 100).toFixed(2)}%`}</Row>}
            <Row label="Leverage after" tip="leverage">{lev !== null ? (lev > 0 && lev < 0.01 ? "<0.01x" : `${lev.toFixed(2)}x`) : "-"}</Row>
            <Row label="Max loss at liq." tip="liq">{maxLoss !== null ? `${fmtUsd(maxLoss)}` : "-"}</Row>
          </div>
          <p className="hint">Signed by {w.useRelayer && ticket.signedRelay ? "you, sent by the relayer" : w.useAgentKey ? "your session key" : "your wallet"}. Nothing is final until confirmed on-chain. All amounts in USDC.{!pos?.isolated && liq ? " *Cross estimate: depends on the rest of your account (other positions, balance, funding)." : ""}{type === "market" && slipWorst ? ` Fills at the best prices, never worse than ${fmtPrice(slipWorst)}.` : ""}</p>
        </details>
      <div className="submitbar">
      <div className="preview" aria-label="Order preview" aria-live="polite">
        <div className="kvl k4">
          <Row label="Est. entry" tip="limit">{estEntry ? fmtPrice(estEntry) : "-"}</Row>
          <Row label="Required margin" tip="im">{margin !== null ? `${fmtUsd(margin)}` : "-"}</Row>
          <Row label={pos?.isolated ? "Est. liquidation" : "Est. liquidation*"} tip="liq">{liq ? <span className={liqSide ? "" : "warn"}>{fmtPrice(liq)}</span> : newPos === 0n && v?.size ? "none" : "-"}</Row>
          <Row label="Fees" tip="fee">{fee !== null ? `${fmtUsd(fee)}` : "-"}</Row>
        </div>
        <Checks items={checksF} />
        {highLev && touched && (
          <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand this leverage can lose my whole margin quickly.</label>
        )}
      </div>
      <button className={`btn full primary ${guide ? "brand" : isBuy ? "buy" : "sell"}`} disabled={guide ? false : !canSubmit} onClick={onPrimary}>{guide ? null : <Tri up={isBuy} />}{label}</button>
      {softFail && !hardFail && !blocked && v?.ok && (
        <p className="hint">The checks above are estimates. <button type="button" className="btn link" onClick={submit}>Send anyway and read the exchange&apos;s answer</button></p>
      )}
      {shortfall > 0n && <div className="quick"><button type="button" className="btn sm" onClick={() => focusTarget("deposit")}>Deposit</button><button type="button" className="btn sm" onClick={() => focusTarget("size")}>Reduce size</button></div>}
      </div>
    </>
  );
}

function TpSl() {
  const { market, base, w, info, mark, pos } = useCtx();
  const { send } = useTx();
  const blocked = useBlockedReason();
  const [mode, setMode] = useState<"bracket" | "single">("bracket");
  const [tp, setTp] = useState(""); const [sl, setSl] = useState(""); const [size, setSize] = useState("");
  const [slip, setSlip] = useState(100);
  const [isBuy, setIsBuy] = useState(false); const [above, setAbove] = useState(true); const [trig, setTrig] = useState(""); const [ro, setRo] = useState(true);
  const long = (pos?.size ?? 0n) > 0n;
  const closeSide = !long; // buy to close a short
  const limitFor = (trigger: bigint, buy: boolean) => (info ? slippagePrice(trigger, buy, slip, info.tick) : 0n);
  const px = (s: bigint) => formatFixed(s, 6, 2, 2);

  const bracketErrs = (() => {
    if (!info || !pos || pos.size === 0n) return ["Open a position first: take-profit and stop-loss protect an existing position."];
    const t = parseDecimal(tp, 6) ?? undefined, s = parseDecimal(sl, 6) ?? undefined;
    const e = validateBracket({ isLong: long, mark, tp: t, sl: s, tick: info.tick });
    const sz = size ? parseDecimal(size, 8) : abs(pos.size);
    if (!sz || sz % info.lot !== 0n) e.push(`Size must be a multiple of ${formatFixed(info.lot, 8)} ${base}; try ${sz ? formatFixed(suggestSize(sz, info.lot), 8, 4, 4) : "0.0010"}`);
    else if (sz > abs(pos.size)) e.push(`Size is bigger than your position (${fmtSize(abs(pos.size))} ${base}); try ${fmtSize(abs(pos.size))}`);
    return e;
  })();
  const singleErrs = (() => {
    const e: string[] = [];
    const t = parseDecimal(trig, 6), sz = parseDecimal(size, 8);
    if (!t || t === 0n) e.push("Enter a trigger price in USDC"); else if (info && t % info.tick !== 0n) e.push(`Trigger must be a multiple of ${px(info.tick)} USDC`);
    if (!sz || (info && sz % info.lot !== 0n)) e.push(`Enter a size that is a multiple of ${info ? formatFixed(info.lot, 8) : "the lot"} ${base}`);
    return e;
  })();
  const sizeBn = size ? parseDecimal(size, 8) : pos ? abs(pos.size) : null;
  const pnlAt = (t: bigint | null) => (pos && pos.size !== 0n && t && sizeBn ? ((long ? 1n : -1n) * sizeBn * (t - pos.basis / pos.size)) / 100_000_000n : null);
  const tpPnl = pnlAt(parseDecimal(tp, 6)), slPnl = pnlAt(parseDecimal(sl, 6));

  const submitBracket = () => {
    if (!info || !pos || !w.address) return;
    const t = parseDecimal(tp, 6)!, s = parseDecimal(sl, 6)!;
    const sz = size ? parseDecimal(size, 8)! : abs(pos.size);
    send({ label: `Take-profit ${tp} / stop-loss ${sl} on ${base}`, functionName: "placeBracket", args: [w.address, w.sub, market, t, limitFor(t, closeSide), s, limitFor(s, closeSide), sz], trading: true });
  };
  const submitSingle = () => {
    if (!w.address) return;
    const t = parseDecimal(trig, 6)!, sz = parseDecimal(size, 8)!;
    send({ label: `Trigger order: ${isBuy ? "buy" : "sell"} ${base} when price ${above ? "rises to" : "falls to"} ${trig}`, functionName: "placeConditional", args: [w.address, w.sub, market, isBuy, above, t, limitFor(t, isBuy), sz, ro], trading: true });
  };
  const errs = mode === "bracket" ? bracketErrs : singleErrs;
  const started = !!(tp || sl || trig || size);

  return (
    <>
      <div className="field"><Label text="Kind" tip="tpsl" />
        <div className="seg" role="group" aria-label="Kind of trigger order">
          <button type="button" className={mode === "bracket" ? "on" : ""} aria-pressed={mode === "bracket"} onClick={() => setMode("bracket")}>Take-profit + stop-loss</button>
          <button type="button" className={mode === "single" ? "on" : ""} aria-pressed={mode === "single"} onClick={() => setMode("single")}>Single trigger</button>
        </div>
      </div>
      {mode === "bracket" ? (
        <>
          <p className="hint">Position: {pos ? fmtSize(pos.size) : "0"} {base}. Current price {mark ? px(mark) : "-"} USDC. When one of the two fires, the other is cancelled.</p>
          <Field id="tp" label="Take-profit price" value={tp} onChange={setTp} suffix="USDC" help={tpPnl !== null ? `If it fires you make about ${fmtSigned(tpPnl, 6, 2)} USDC.` : undefined} />
          <Field id="sl" label="Stop-loss price" value={sl} onChange={setSl} suffix="USDC" help={slPnl !== null ? `If it fires you ${slPnl < 0n ? "lose" : "make"} about ${fmtUsd(slPnl < 0n ? -slPnl : slPnl)} USDC.` : undefined} />
          <Field id="bsz" label="Size (empty = whole position)" value={size} onChange={setSize} suffix={base} />
        </>
      ) : (
        <>
          <Side isBuy={isBuy} set={setIsBuy} />
          <div className="seg" role="group" aria-label="Trigger direction" style={{ marginBottom: 8 }}><button type="button" className={above ? "on" : ""} onClick={() => setAbove(true)}>Price rises to</button><button type="button" className={!above ? "on" : ""} onClick={() => setAbove(false)}>Price falls to</button></div>
          <Field id="trig" label="Trigger price" value={trig} onChange={setTrig} suffix="USDC" />
          <Field id="ssz" label="Size" value={size} onChange={setSize} suffix={base} />
          <label className="check"><input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} />Reduce-only <Tip k="reduceonly" /></label>
        </>
      )}
      <div className="field"><Label text="Limit offset after trigger" tip="slippage" htmlFor="cslip" />
        <div className="inp"><input id="cslip" type="number" min={0} max={1000} value={slip} onChange={(e) => setSlip(Number(e.target.value))} /><em>bps</em></div>
        <div className="hint">When triggered, a limit order is sent this far beyond the trigger. It can miss in a fast market. A keeper (or anyone) fires it.</div>
      </div>
      {errs.length > 0 && started && <ul className="errs">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
      <button className="btn full brand" disabled={!!blocked || errs.length > 0} onClick={mode === "bracket" ? submitBracket : submitSingle}>
        {blocked ?? (mode === "bracket" ? "Place take-profit and stop-loss" : "Place trigger order")}
      </button>
    </>
  );
}

function Twap() {
  const { market, base, w, info, pos } = useCtx();
  const { send } = useTx();
  const blocked = useBlockedReason();
  const [isBuy, setIsBuy] = useState(true); const [size, setSize] = useState(""); const [slices, setSlices] = useState(5); const [interval, setIv] = useState(60); const [slip, setSlip] = useState(100); const [ro, setRo] = useState(false);
  const v = info ? validateTwap({ sizeStr: size, slices, intervalSecs: interval, slippageBps: slip }, info) : null;
  const submit = () => {
    if (!v?.ok || !v.size || !w.address) return;
    send({ label: `TWAP ${isBuy ? "buy" : "sell"} ${fmtSize(v.size)} ${base} in ${slices} slices`, functionName: "placeTwap", args: [w.address, w.sub, market, isBuy, v.size, slices, interval, slip, ro], trading: true });
  };
  return (
    <>
      <p className="hint">A TWAP splits one big order into equal slices over time to reduce price impact. <Tip k="twap" /></p>
      <Side isBuy={isBuy} set={setIsBuy} />
      <Field id="tsz" label="Total size" value={size} onChange={setSize} suffix={base} />
      <div className="row">
        <div className="field"><Label text="Slices" htmlFor="sl2" /><div className="inp"><input id="sl2" type="number" min={2} max={100} value={slices} onChange={(e) => setSlices(Number(e.target.value))} /></div></div>
        <div className="field"><Label text="Seconds between" htmlFor="iv" /><div className="inp"><input id="iv" type="number" min={1} value={interval} onChange={(e) => setIv(Number(e.target.value))} /><em>s</em></div></div>
      </div>
      <div className="field"><Label text="Max slippage per slice" tip="slippage" htmlFor="ts" /><div className="inp"><input id="ts" type="number" min={0} max={1000} value={slip} onChange={(e) => setSlip(Number(e.target.value))} /><em>bps</em></div></div>
      <label className="check"><input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} />Reduce-only {pos && pos.size !== 0n ? "" : "(you have no position)"} <Tip k="reduceonly" /></label>
      <p className="hint">Each slice runs when due (a keeper, or the Run slice button under Open orders).</p>
      {size && v && v.errors.length > 0 && <ul className="errs">{v.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <button className="btn full brand" disabled={!!blocked || !v?.ok} onClick={submit}>{blocked ?? "Start TWAP"}</button>
    </>
  );
}
