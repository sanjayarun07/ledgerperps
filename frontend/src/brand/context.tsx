"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { disclaimerText, type BrandConfig } from "./schema";
import { NETWORK } from "@/lib/config";
import { dockTabs, navLinks, ticketOptions, visibleMarkets } from "./gate";

interface BrandCtx { brand: BrandConfig; real: boolean }
const Ctx = createContext<BrandCtx | null>(null);
export function BrandProvider({ brand, real, children }: { brand: BrandConfig; real: boolean; children: ReactNode }) {
  return <Ctx.Provider value={{ brand, real }}>{children}</Ctx.Provider>;
}
export function useBrand() {
  const c = useContext(Ctx);
  if (!c) throw new Error("BrandProvider missing");
  const { brand, real } = c;
  return useMemo(() => ({
    brand, features: brand.features, markets: visibleMarkets(brand.markets.order), dockTabs: dockTabs(brand.features), nav: navLinks(brand.features), ticket: ticketOptions(brand.features),
    banner: disclaimerText(brand, real, NETWORK), real, collateral: brand.integrations.collateral,
  }), [brand, real]);
}
/** Track an analytics event. No-op unless the tenant enabled analytics AND set an endpoint; sends only the event name. */
export function track(brand: BrandConfig, event: string) {
  const a = brand.integrations.analytics;
  if (!a.enabled || !a.endpoint || typeof navigator === "undefined") return;
  try { navigator.sendBeacon(a.endpoint, JSON.stringify({ event })); } catch { /* ignore */ }
}
