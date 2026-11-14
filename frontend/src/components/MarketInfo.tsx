"use client";
import { Tri } from "@/components/Icon";
import { useApp } from "@/lib/app";
import { MARKETS } from "@/lib/config";
import { useFunding, useIndexPrice, useMarketInfo, useMark, useStats24h, useSystem } from "@/lib/queries";
import { allowedActions } from "@/lib/marketRules";
import { fmtDuration, fmtPrice, fmtRatePct, formatFixed, fmtUsd } from "@/lib/units";
import { maxLeverageFromImr } from "@/lib/risk";
import { MARKET_STATES } from "@/lib/order";
import { useChainClock } from "@/lib/queries";

/** Market facts and trading limits, plus what the market's current state allows. Used as the mobile "Info" tab and the Markets screen drawer. */
export default function MarketInfo({ market: id }: { market?: number }) {
  const app = useApp();
  const market = id ?? app.market;
  const m = MARKETS[market];
  const info = useMarketInfo(market).data;
  const mark = useMark(market).data;
  const index = useIndexPrice(market).data;
  const fund = useFunding(market).data;
  const clock = useChainClock();
  const sys = useSystem().data;
  const s24 = useStats24h(market).stats;
  const sm = sys?.markets.find((x) => x.id === market);
  const rules = allowedActions({ state: sm?.state ?? 0, globalPaused: sys?.globalPaused, oracleOk: sm?.oracleOk, name: m.name });
  const next = fund ? fund.lastFunding + fund.interval : 0;
  return (
    <div className="panel infopanel" aria-label={`${m.name} market information`}>
      <h3>{m.name} <span className="tagpill">Perpetual</span></h3>
      {rules.notice && <p className={`callout ${rules.tone === "bad" ? "bad" : rules.tone === "info" ? "info" : "warn"}`}>{rules.notice}</p>}
      <div className="kvl one">
        <div className="kv"><span>Status</span><span>{info ? MARKET_STATES[info.state] : "-"}</span></div>
        <div className="kv"><span>Mark price</span><span className="num">{mark ? fmtPrice(mark) : "-"}</span></div>
        <div className="kv"><span>Index price</span><span className="num">{index ? fmtPrice(index) : "-"}</span></div>
        <div className="kv"><span>24h change</span><span className={`num ${s24 && s24.changePct !== null ? (s24.changePct >= 0 ? "long" : "short") : ""}`}>{s24 && s24.changePct !== null ? <><Tri up={s24.changePct >= 0} />{Math.abs(s24.changePct).toFixed(2)}%</> : <span title="Needs trade history">-</span>}</span></div>
        <div className="kv"><span>Funding rate / countdown</span><span className="num">{fund ? `${fmtRatePct(fund.rate)} / ${next <= clock.now ? "due" : fmtDuration(next - clock.now)}` : "-"}</span></div>
        <div className="kv"><span>Open interest</span><span className="num">{info ? `${formatFixed(info.oi, 8, 3)} ${m.base}` : "-"}</span></div>
        <div className="kv"><span>Max leverage</span><span className="num">{info?.tiers[0] ? `${maxLeverageFromImr(info.tiers[0].imrBps)}x` : "-"}</span></div>
        <div className="kv"><span>Tick size</span><span className="num">{info ? `${formatFixed(info.tick, 6)} USDC` : "-"}</span></div>
        <div className="kv"><span>Lot size</span><span className="num">{info ? `${formatFixed(info.lot, 8)} ${m.base}` : "-"}</span></div>
        <div className="kv"><span>Min order value</span><span className="num">{info ? `${fmtUsd(info.minNotional)} USDC` : "-"}</span></div>
        <div className="kv"><span>Max order size</span><span className="num">{info ? `${formatFixed(info.maxOrderSize, 8, 4)} ${m.base}` : "-"}</span></div>
      </div>
    </div>
  );
}
