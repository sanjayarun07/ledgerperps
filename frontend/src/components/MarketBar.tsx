"use client";
import { useApp } from "@/lib/app";
import { useBrand } from "@/brand/context";
import { MARKETS } from "@/lib/config";
import { useFunding, useIndexPrice, useMarketInfo, useMark, useChainClock, useStats24h } from "@/lib/queries";
import { fmtDuration, fmtPrice, fmtRatePct, formatFixed } from "@/lib/units";
import { MARKET_STATES } from "@/lib/order";
import { Tip, Val } from "@/components/ui";
import { Tri } from "@/components/Icon";

const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(2));
const Why = ({ text }: { text: string }) => <span className="dash" title={text} aria-label={`Not available: ${text}`}>-</span>;

/** Market header: pair selector, last price, then borderless stat columns. Anything we cannot compute shows a dash with the reason. */
export default function MarketBar() {
  const { market, setMarket } = useApp();
  const { markets } = useBrand();
  const mark = useMark(market);
  const index = useIndexPrice(market);
  const info = useMarketInfo(market);
  const fund = useFunding(market);
  const clock = useChainClock();
  const s24 = useStats24h(market);
  const now = clock.now;
  const next = fund.data ? fund.data.lastFunding + fund.data.interval : 0;
  const due = !!fund.data && next <= now;
  const m = MARKETS[market];
  const st = s24.stats;
  const up = (st?.change ?? 0) >= 0;
  const last = info.data?.lastTradePrice && info.data.lastTradePrice > 0n ? info.data.lastTradePrice : null;
  const px = last ?? mark.data ?? null;
  return (
    <section className="mbar" aria-label="Market summary">
      <label className="pair">
        <span className="coin" aria-hidden>{m.base.slice(0, 1)}</span>
        <select aria-label="Market" value={market} onChange={(e) => setMarket(Number(e.target.value))}>
          {markets.map((x) => <option key={x.id} value={x.id}>{x.name.replace("-", " / ")}</option>)}
        </select>
      </label>
      <span className="tagpill">Perpetual</span>
      <div className="bigprice num" aria-label="Last price">
        <Val v={px ? fmtPrice(px) : mark.isLoading ? undefined : "stale"} w={110} />
        <small>{last ? "Last trade" : "Mark (no trades yet)"}</small>
      </div>
      <div className="stats">
        <div className="stat"><small><Tip k="stats24">24h change</Tip></small>
          <b className={`num ${st ? (up ? "long" : "short") : "mute"}`}><Val v={s24.loading ? undefined : st ? <><Tri up={up} />{st.changePct === null ? "-" : `${Math.abs(st.changePct).toFixed(2)}%`}</> : <Why text="24h change needs trade history. Connect the indexer or wait for trades on this market." />} w={70} /></b></div>
        <div className="stat"><small><Tip k="mark">Mark</Tip></small><b className="num"><Val v={mark.data ? fmtPrice(mark.data) : mark.isLoading ? undefined : <Why text="The price feed is stale, so there is no mark price." />} w={80} /></b></div>
        <div className="stat"><small>Index</small><b className="num"><Val v={index.data ? fmtPrice(index.data) : index.isLoading ? undefined : <Why text="No fresh oracle price for this market right now." />} w={80} /></b></div>
        <div className="stat"><small><Tip k="funding">Funding / countdown</Tip></small>
          <b className="num"><Val v={fund.data ? <>{fmtRatePct(fund.data.rate)} / {due ? "due" : fmtDuration(next - now)}</> : undefined} w={130} /></b></div>
        <div className="stat"><small>Open interest</small><b className="num"><Val v={info.data ? `${formatFixed(info.data.oi, 8, 3)} ${m.base}` : undefined} w={90} /></b></div>
        <div className="stat hide-s"><small>24h volume</small><b className="num"><Val v={s24.loading ? undefined : st ? `${compact(st.volumeQuote)} USDC` : <Why text="24h volume needs trade history, which is not available yet." />} w={80} /></b></div>
        <div className="stat hide-s"><small>Status</small><b><Val v={info.data ? MARKET_STATES[info.data.state] : undefined} /></b></div>
      </div>
    </section>
  );
}
