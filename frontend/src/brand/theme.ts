import { alpha, contrast, ensureContrast, hexToRgb, hslToHex, hueOf, readableOn, rgbToHsl } from "./color";
import type { BrandConfig } from "./schema";

/** Neutral palettes. Dark = very dark neutral surfaces with subtle borders; light is a single paper palette. */
const DARK = {
  ink: { bg: "#080808", surface: "#161616", surface2: "#1c1c1c", surface3: "#262626", surface4: "#333333", line: "#222222", line2: "#363636", text: "#e4e4e4", mute: "#a0a0a0", faint: "#8c8c8c", chrome: "#0e0e0e" },
  graphite: { chrome: "#0e141c", bg: "#0b1017", surface: "#121a24", surface2: "#18222f", surface3: "#1f2b3a", surface4: "#2b3a4e", line: "#1e2938", line2: "#2f3e52", text: "#e6ebf2", mute: "#a3afc0", faint: "#8391a5" },
  slate: { chrome: "#0c121c", bg: "#0b101a", surface: "#0f1521", surface2: "#151c2b", surface3: "#1c2536", surface4: "#28344a", line: "#1d2636", line2: "#2d3a52", text: "#e4eaf5", mute: "#9fadc4", faint: "#7e8da6" },
} as const;
const LIGHT = { chrome: "#ffffff", bg: "#f2f4f7", surface: "#fbfcfd", surface2: "#f1f3f6", surface3: "#e8ecf1", surface4: "#dce2ea", line: "#e2e6ec", line2: "#c9d1dc", text: "#131a26", mute: "#4a586b", faint: "#5d6b7f" };
const RADIUS = { sharp: ["2px", "2px"], default: ["10px", "6px"], round: ["12px", "8px"] } as const;
const FONT = {
  system: `var(--font-ui, "Avenir Next"), "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`,
  humanist: `"Avenir Next", Avenir, "Segoe UI", Candara, "Trebuchet MS", sans-serif`,
  "mono-ui": `var(--font-mono, ui-monospace), "SF Mono", "Cascadia Mono", Menlo, monospace`,
  serif: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`,
} as const;

export interface ThemeVars { light: Record<string, string>; dark: Record<string, string>; warnings: string[] }

const mix = (fg: string, over: string, a: number) => { const f = hexToRgb(fg), o = hexToRgb(over); return `#${[0, 1, 2].map((i) => Math.round(f[i] * a + o[i] * (1 - a)).toString(16).padStart(2, "0")).join("")}`; };

/** Derive accent variants for one theme. The accent text colour must reach 4.5:1 on EVERY surface it can sit on (page, panel, control,
 *  hover) and on its own tinted background; button text on the accent fill must be readable too. */
export function deriveAccent(accent: string, surface: string, dark: boolean, surfaces: string[] = [surface]) {
  const tint = dark ? 0.16 : 0.12;
  let brand = ensureContrast(accent, surface, 4.5, dark ? 1 : -1);
  for (let i = 0; i < 24; i++) {
    const worst = [...surfaces, mix(brand, surface, tint)].map((bg) => ({ bg, c: contrast(brand, bg) })).sort((a, b) => a.c - b.c)[0];
    if (worst.c >= 4.5) break;
    brand = ensureContrast(brand, worst.bg, 4.6, dark ? 1 : -1);
  }
  const fill = dark ? accent : ensureContrast(accent, "#ffffff", 3, -1); // button background
  const ink = readableOn(fill); // button text falls back to whichever of white/near-black is readable
  const hover = shift(fill, dark ? 0.06 : -0.06);
  return { brand, fill, ink, hover, ring: alpha(brand, 0.45), bg: alpha(brand, tint), info: brand, infoBg: alpha(brand, tint) };
}
function shift(hex: string, d: number) { const [h, s, l] = rgbToHsl(hexToRgb(hex)); return hslToHex(h, s, Math.max(0, Math.min(1, l + d))); }

export function deriveTheme(b: BrandConfig): ThemeVars {
  const warnings: string[] = [];
  const dk = DARK[b.neutral];
  const mk = (n: typeof LIGHT, dark: boolean) => {
    const a = deriveAccent(b.accent, n.surface, dark, [n.bg, n.surface, n.surface2, n.surface3]);
    const out: Record<string, string> = {
      "--bg": n.bg, "--chrome": n.chrome, "--surface": n.surface, "--surface2": n.surface2, "--surface3": n.surface3, "--surface4": n.surface4, "--line": n.line, "--line2": n.line2, "--grid": alpha(n.text, 0.06), "--text": n.text, "--mute": n.mute, "--faint": n.faint,
      "--brand": a.brand, "--brand-fill": a.fill, "--brand-hover": a.hover, "--brand-ink": a.ink, "--brand-bg": a.bg, "--ring": a.ring, "--info": a.info, "--info-bg": a.infoBg,
    };
    return out;
  };
  const light = mk(LIGHT, false), dark = mk(dk, true);
  if (contrast(b.accent, LIGHT.surface) < 3) warnings.push("The accent is very light: on the light theme it was darkened to stay readable.");
  if (contrast(b.accent, dk.surface) < 3) warnings.push("The accent is very dark: on the dark theme it was lightened to stay readable.");
  const h = hueOf(b.accent);
  if ((h >= 120 && h <= 175) || h >= 345 || h <= 12) warnings.push("The accent is close to the long (green) or short (red) colours. Direction is always also shown with arrows and words, but a different hue is clearer.");
  return { light, dark, warnings };
}

export function brandCss(b: BrandConfig): string {
  const t = deriveTheme(b);
  const [r, rs] = RADIUS[b.radius];
  const dens = b.density === "compact" ? { "--ctl-h": "32px", "--panel-pad": "10px", "--fs-sm": "11.5px" } : { "--ctl-h": "36px", "--panel-pad": "12px", "--fs-sm": "12.25px" };
  const common: Record<string, string> = { "--radius": r, "--radius-sm": rs, "--font": FONT[b.font], ...dens };
  const block = (sel: string, v: Record<string, string>) => `${sel}{${Object.entries(v).map(([k, x]) => `${k}:${x}`).join(";")}}`;
  // values are validated (hex / enum) before they get here, so the string is safe to inline
  return [block(":root", { ...common, ...t.light }), block(':root[data-theme="dark"]', t.dark)].join("\n");
}
