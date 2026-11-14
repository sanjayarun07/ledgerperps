"use client";
import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, CrosshairMode, LineStyle, HistogramSeries, LineSeries, PriceScaleMode, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from "lightweight-charts";
import { useApp } from "@/lib/app";
import { useCandles, useMark } from "@/lib/queries";
import { sma } from "@/lib/terminal";
import { usePositions } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { usePosView } from "@/components/Positions";
import { fmtPrice as fp } from "@/lib/units";
import type { PositionInfo } from "@/lib/data/types";
import { alpha } from "@/brand/color";
import { Icon, Tri } from "@/components/Icon";

const SPARSE = 5; // fewer candles than this: a single giant candle says nothing, so draw a line and explain
const IVS = [{ l: "1m", s: 60 }, { l: "5m", s: 300 }, { l: "15m", s: 900 }, { l: "1h", s: 3600 }, { l: "4h", s: 14400 }, { l: "1D", s: 86400 }];

/** Entry and estimated-liquidation lines for the selected market's open position. Both are labelled on the price axis. */
function PositionLines({ p, series, dep }: { p: PositionInfo; series: () => ISeriesApi<"Line" | "Candlestick"> | null; dep: number }) {
  const v = usePosView(p);
  const entry = Number(v.entry) / 1e6, liq = v.liq ? Number(v.liq) / 1e6 : null;
  useEffect(() => {
    const s = series(); if (!s) return;
    const css = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
    const lines: IPriceLine[] = [];
    lines.push(s.createPriceLine({ price: entry, color: css("--mute", "#999"), lineStyle: 3, lineWidth: 1, axisLabelVisible: true, title: `Entry ${p.size > 0n ? "▲" : "▼"}` }));
    if (liq !== null && liq > 0) lines.push(s.createPriceLine({ price: liq, color: css("--short", "#f07878"), lineStyle: 3, lineWidth: 1, axisLabelVisible: true, title: "Liq. (est.)" }));
    return () => { try { lines.forEach((l) => s.removePriceLine(l)); } catch { /* series replaced */ } };
  }, [entry, liq, dep, series, p.size]);
  return null;
}

export default function Chart() {
  const { market, name, setCtab } = useApp();
  const [iv, setIv] = useState(IVS[0]);
  const [showVol, setShowVol] = useState(true);
  const [showMa, setShowMa] = useState(false);
  const [log, setLog] = useState(false);
  const [menu, setMenu] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const ma = useRef<ISeriesApi<"Line"> | null>(null);
  const candles = useCandles(market, iv.s);
  const mark = useMark(market);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const cs = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vs = useRef<ISeriesApi<"Histogram"> | null>(null);
  const line = useRef<IPriceLine | null>(null);
  const fb = useRef<ISeriesApi<"Line"> | null>(null);
  const fbLineOwner = useRef<ISeriesApi<"Line" | "Candlestick"> | null>(null);
  const fitted = useRef<string>("");
  const [hover, setHover] = useState<{ o: number; h: number; l: number; c: number; v?: number } | null>(null);
  const w = useWallet();
  const pos = (usePositions(w.acct).data ?? []).find((p) => p.market === market && p.size !== 0n) ?? null;
  const disposeTheme = useRef<() => void>(() => {});

  useEffect(() => {
    if (!box.current) return;
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--mute"), fontFamily: css("--font"), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { style: LineStyle.Dashed, color: css("--faint"), labelBackgroundColor: css("--surface4") }, horzLine: { style: LineStyle.Dashed, color: css("--faint"), labelBackgroundColor: css("--surface4") } },
      rightPriceScale: { borderColor: css("--line"), scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false, maxBarSpacing: 14, rightOffset: 6, minBarSpacing: 3 },
    });
    cs.current = c.addSeries(CandlestickSeries, { upColor: alpha(css("--long"), .88), downColor: alpha(css("--short"), .88), borderVisible: true, borderUpColor: alpha(css("--long"), .95), borderDownColor: alpha(css("--short"), .95), wickUpColor: alpha(css("--long"), .8), wickDownColor: alpha(css("--short"), .8), priceLineVisible: false });
    vs.current = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", color: css("--faint"), lastValueVisible: false, priceLineVisible: false });
    fb.current = c.addSeries(LineSeries, { color: css("--brand"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, visible: false });
    // re-apply colours when the light/dark theme changes
    const mo = new MutationObserver(() => {
      c.applyOptions({ layout: { textColor: css("--mute") }, grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } }, rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") }, crosshair: { vertLine: { color: css("--faint"), labelBackgroundColor: css("--surface4") }, horzLine: { color: css("--faint"), labelBackgroundColor: css("--surface4") } } });
      cs.current?.applyOptions({ upColor: alpha(css("--long"), .88), downColor: alpha(css("--short"), .88), wickUpColor: alpha(css("--long"), .7), wickDownColor: alpha(css("--short"), .7) });
      fb.current?.applyOptions({ color: css("--brand") });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    disposeTheme.current = () => mo.disconnect();
    ma.current = c.addSeries(LineSeries, { color: css("--brand"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, visible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    c.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(cs.current as ISeriesApi<"Candlestick">) as { open: number; high: number; low: number; close: number } | undefined;
      setHover(d ? { o: d.open, h: d.high, l: d.low, c: d.close } : null);
    });
    chart.current = c;
    return () => { disposeTheme.current(); c.remove(); chart.current = null; cs.current = null; vs.current = null; ma.current = null; fb.current = null; line.current = null; };
  }, []);

  useEffect(() => {
    const d = candles.data ?? [];
    const sparse = d.length < SPARSE;
    cs.current?.applyOptions({ visible: !sparse });
    fb.current?.applyOptions({ visible: sparse && d.length > 0 });
    const mp = mark.data ? Number(mark.data) / 1e6 : null;
    fb.current?.applyOptions({ visible: sparse && (d.length > 0 || mp !== null) });
    fb.current?.setData(d.length ? d.map((x) => ({ time: x.time as UTCTimestamp, value: x.close })) : mp !== null ? [{ time: Math.floor(Date.now() / 1000) as UTCTimestamp, value: mp }] : []);
    cs.current?.setData(d.map((x) => ({ time: x.time as UTCTimestamp, open: x.open, high: x.high, low: x.low, close: x.close })));
    vs.current?.setData(d.map((x) => ({ time: x.time as UTCTimestamp, value: x.volume, color: alpha(getComputedStyle(document.documentElement).getPropertyValue(x.close >= x.open ? "--long" : "--short").trim() || "#888888", .28) })));
    const closes = d.map((x) => x.close), avg = sma(closes, 20);
    ma.current?.setData(d.flatMap((x, i) => (avg[i] === null ? [] : [{ time: x.time as UTCTimestamp, value: avg[i] as number }])));
    const key = `${market}-${iv.s}`;
    if (d.length && fitted.current !== key) { chart.current?.timeScale().fitContent(); fitted.current = key; }
  }, [candles.data, market, iv, mark.data]);

  useEffect(() => { vs.current?.applyOptions({ visible: showVol }); ma.current?.applyOptions({ visible: showMa }); }, [showVol, showMa]);
  useEffect(() => { chart.current?.priceScale("right").applyOptions({ mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal }); }, [log]);
  const nCandles = candles.data?.length ?? 0;
  useEffect(() => {
    const target = nCandles < SPARSE ? fb.current : cs.current;
    if (!target) return;
    if (line.current) { try { line.current.options(); fbLineOwner.current?.removePriceLine(line.current); } catch { /* series gone */ } line.current = null; }
    if (mark.data) { line.current = target.createPriceLine({ price: Number(mark.data) / 1e6, color: getComputedStyle(document.documentElement).getPropertyValue("--brand-fill").trim() || "#4285F4", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "" }); fbLineOwner.current = target; }
  }, [mark.data, market, nCandles]);

  const sparse = !!candles.data && candles.data.length < SPARSE;
  return (
    <div className="panel chartpanel" ref={panel} aria-label={`${name} price chart`}>
      <div className="phead chart-tools">
        <span className="seg ctab-switch" role="group" aria-label="Chart or order book"><button className="on" aria-pressed>Chart</button><button onClick={() => setCtab("book")}>Book</button></span>
        <span className="ttl">{name}</span>
        <span className="seg" role="group" aria-label="Candle length">{IVS.map((x) => <button key={x.l} aria-pressed={x.l === iv.l} className={x.l === iv.l ? "on" : ""} onClick={() => setIv(x)}>{x.l}</button>)}</span>
        <span className="tipwrap" style={{ position: "relative" }}>
          <button type="button" className="btn sm ghost" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu(!menu)} onKeyDown={(e) => { if (e.key === "Escape") setMenu(false); }}>Indicators</button>
          {menu && (
            <div className="panel pop" role="group" aria-label="Indicators">
              <label className="check"><input type="checkbox" checked={showVol} onChange={(e) => setShowVol(e.target.checked)} />Volume</label>
              <label className="check"><input type="checkbox" checked={showMa} onChange={(e) => setShowMa(e.target.checked)} />Moving average (20 candles)</label>
            </div>
          )}
        </span>
        <span className="sp" />
        <span className="seg" role="group" aria-label="Price scale"><button aria-pressed={!log} className={!log ? "on" : ""} onClick={() => setLog(false)}>Auto</button><button aria-pressed={log} className={log ? "on" : ""} onClick={() => setLog(true)}>Log</button></span>
        <button type="button" className="btn sm ghost iconsq" aria-label="Toggle fullscreen chart" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void panel.current?.requestFullscreen?.(); }}><Icon name="expand" size={14} /></button>
      </div>
      <div className="chart-box">
        <div ref={box} style={{ position: "absolute", inset: 0 }} />
        {pos && <PositionLines p={pos} dep={nCandles < SPARSE ? 0 : 1} series={() => (nCandles < SPARSE ? fb.current : cs.current)} />}
        {(() => { const last = candles.data?.at(-1); const r = hover ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close } : null); if (!r || sparse) return null; const d = r.c - r.o; return (
          <div className="ohlc num" aria-label="Candle values"><span><i>O</i>{fp(BigInt(Math.round(r.o * 1e6)))}</span><span><i>H</i>{fp(BigInt(Math.round(r.h * 1e6)))}</span><span><i>L</i>{fp(BigInt(Math.round(r.l * 1e6)))}</span><span><i>C</i>{fp(BigInt(Math.round(r.c * 1e6)))}</span><span className={d >= 0 ? "long" : "short"}><Tri up={d >= 0} size={7} />{Math.abs(d).toFixed(2)} ({r.o ? ((d / r.o) * 100).toFixed(2) : "0.00"}%)</span></div>); })()}
        {sparse && <div className="chart-note" role="status">{candles.data!.length === 0 ? `No trades on ${name} yet. Showing the mark price line.` : "Not enough trades yet to draw candles. Showing the price line."}</div>}
      </div>
    </div>
  );
}
