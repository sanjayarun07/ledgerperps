import type { ReactElement } from "react";

/** The one icon set: 16px grid, 1.5px round strokes, currentColor. Directional triangles are filled shapes so they never depend on font glyphs. */
const PATHS: Record<string, ReactElement> = {
  chevron: <path d="M4 6l4 4 4-4" />,
  more: <><circle cx="3.5" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12.5" cy="8" r=".6" /></>,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  alert: <><path d="M8 2.5l6 10.5H2z" /><path d="M8 6.5v3M8 11.2v.1" /></>,
  info: <><circle cx="8" cy="8" r="6" /><path d="M8 7.2v4M8 5v.1" /></>,
  trade: <path d="M2 12l3.5-4 3 2.5L14 4M10.5 4H14v3.5" />,
  markets: <><rect x="2.5" y="8" width="2.5" height="5" /><rect x="6.75" y="3" width="2.5" height="10" /><rect x="11" y="6" width="2.5" height="7" /></>,
  portfolio: <><rect x="2" y="5" width="12" height="8.5" rx="1.5" /><path d="M5.5 5V3.5h5V5" /></>,
  activity: <path d="M2 8h2.5l2-5 3 10 2-5H14" />,
  circle: <circle cx="8" cy="8" r="5.5" />,
  sun: <><circle cx="8" cy="8" r="2.6" /><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  collapse: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6 3v10" /></>,
  expand: <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />,
};
const FILLED = new Set(["more"]);

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={`ic-svg ${className ?? ""}`} width={size} height={size} viewBox="0 0 16 16" fill={FILLED.has(name) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** Direction marker (filled triangle). Always sits next to a number or a word, so colour is never the only signal. */
export function Tri({ up, size = 8 }: { up: boolean; size?: number }) {
  return (
    <svg className="tri" width={size} height={size} viewBox="0 0 8 8" fill="currentColor" aria-hidden focusable="false">
      {up ? <path d="M4 1l3.5 6h-7z" /> : <path d="M4 7L.5 1h7z" />}
    </svg>
  );
}
