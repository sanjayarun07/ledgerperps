/** One vocabulary for every non-happy screen state. Pure, so the matrix is unit-tested. */
export type ViewState = "loading" | "empty" | "disconnected" | "pending" | "failed" | "stale-data" | "restricted-market";
export const VIEW_STATES: ViewState[] = ["loading", "empty", "disconnected", "pending", "failed", "stale-data", "restricted-market"];
export interface StateCopy { title: string; body: string; tone: "neutral" | "info" | "warn" | "bad"; /** ARIA live role: failures interrupt, everything else is polite */ role: "status" | "alert"; /** the verb of the one recovery action, if any */ action?: "connect" | "retry" | "refresh" | "view-rules" | "none" }
export function describeState(s: ViewState, subject = "this"): StateCopy {
  switch (s) {
    case "loading": return { title: `Loading ${subject}`, body: "Reading the latest data. Nothing has changed on your account.", tone: "neutral", role: "status", action: "none" };
    case "empty": return { title: `No ${subject} yet`, body: `When you have ${subject}, they appear here.`, tone: "neutral", role: "status", action: "none" };
    case "disconnected": return { title: "Connect a wallet", body: `Your ${subject} are tied to your wallet. Connecting does not move any funds.`, tone: "info", role: "status", action: "connect" };
    case "pending": return { title: `Waiting for confirmation`, body: `Your ${subject} change was sent. It counts only once it is confirmed on-chain.`, tone: "info", role: "status", action: "none" };
    case "failed": return { title: `Could not load ${subject}`, body: "The request failed. What you see may be out of date. Your positions are unaffected on-chain.", tone: "bad", role: "alert", action: "retry" };
    case "stale-data": return { title: "Data may be out of date", body: `The feed for ${subject} has stopped updating. Prices shown are the last known values, so check before you trade.`, tone: "warn", role: "status", action: "refresh" };
    case "restricted-market": return { title: "Trading is restricted in this market", body: "Some actions are blocked right now. Closing and canceling may still work: see the rules for this market state.", tone: "warn", role: "status", action: "view-rules" };
  }
}
