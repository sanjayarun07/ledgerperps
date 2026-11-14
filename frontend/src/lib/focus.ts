import type { ActionTarget } from "./messages";

export type FocusTarget = ActionTarget | "margin";

/** DOM anchors that toast actions / the guide jump to. Advanced <details> ancestors are opened so the target is visible. */
const ANCHOR: Record<FocusTarget, string> = {
  deposit: "deposit-input", size: "sz", price: "px", orders: "section-portfolio", positions: "section-portfolio", withdraw: "withdraw-input",
  session: "section-session", margin: "adv-margin", glossary: "glossary-btn", poke: "poke-btn",
};
const click = (sel: string) => document.querySelector<HTMLElement>(sel)?.click();
/** Reveal the right place first (mobile tab, right-hand Trade/Account tab, dock tab), then scroll to and highlight the anchor. */
export function focusTarget(t: FocusTarget) {
  if (typeof document === "undefined") return;
  let wait = 60;
  if (t === "size" || t === "price") { document.dispatchEvent(new CustomEvent("terminal:view", { detail: "trade" })); document.dispatchEvent(new CustomEvent("terminal:open-ticket")); wait = 140; }
  else if (t === "deposit" || t === "withdraw" || t === "session" || t === "margin") { document.dispatchEvent(new CustomEvent("terminal:open-account")); wait = 200; }
  else if (t === "orders" || t === "positions") { document.dispatchEvent(new CustomEvent("terminal:view", { detail: "trade" })); click('[data-mtab="positions"]'); wait = 120; }
  setTimeout(() => focusNow(t), wait);
}
function focusNow(t: FocusTarget) {
  if (t === "orders" || t === "positions") {
    const tab = [...document.querySelectorAll<HTMLButtonElement>("[data-portfolio-tab]")].find((b) => b.dataset.portfolioTab === (t === "orders" ? "Open orders" : "Positions"));
    tab?.click();
  }
  const el = document.getElementById(ANCHOR[t]);
  if (!el) return;
  let p: HTMLElement | null = el;
  while (p) { if (p instanceof HTMLDetailsElement) p.open = true; p = p.parentElement; }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) el.focus({ preventScroll: true });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
}
