"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MARKETS } from "./config";
import { useBrand } from "@/brand/context";

export type OrderTab = "market" | "limit" | "advanced";
export type MobileTab = "chart" | "book" | "trade" | "positions";
export type View = "trade" | "markets" | "portfolio" | "activity" | "notifications";
interface AppState {
  touched: boolean; pick: { px: string; n: number } | null; setPick(px: string): void; market: number; setMarket(n: number): void; name: string; base: string;
  /** ticket state lives here so keyboard shortcuts, the footer and the mobile action bar can drive it */
  isBuy: boolean; setIsBuy(b: boolean): void; otab: OrderTab; setOtab(t: OrderTab): void;
  view: View; setView(v: View): void; ctab: "chart" | "book"; setCtab(t: "chart" | "book"): void; sheet: boolean; setSheet(b: boolean): void; mkt: "book" | "trades" | "info"; setMkt(t: "book" | "trades" | "info"): void;
  mtab: MobileTab; setMtab(t: MobileTab): void; sidetab: "trade" | "account"; setSidetab(t: "trade" | "account"): void;
}
const C = createContext<AppState | null>(null);
export const useApp = () => { const c = useContext(C); if (!c) throw new Error("AppProvider missing"); return c; };
export function AppProvider({ children }: { children: ReactNode }) {
  const { markets } = useBrand();
  const [market, setMarket] = useState<number>(markets[0]?.id ?? 0);
  const m = MARKETS[market];
  const [touched, setTouched] = useState(false);
  const [pick, setPickState] = useState<{ px: string; n: number } | null>(null);
  const [isBuy, setIsBuy] = useState(true);
  const [otab, setOtab] = useState<OrderTab>("limit");
  const [mtab, setMtab] = useState<MobileTab>("trade");
  const [view, setView] = useState<View>("trade");
  const [ctab, setCtab] = useState<"chart" | "book">("chart");
  const [sheet, setSheet] = useState(false);
  const [mkt, setMkt] = useState<"book" | "trades" | "info">("book");
  const [sidetab, setSidetab] = useState<"trade" | "account">("trade");
  useEffect(() => {
    const v = (e: Event) => { const d = (e as CustomEvent<View>).detail; if (d) setView(d); };
    const t = () => { setMtab("trade"); setSheet(true); };
    document.addEventListener("terminal:view", v); document.addEventListener("terminal:open-ticket", t);
    return () => { document.removeEventListener("terminal:view", v); document.removeEventListener("terminal:open-ticket", t); };
  }, []);
  return (
    <C.Provider value={{
      touched, pick, setPick: (px) => setPickState((p) => ({ px, n: (p?.n ?? 0) + 1 })), market, setMarket: (n: number) => { setTouched(true); setMarket(n); }, name: m.name, base: m.base,
      isBuy, setIsBuy, otab, setOtab, view, setView, ctab, setCtab, sheet, setSheet, mkt, setMkt, mtab, setMtab, sidetab, setSidetab,
    }}>{children}</C.Provider>
  );
}
