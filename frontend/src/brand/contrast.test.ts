import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import baseJson from "../../brand.config.json";
import novaJson from "../../tenants/nova.localhost.json";
import { contrast, hexToRgb, rgbToHex } from "./color";
import { deepMerge } from "./resolve";
import { parseBrand } from "./schema";
import { deriveTheme } from "./theme";

/** WCAG AA gate for every text/background token pair, in both themes and both shipped tenants.
 *  Static status colours (long, short, warn, demo banner) are read from globals.css so a stylesheet edit that breaks contrast fails here. */
const css = fs.readFileSync(path.join(__dirname, "../app/globals.css"), "utf8");
const block = (sel: string) => { const i = css.indexOf(sel); const j = css.indexOf("}", i); return css.slice(i, j); };
const tokens = (b: string) => Object.fromEntries([...b.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const STATIC = { light: tokens(block(":root {")), dark: { ...tokens(block(":root {")), ...tokens(block(':root[data-theme="dark"]')) } };

/** Resolve "#rrggbb" or "rgba(r, g, b, a)" over an opaque background into an opaque hex. */
function flat(v: string, over: string): string {
  if (v.startsWith("#")) return v;
  const m = v.match(/rgba?\(([^)]+)\)/); if (!m) throw new Error(`cannot parse ${v}`);
  const [r, g, b, a = "1"] = m[1].split(",").map((x) => parseFloat(x));
  const o = hexToRgb(over), al = Number(a);
  return rgbToHex([r * al + o[0] * (1 - al), g * al + o[1] * (1 - al), b * al + o[2] * (1 - al)]);
}

const tenants = { default: parseBrand(baseJson), nova: parseBrand(deepMerge(baseJson, novaJson)) };
const rows: { name: string; fg: string; bg: string; min: number }[] = [];
for (const [tn, brand] of Object.entries(tenants)) {
  const t = deriveTheme(brand);
  for (const th of ["light", "dark"] as const) {
    const v = { ...STATIC[th], ...t[th] } as Record<string, string>;
    const P = (name: string, fg: string, bg: string, min = 4.5) => rows.push({ name: `${tn}/${th}: ${name}`, fg: flat(v[fg] ?? fg, flat(v[bg] ?? bg, v["--surface"])), bg: flat(v[bg] ?? bg, v["--surface"]), min });
    for (const bg of ["--bg", "--surface", "--surface2", "--surface3", "--surface4"]) { P(`text on ${bg}`, "--text", bg); P(`muted on ${bg}`, "--mute", bg); }
    for (const bg of ["--bg", "--surface", "--surface2"]) P(`faint on ${bg}`, "--faint", bg);
    for (const bg of ["--bg", "--surface", "--surface2", "--surface3"]) { P(`long on ${bg}`, "--long", bg); P(`short on ${bg}`, "--short", bg); P(`warn on ${bg}`, "--warn", bg); P(`brand text on ${bg}`, "--brand", bg); }
    P("long on long-bg", "--long", "--long-bg"); P("short on short-bg", "--short", "--short-bg"); P("warn on warn-bg", "--warn", "--warn-bg"); P("brand on brand-bg", "--brand", "--brand-bg");
    P("long button text", "--long-ink", "--long-fill"); P("short button text", "--short-ink", "--short-fill"); P("brand button text", "--brand-ink", "--brand-fill");
    P("demo banner", "--demo-ink", "--demo-bg");
    P("focus ring on surface (non-text 3:1)", "--brand", "--surface", 3);
    P("long fill vs surface (non-text 3:1)", "--long-fill", "--surface", 3); P("short fill vs surface (non-text 3:1)", "--short-fill", "--surface", 3);
  }
}

describe("WCAG AA token contrast", () => {
  it("covers both themes and both tenants", () => { expect(rows.length).toBeGreaterThan(150); });
  for (const r of rows) it(r.name, () => { const c = contrast(r.fg, r.bg); expect(c, `${r.name}: ${r.fg} on ${r.bg} = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(r.min); });
});
