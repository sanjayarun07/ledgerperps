"use client";
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/lib/app";
import { getFeed, fallbackLog, onFallback } from "@/lib/data/indexer";
import { useIndexerStatus } from "@/lib/queries";
import { INDEXER_URL } from "@/lib/config";
import { useWallet } from "@/lib/wallet";

/**
 * Wires the indexer websocket to react-query: trade / order / fill / candle frames and (re)connects trigger REST refetches.
 * The ws protocol has no replay, so after an `open` or `resync` EVERYTHING history-shaped is refetched from REST.
 */
/** `DataBadge` (rendered by the header) makes it visible which data source is serving the page. */
export default function IndexerLive() {
  const qc = useQueryClient();
  const { market } = useApp();
  const { acct } = useWallet();
  const feed = getFeed();

  useEffect(() => {
    if (!feed) return;
    const offs = [feed.subscribe({ channel: "trades", market })];
    if (acct) { offs.push(feed.subscribe({ channel: "orders", acct }), feed.subscribe({ channel: "fills", acct })); }
    const inv = (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    const off = feed.onMessage((m) => {
      switch (m.type) {
        case "trade": inv("trades", "candles", "market", "funding"); break;
        case "order": inv("orders", "orderhist", "account", "positions", "conds", "twaps"); break;
        case "fill": inv("userfills", "posstats", "orders", "orderhist", "account", "positions"); break;
        case "open": case "resync": qc.invalidateQueries(); break;
        default: break;
      }
    });
    return () => { off(); offs.forEach((f) => f()); };
  }, [feed, market, acct, qc]);

  return null;
}

export function DataBadge() {
  const feed = getFeed();
  const st = useIndexerStatus().data;
  const ws = useSyncExternalStore((cb) => (feed ? feed.onBook(cb) : () => {}), () => feed?.status ?? "idle", () => "idle");
  const fb = useSyncExternalStore(onFallback, () => fallbackLog.at, () => 0);
  // re-render when the ws status changes (cheap poll via the book subscription is not needed: status is read each render of the 3s status query)
  if (!INDEXER_URL) return <span className="chip" title="NEXT_PUBLIC_INDEXER_URL is unset: every number is read from the chain (incremental log window)">data: chain only</span>;
  const down = !st?.ok;
  const recent = fb && Date.now() - fb < 15_000;
  const text = down ? "indexer unreachable → chain fallback" : `indexer ${st?.synced ? "synced" : "lagging"}${st?.lagBlocks ? ` (${st.lagBlocks} blk)` : ""} · ws ${ws}`;
  const title = down ? (st?.error ?? "") : `indexed block ${st?.indexedBlock ?? "-"}, chain head ${st?.chainHead ?? "-"}. Derived data, never authoritative.${recent ? ` Last fallback: ${fallbackLog.what} (${fallbackLog.why})` : ""}`;
  return <span className={`chip ${down || st?.halted ? "dev" : ""}`} title={title} role="status">{st?.halted ? `indexer HALTED: ${st.halted}` : text}</span>;
}
