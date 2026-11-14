"use client";
import { useMemo, useState } from "react";
import { contrast } from "@/brand/color";
import { logoSrc } from "@/components/BrandBits";
import { BASE_BANNER, FONTS, NEUTRALS, RADII, DENSITIES, safeParseBrand, type BrandConfig } from "@/brand/schema";
import { deriveTheme } from "@/brand/theme";
import { visibleMarkets } from "@/brand/gate";
import { MARKETS } from "@/lib/config";

const FLAG_LABELS: Record<string, string> = { twap: "TWAP orders", conditionals: "Take-profit / stop-loss and triggers", isolatedMargin: "Isolated margin", signedRelay: "Signed orders / relayer", agentKeys: "Session keys", subaccounts: "Subaccounts", tour: "Welcome card and tour", advancedTab: "Advanced order tab", commandPalette: "Command palette (Ctrl/Cmd+K)", leaderboard: "Leaderboard (reserved, no page yet)", explore: "Explore (reserved, no page yet)", studio: "Brand Studio route" };
const MAX_LOGO = 100_000;

/** Operator tool. Nothing is written to disk or sent anywhere: Export is a browser download, Import reads a local file. */
export default function BrandStudio({ initial }: { initial: BrandConfig }) {
  const [cfg, setCfg] = useState<BrandConfig>(initial);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [msg, setMsg] = useState<string | null>(null);
  const check = useMemo(() => safeParseBrand(cfg), [cfg]);
  const valid = check.ok ? check.brand : initial;
  const t = useMemo(() => deriveTheme(valid), [valid]);
  const vars = theme === "dark" ? t.dark : t.light;
  const set = <K extends keyof BrandConfig>(k: K, v: BrandConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const ratio = check.ok ? contrast(vars["--brand-ink"], vars["--brand-fill"]) : null;

  const upload = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_LOGO) { setMsg(`Logo is ${(f.size / 1024).toFixed(0)} KB; the limit is ${MAX_LOGO / 1000} KB. Use a smaller image or an https URL.`); return; }
    if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(f.type)) { setMsg("Logo must be PNG, JPEG, WebP, GIF or SVG."); return; }
    const r = new FileReader(); r.onload = () => { set("logo", String(r.result)); setMsg("Logo loaded (kept in this page only until you export)."); }; r.readAsDataURL(f);
  };
  const exportJson = () => {
    const r = safeParseBrand(cfg);
    if (!r.ok) { setMsg(`Fix these first: ${r.issues.join("; ")}`); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.brand, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "brand.config.json"; a.click(); URL.revokeObjectURL(url);
    setMsg("Downloaded brand.config.json. Put it in tenants/<host>.json or merge it into brand.config.json.");
  };
  const importJson = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 250_000) { setMsg("That file is too large for a brand config."); return; }
    try {
      const r = safeParseBrand(JSON.parse(await f.text()));
      if (r.ok) { setCfg(r.brand); setMsg("Imported."); } else setMsg(`Not a valid brand config: ${r.issues.join("; ")}`);
    } catch { setMsg("That file is not valid JSON."); }
  };
  const markets = visibleMarkets(cfg.markets.order);
  const toggleMarket = (id: number) => set("markets", { order: cfg.markets.order.includes(id) ? cfg.markets.order.filter((x) => x !== id) : [...cfg.markets.order, id] });

  return (
    <div className="studio" style={{ padding: 16, display: "grid", gap: 16, gridTemplateColumns: "minmax(0,380px) minmax(0,1fr)", alignItems: "start" }}>
      <form className="panel" onSubmit={(e) => e.preventDefault()} aria-label="Brand settings">
        <h3>Brand Studio</h3>
        <p className="hint">Changes here only affect this page. Export the file to use it. Nothing is saved on a server.</p>
        <div className="field"><label htmlFor="b-name">Name</label><div className="inp"><input id="b-name" value={cfg.name} onChange={(e) => set("name", e.target.value)} /></div></div>
        <div className="field"><label htmlFor="b-short">Short name</label><div className="inp"><input id="b-short" value={cfg.shortName} onChange={(e) => set("shortName", e.target.value)} /></div></div>
        <div className="field"><label htmlFor="b-tag">Tagline</label><div className="inp"><input id="b-tag" value={cfg.tagline} onChange={(e) => set("tagline", e.target.value)} /></div></div>
        <div className="field"><label htmlFor="b-accent">Accent colour</label>
          <div className="row"><input id="b-accent" type="color" value={/^#[0-9a-f]{6}$/i.test(cfg.accent) ? cfg.accent : "#5b8cff"} onChange={(e) => set("accent", e.target.value)} aria-label="Accent colour picker" style={{ flex: "none", width: 48, height: 40 }} />
            <div className="inp"><input aria-label="Accent colour hex" value={cfg.accent} onChange={(e) => set("accent", e.target.value)} /></div></div></div>
        <div className="row wrap">
          {([["neutral", NEUTRALS], ["font", FONTS], ["radius", RADII], ["density", DENSITIES], ["defaultTheme", ["dark", "light", "system"]]] as const).map(([k, opts]) => (
            <div className="field" key={k}><label htmlFor={`b-${k}`}>{k === "defaultTheme" ? "Default theme" : k[0].toUpperCase() + k.slice(1)}</label>
              <div className="inp"><select id={`b-${k}`} value={cfg[k] as string} onChange={(e) => set(k, e.target.value as never)}>{opts.map((o) => <option key={o}>{o}</option>)}</select></div></div>
          ))}
        </div>
        <div className="field"><label htmlFor="b-logo">Logo (PNG, SVG, up to 100 KB)</label>
          <div className="row"><input id="b-logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={(e) => upload(e.target.files?.[0])} />{cfg.logo && <button type="button" className="btn sm" style={{ flex: "none" }} onClick={() => set("logo", undefined)}>Remove</button>}</div></div>
        <div className="field"><label htmlFor="b-extra">Extra disclaimer text (added after the mandatory notice)</label><div className="inp"><input id="b-extra" value={cfg.disclaimer.extra} onChange={(e) => set("disclaimer", { ...cfg.disclaimer, extra: e.target.value })} /></div></div>
        <div className="field"><label htmlFor="b-wt">Welcome title</label><div className="inp"><input id="b-wt" value={cfg.copy.welcomeTitle ?? ""} onChange={(e) => set("copy", { ...cfg.copy, welcomeTitle: e.target.value || undefined })} /></div></div>
        <h4>Markets shown</h4>
        <div className="row wrap">{MARKETS.map((m) => <label className="check" key={m.id}><input type="checkbox" checked={cfg.markets.order.includes(m.id)} onChange={() => toggleMarket(m.id)} />{m.name}</label>)}</div>
        <h4>Features</h4>
        {Object.keys(cfg.features).map((k) => <label className="check" key={k}><input type="checkbox" checked={cfg.features[k as keyof typeof cfg.features]} onChange={(e) => set("features", { ...cfg.features, [k]: e.target.checked })} />{FLAG_LABELS[k] ?? k}</label>)}
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="btn brand" onClick={exportJson}>Export brand.config.json</button>
          <label className="btn" style={{ textAlign: "center", cursor: "pointer" }}>Import<input type="file" accept="application/json,.json" className="sr" onChange={(e) => void importJson(e.target.files?.[0])} /></label>
        </div>
        {msg && <p className="hint" role="status">{msg}</p>}
      </form>

      <section aria-label="Live preview">
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <b>Checks</b>
            <div className="seg" role="group" aria-label="Preview theme" style={{ flex: "none" }}>{(["dark", "light"] as const).map((x) => <button key={x} className={theme === x ? "on" : ""} aria-pressed={theme === x} onClick={() => setTheme(x)}>{x}</button>)}</div>
          </div>
          {!check.ok && <ul className="errs" role="alert">{check.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          {check.ok && t.warnings.map((w) => <p className="callout warn" key={w}>{w}</p>)}
          {check.ok && ratio !== null && <p className={`callout ${ratio >= 4.5 ? "info" : "bad"}`}>Button text contrast on the accent: {ratio.toFixed(2)}:1 ({ratio >= 4.5 ? "passes WCAG AA" : "below AA"}). Text colour is chosen automatically.</p>}
          {check.ok && t.warnings.length === 0 && <p className="hint">No contrast warnings.</p>}
        </div>
        <div className="preview-frame" style={{ ...(vars as React.CSSProperties), background: "var(--bg)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: valid.radius === "sharp" ? 2 : valid.radius === "round" ? 14 : 8, overflow: "hidden", fontFamily: "var(--font)" }}>
          <div className="demo" style={{ background: theme === "dark" ? "#2a2208" : "#1d2b44", color: theme === "dark" ? "#ffd870" : "#ffe8a8" }}>{valid.disclaimer.extra ? `${BASE_BANNER}. ${valid.disclaimer.extra}` : BASE_BANNER}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
            <b style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {valid.logo
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={logoSrc(valid.logo)} alt="" width={24} height={24} style={{ objectFit: "contain" }} />
                : <span style={{ width: 22, height: 22, border: "2px solid var(--brand)", borderRadius: 5, display: "inline-block" }} aria-hidden />}
              {valid.name}
            </b>
            <span style={{ color: "var(--mute)" }}>{valid.tagline}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" style={{ background: "var(--brand-fill)", borderColor: "var(--brand-fill)", color: "var(--brand-ink)", borderRadius: "var(--radius)" }}>Connect wallet</button>
          </div>
          <div style={{ display: "flex", gap: 12, padding: "8px 16px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", alignItems: "center" }}>
            {markets.map((m, i) => <span key={m.id} style={{ padding: "2px 10px", borderRadius: "var(--radius)", border: `1px solid ${i === 0 ? "var(--brand)" : "transparent"}`, background: i === 0 ? "var(--brand-bg)" : "none" }}>{m.name}</span>)}
            <b className="num">50,000.00</b>
            <span style={{ color: theme === "dark" ? "#4fd1b0" : "#0a7560" }}>▲ 1.20%</span>
            <span style={{ color: theme === "dark" ? "#ff909d" : "#b0233a" }}>▼ 0.40%</span>
          </div>
          <div style={{ padding: 16, display: "grid", gap: 8, maxWidth: 360, background: "var(--surface)", margin: 16, borderRadius: "var(--radius)", border: "1px solid var(--line)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button className="btn" style={{ background: theme === "dark" ? "rgba(79,209,176,.14)" : "#dff3ee", color: theme === "dark" ? "#4fd1b0" : "#0a7560", borderRadius: "var(--radius)" }}>▲ Buy / Long</button>
              <button className="btn" style={{ borderRadius: "var(--radius)" }}>▼ Sell / Short</button>
            </div>
            <span className="hint">{valid.copy.welcomeBody ?? "Representative preview, not the full terminal."}</span>
            <button className="btn full" style={{ background: "var(--brand-fill)", borderColor: "var(--brand-fill)", color: "var(--brand-ink)", borderRadius: "var(--radius)" }}>Primary action</button>
            <a href="#preview" style={{ color: "var(--brand)" }}>Accent link</a>
          </div>
        </div>
      </section>
    </div>
  );
}
