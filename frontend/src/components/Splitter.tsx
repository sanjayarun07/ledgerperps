"use client";
import { useRef } from "react";

/** Drag or keyboard (arrow keys, Home/End, double-click to reset) separator between two panels. `sign` = -1 when growing the value moves the handle toward the origin. */
export default function Splitter({ orient, value, min, max, onChange, label, sign = -1, reset, area }: { orient: "v" | "h"; value: number; min: number; max: number; onChange: (n: number) => void; label: string; sign?: 1 | -1; reset: number; area: string }) {
  const start = useRef<{ p: number; v: number } | null>(null);
  const pos = (e: { clientX: number; clientY: number }) => (orient === "v" ? e.clientX : e.clientY);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  return (
    <div
      className={`splitter ${orient}`} style={{ gridArea: area }} role="separator" aria-orientation={orient === "v" ? "vertical" : "horizontal"} aria-label={label}
      aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); start.current = { p: pos(e), v: value }; }}
      onPointerMove={(e) => { if (start.current) onChange(clamp(start.current.v + sign * (pos(e) - start.current.p))); }}
      onPointerUp={() => { start.current = null; }} onPointerCancel={() => { start.current = null; }}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={(e) => {
        const grow = orient === "v" ? (sign === -1 ? "ArrowLeft" : "ArrowRight") : (sign === -1 ? "ArrowUp" : "ArrowDown");
        const shrink = orient === "v" ? (sign === -1 ? "ArrowRight" : "ArrowLeft") : (sign === -1 ? "ArrowDown" : "ArrowUp");
        const step = e.shiftKey ? 48 : 16;
        if (e.key === grow) { e.preventDefault(); onChange(clamp(value + step)); }
        else if (e.key === shrink) { e.preventDefault(); onChange(clamp(value - step)); }
        else if (e.key === "Home") { e.preventDefault(); onChange(min); } else if (e.key === "End") { e.preventDefault(); onChange(max); }
      }}
    />
  );
}
