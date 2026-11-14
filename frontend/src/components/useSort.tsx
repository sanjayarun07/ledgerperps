"use client";
import { useState } from "react";

/** Tiny sortable-header helper: click a header to sort by it, click again to reverse. */
export function useSort<K extends string>(initial: K) {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<1 | -1>(-1);
  const apply = <T,>(rows: T[], get: Record<K, (r: T) => number>) => [...rows].sort((a, b) => dir * (get[key](a) - get[key](b)));
  const Th = ({ k, r, children }: { k: K; r?: boolean; children: React.ReactNode }) => (
    <th className={r ? "r" : ""} aria-sort={key === k ? (dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="thbtn" onClick={() => { if (key === k) setDir((d) => (d === 1 ? -1 : 1)); else { setKey(k); setDir(-1); } }}>{children}{key === k ? (dir === 1 ? " ▲" : " ▼") : ""}</button>
    </th>
  );
  return { apply, Th };
}

