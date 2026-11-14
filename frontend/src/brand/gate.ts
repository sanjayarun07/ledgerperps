import { MARKETS } from "@/lib/config";
import type { Features } from "./schema";

/** Pure gating helpers: components render exactly what these return, so a disabled feature leaves no dead link, tab or option. */
export type DockTab = "Positions" | "Open orders" | "Balances" | "Order history" | "Trades" | "Funding" | "TWAPs" | "Conditionals" | "Transfers" | "Activity";
export function dockTabs(f: Features): DockTab[] {
  const all: [DockTab, boolean][] = [["Positions", true], ["Open orders", true], ["Balances", true], ["Order history", true], ["Trades", true], ["Funding", true], ["TWAPs", f.twap], ["Conditionals", f.conditionals], ["Transfers", true], ["Activity", true]];
  return all.filter(([, on]) => on).map(([t]) => t);
}
export type NavLink = "trade" | "markets" | "portfolio" | "activity";
/** Trade / Markets / Portfolio / Activity exist in every tenant; optional destinations (leaderboard, explore) have no pages yet, so no link is ever rendered for them. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const navLinks = (_f: Features): NavLink[] => ["trade", "markets", "portfolio", "activity"];
export interface TicketOptions { advancedTab: boolean; tpsl: boolean; twap: boolean; signedRelay: boolean; isolated: boolean; sessionKeys: boolean; subaccounts: boolean }
export const ticketOptions = (f: Features): TicketOptions => ({ advancedTab: f.advancedTab, tpsl: f.conditionals, twap: f.twap && f.advancedTab, signedRelay: f.signedRelay && f.advancedTab, isolated: f.isolatedMargin, sessionKeys: f.agentKeys, subaccounts: f.subaccounts });
/** Ordered, filtered market list from the tenant's `markets.order` (unknown ids are dropped). */
export function visibleMarkets(order: readonly number[]) {
  const out = order.map((id) => MARKETS.find((m) => m.id === id)).filter((m): m is (typeof MARKETS)[number] => !!m);
  return out.length ? out : [...MARKETS];
}
