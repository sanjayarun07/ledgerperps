/** Resizable terminal panels. Sizes are clamped so a stale or hand-edited value can never hide the ticket. */
export interface Layout { book: number; side: number; dock: number }
export const DEFAULT_LAYOUT: Layout = { book: 260, side: 336, dock: 230 };
export const LIMITS = { book: [200, 420], side: [300, 460], dock: [120, 460] } as const;
const KEY = "terminal.layout.v1";
export const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));
export function clampLayout(l: Partial<Layout> | null | undefined, vw = 1440, vh = 900): Layout {
  const d = DEFAULT_LAYOUT;
  const num = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  const side = clampTo(num(l?.side, d.side), LIMITS.side); let book = clampTo(num(l?.book, d.book), LIMITS.book);
  // the chart must keep at least 420px: squeeze the book first, never the ticket
  const over = side + book + 420 - vw;
  if (over > 0) book = clampTo(book - over, LIMITS.book);
  const dock = Math.min(clampTo(num(l?.dock, d.dock), LIMITS.dock), Math.max(LIMITS.dock[0], Math.round(vh * 0.5)));
  return { book, side, dock };
}
export function loadLayout(): Partial<Layout> | null { try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
export function saveLayout(l: Layout) { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* storage blocked: layout just will not persist */ } }
