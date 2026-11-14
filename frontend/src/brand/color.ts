/** Small, dependency-free colour maths for brand theming (WCAG 2.x contrast). */
export type RGB = [number, number, number];
export const HEX = /^#[0-9a-fA-F]{6}$/;
export const hexToRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const rgbToHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
export function luminance(c: RGB): number {
  const f = (x: number) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
export function contrast(a: string, b: string): number {
  const la = luminance(hexToRgb(a)), lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
export const withLightness = (hex: string, l: number) => { const [h, s] = rgbToHsl(hexToRgb(hex)); return hslToHex(h, s, Math.max(0, Math.min(1, l))); };
/** Move lightness toward white (dir=+1) or black (dir=-1) in small steps until `fg` reaches `min` contrast against `bg`; returns the first passing colour. */
export function ensureContrast(fg: string, bg: string, min: number, dir: 1 | -1): string {
  let [, , l] = rgbToHsl(hexToRgb(fg)); let cur = fg;
  for (let i = 0; i < 60 && contrast(cur, bg) < min; i++) { l = Math.max(0, Math.min(1, l + dir * 0.02)); cur = withLightness(fg, l); }
  return cur;
}
/** Readable text colour on top of `bg`: near-black or white, whichever has the higher contrast. */
export const readableOn = (bg: string) => (contrast("#ffffff", bg) >= contrast("#0b0d10", bg) ? "#ffffff" : "#0b0d10");
export const alpha = (hex: string, a: number) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };
export const hueOf = (hex: string) => rgbToHsl(hexToRgb(hex))[0];
