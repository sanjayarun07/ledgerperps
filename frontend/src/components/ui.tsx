"use client";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";
import { useBrand } from "@/brand/context";

/** Cross-component UI state: which drawer is open and whether the first-run tour is showing. */
type Drawer = "glossary" | "activity" | "shortcuts" | "palette" | "account" | "menu" | null;
interface UiState { theme: "dark" | "light"; toggleTheme(): void; drawer: Drawer; setDrawer(d: Drawer): void; tour: boolean; setTour(b: boolean): void; welcome: boolean; setWelcome(b: boolean): void; glossaryFocus: GlossaryKey | null; openGlossary(k?: GlossaryKey): void }
const Ui = createContext<UiState | null>(null);
export const useUi = () => { const c = useContext(Ui); if (!c) throw new Error("UiProvider missing"); return c; };
export function UiProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<Drawer>(null);
  const { brand } = useBrand();
  const [theme, setTheme] = useState<"dark" | "light">(brand.defaultTheme === "light" ? "light" : "dark");
  useEffect(() => { try { const t = localStorage.getItem("terminal.theme"); if (t === "light" || t === "dark") setTheme(t); else if (brand.defaultTheme === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches) setTheme("light"); } catch { /* ignore */ } }, [brand.defaultTheme]);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem("terminal.theme", theme); } catch { /* ignore */ } }, [theme]);
  useEffect(() => { const f = () => setDrawer("account"); document.addEventListener("terminal:open-account", f); return () => document.removeEventListener("terminal:open-account", f); }, []);
  const [tour, setTour] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [glossaryFocus, setGF] = useState<GlossaryKey | null>(null);
  return <Ui.Provider value={{ theme, toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")), drawer, setDrawer, tour, setTour, welcome, setWelcome, glossaryFocus, openGlossary: (k) => { setGF(k ?? null); setDrawer("glossary"); } }}>{children}</Ui.Provider>;
}

/** Info tooltip: a focusable "i" button that opens a short plain-language definition (hover, focus, tap; Escape closes). */
export function Tip({ k, align, children }: { k: GlossaryKey; align?: "left" | "right" | "mid"; children?: ReactNode }) {
  const g = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const { openGlossary } = useUi();
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  return (
    <span className="tipwrap" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={children ? "term-btn" : "tip"} aria-label={children ? undefined : `What is ${g.term}?`} aria-expanded={open} aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>{children ?? "i"}</button>
      {open && (
        <span role="tooltip" id={id} className={`tippop ${align ?? ""}`}>
          <b>{g.term}</b>{g.def}
          <button type="button" className="btn link" style={{ display: "block", marginTop: 4, fontSize: 11 }} onClick={() => { setOpen(false); openGlossary(k); }}>Open glossary</button>
        </span>
      )}
    </span>
  );
}

/** Label + tooltip, used above inputs and in key/value rows. */
export function Label({ text, tip, htmlFor, align }: { text: string; tip?: GlossaryKey; htmlFor?: string; align?: "left" | "right" }) {
  // a <label> cannot live inside the tooltip button, so labelled inputs get a dotted underline and a native title with the definition
  if (htmlFor) return <span className="lbl"><label htmlFor={htmlFor} className={tip ? "termlbl" : undefined} title={tip ? `${GLOSSARY[tip].term}: ${GLOSSARY[tip].def}` : undefined}>{text}</label></span>;
  return <span className="lbl">{tip ? <Tip k={tip} align={align}>{text}</Tip> : text}</span>;
}
export function Row({ label, tip, children, align }: { label: string; tip?: GlossaryKey; children: ReactNode; align?: "left" | "right" }) {
  return <div className="kv"><span>{tip ? <Tip k={tip} align={align}>{label}</Tip> : label}</span><span className="num">{children}</span></div>;
}

export function Skel({ w = 56 }: { w?: number }) { return <span className="skel" style={{ minWidth: w }} aria-hidden />; }
/** Shows a skeleton while a value is loading. */
export function Val({ v, w }: { v: ReactNode | undefined | null; w?: number }) { return v === undefined || v === null ? <><Skel w={w} /><span className="sr">Loading</span></> : <>{v}</>; }

export function Field({ label, tip, value, onChange, suffix, ph, id, error, help, children }: { label: string; tip?: GlossaryKey; value: string; onChange: (s: string) => void; suffix?: ReactNode; ph?: string; id: string; error?: boolean; help?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`field ${error ? "has-err" : ""}`}><Label text={label} tip={tip} htmlFor={id} />
      <div className={`inp ${error ? "bad" : ""}`}><input id={id} inputMode="decimal" value={value} placeholder={ph} aria-invalid={error || undefined} onChange={(e) => onChange(e.target.value)} autoComplete="off" />{suffix && (typeof suffix === "string" ? <em>{suffix}</em> : <span style={{ paddingRight: 4 }}>{suffix}</span>)}</div>
      {help && <div className="hint">{help}</div>}{children}
    </div>
  );
}

export function Advanced({ title, hint, children, id }: { title: string; hint?: string; children: ReactNode; id?: string }) {
  return <details className="adv" id={id}><summary>{title}{hint && <span className="tag">{hint}</span>}</summary>{children}</details>;
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty"><b>{title}</b><p>{body}</p>{action && <div style={{ marginTop: 8 }}>{action}</div>}</div>;
}
