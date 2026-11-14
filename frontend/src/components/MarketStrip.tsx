"use client";
import { useApp } from "@/lib/app";
import { useBrand } from "@/brand/context";
import { MARKETS } from "@/lib/config";
import { useStats24h } from "@/lib/queries";
import { Tri } from "@/components/Icon";

function Chip({ id }: { id: number }) {
  const { market, setMarket } = useApp();
  const { stats } = useStats24h(id);
  const m = MARKETS[id];
  const pct = stats?.changePct ?? null;
  return (
    <button type="button" className={`mchip ${id === market ? "on" : ""}`} aria-pressed={id === market} onClick={() => setMarket(id)}
      aria-label={`${m.name}${pct === null ? ", 24 hour change unavailable" : `, ${pct.toFixed(2)} percent over 24 hours`}. Switch to this market`}>
      <span className="coin" aria-hidden>{m.base.slice(0, 1)}</span><span>{m.base}</span>
      <span className={`pct num ${pct === null ? "mute" : pct >= 0 ? "long" : "short"}`}>{pct === null ? "-" : <><Tri up={pct >= 0} size={7} />{Math.abs(pct).toFixed(2)}%</>}</span>
    </button>
  );
}

/** Market switcher strip above the pair header: one chip per market with its 24h change. */
export default function MarketStrip() {
  const { markets } = useBrand();
  return <div className="mstrip" role="toolbar" aria-label="Markets">{markets.map((m) => <Chip key={m.id} id={m.id} />)}</div>;
}
