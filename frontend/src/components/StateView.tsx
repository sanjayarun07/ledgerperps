"use client";
import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { describeState, type ViewState } from "@/lib/stateView";

/** The one component for loading / empty / disconnected / pending / failed / stale / restricted. Tone is always paired with an icon glyph and words. */
const GLYPH = { neutral: "circle", info: "info", warn: "alert", bad: "x" } as const;
export default function StateView({ state, subject, action, compact, title, body }: { state: ViewState; subject?: string; action?: ReactNode; compact?: boolean; title?: string; body?: string }) {
  const c = describeState(state, subject);
  return (
    <div className={`stateview ${c.tone}${compact ? " compact" : ""}`} role={c.role} data-state={state}>
      {state === "loading" ? <span className="skel" style={{ width: 120, height: 10 }} aria-hidden /> : <span className="sv-ic" aria-hidden><Icon name={GLYPH[c.tone]} size={20} /></span>}
      <b>{title ?? c.title}</b>
      <p>{body ?? c.body}</p>
      {action}
    </div>
  );
}
