"use client";
import { Icon } from "@/components/Icon";
import { useEffect } from "react";
import { focusTarget } from "@/lib/focus";
import { shortAddr } from "@/lib/units";
import { useTx, type TxEntry } from "@/lib/tx";
import { useUi } from "@/components/ui";
import { lifecycle } from "@/lib/lifecycle";

/** The five visible stages. Nothing is ever shown as done before the receipt says so (no optimistic UI). */
export const STAGES = ["Waiting for wallet", "Sent", "Included in block", "Confirmed on-chain"] as const;
export function stageIndex(t: TxEntry): { cur: number; failedAt: number | null } {
  switch (t.state) {
    case "signing": return { cur: 0, failedAt: null };
    case "submitted": return { cur: 1, failedAt: null };
    case "included": return { cur: 2, failedAt: null };
    case "executed": return { cur: 4, failedAt: null };
    case "reverted": return { cur: 2, failedAt: 3 };
    case "failed": return { cur: 0, failedAt: t.hash ? 3 : 1 };
  }
}
export const stateText = (t: TxEntry) => t.state === "executed" ? "Confirmed on-chain" : t.state === "reverted" ? "Failed on-chain" : t.state === "failed" ? "Failed" : t.state === "signing" ? "Waiting for wallet" : t.state === "submitted" ? "Sent" : "Included in block";

export function Stages({ t }: { t: TxEntry }) {
  const { cur, failedAt } = stageIndex(t);
  return (
    <ol className="stages" aria-label={`Progress: ${stateText(t)}`} style={{ listStyle: "none", padding: 0 }}>
      {STAGES.map((s, i) => {
        const bad = failedAt === i, done = i < cur && !bad, now = i === cur && failedAt === null && cur < 4;
        const label = bad ? (i === 3 ? "Failed" : "Not sent") : i === 3 && t.state === "executed" ? "Confirmed" : s.replace(" on-chain", "").replace(" for wallet", " wallet");
        return <li key={s} className={`stage ${bad ? "bad" : done || (i === 3 && t.state === "executed") ? "done" : now ? "cur" : ""}`}>{label}</li>;
      })}
    </ol>
  );
}

export function TxBody({ t, compact }: { t: TxEntry; compact?: boolean }) {
  return (
    <>
      <Stages t={t} />
      {t.hash && <small className="num">tx {shortAddr(t.hash)}{t.block ? ` · block ${t.block.toString()}` : ""}{t.gasUsed ? ` · gas ${t.gasUsed}` : ""}</small>}
      {t.state === "executed" && <small className="long">Confirmed on-chain: the receipt succeeded and the events below are the canonical result.</small>}
      {t.events.map((e, i) => <span key={i} className="ev">{e}</span>)}
      {t.state === "executed" && t.events.length === 0 && !compact && <small>Confirmed. No exchange events (token-level or native transfer).</small>}
      {t.error && <FriendlyBlock t={t} />}
    </>
  );
}
function FriendlyBlock({ t }: { t: TxEntry }) {
  const f = t.error!;
  const { openGlossary } = useUi();
  return (
    <div className="ferr" role="alert">
      <b>{f.title}</b>
      <span>{f.detail}</span>
      {f.actions.length > 0 && (
        <div className="acts">{f.actions.map((a) => <button key={a.label} className="btn sm" onClick={() => (a.target === "glossary" ? openGlossary() : focusTarget(a.target))}>{a.label}</button>)}</div>
      )}
    </div>
  );
}

/** Toasts: the newest few transactions, each moving through the explicit stages. Successes and failures fade after a while; the Activity log keeps everything. */
export default function Toasts() {
  const { txs, dismiss } = useTx();
  const { setDrawer } = useUi();
  useEffect(() => {
    // successes fade after 9 s, failures after 30 s; everything stays in the Activity log
    const timers = txs.filter((t) => (t.state === "executed" || t.state === "failed" || t.state === "reverted") && !t.dismissed).map((t) => setTimeout(() => dismiss(t.id), t.state === "executed" ? 9000 : 30000));
    return () => timers.forEach(clearTimeout);
  }, [txs, dismiss]);
  const shown = txs.filter((t) => !t.dismissed).slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className="toasts" role="region" aria-label="Transaction notifications" aria-live="polite">
      {shown.map((t) => (
        <div key={t.id} className={`toast ${t.state}`}>
          <div className="toast-top"><b>{phrase(t).headline}</b><button className="x" aria-label={`Dismiss: ${t.label}`} onClick={() => dismiss(t.id)}><Icon name="x" size={14} /></button></div>
          {t.error ? <FriendlyBlock t={t} /> : <span className="nextstep">{phrase(t).detail}</span>}
          <span className="nextstep txline">{phrase(t).tx}</span>
          <Stages t={t} />
          {txs.length > 1 && <button className="btn link" style={{ fontSize: 12, marginTop: 4, justifySelf: "start" }} onClick={() => setDrawer("activity")}>All activity</button>}
        </div>
      ))}
    </div>
  );
}

const phrase = (t: TxEntry) => lifecycle({ kind: t.kind, state: t.state, outcome: t.outcome, unit: t.unit, block: t.block, label: t.label });
