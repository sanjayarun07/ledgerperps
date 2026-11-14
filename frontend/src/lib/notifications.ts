"use client";
import { useSyncExternalStore } from "react";

export type NoteKind = "fill" | "order" | "transfer" | "margin" | "incident" | "error";
export interface Note { id: string; at: number; kind: NoteKind; title: string; body: string; read: boolean }
const KEY = "terminal.notifications.v1";
const MAX = 100;

let items: Note[] = [];
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try { const raw = localStorage.getItem(KEY); if (raw) { const v = JSON.parse(raw); if (Array.isArray(v)) items = v.filter((n) => n && typeof n.id === "string").slice(0, MAX); } } catch { /* storage unavailable or corrupt: start empty */ }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* ignore */ } }

/** Add a notification once per id (so re-renders and repeated polls never duplicate it). */
export function pushNote(n: Omit<Note, "at" | "read"> & { at?: number }) {
  load();
  if (items.some((x) => x.id === n.id)) return;
  items = [{ ...n, at: n.at ?? Date.now(), read: false }, ...items].slice(0, MAX);
  save(); emit();
}
export const markAllRead = () => { load(); items = items.map((n) => ({ ...n, read: true })); save(); emit(); };
export const clearNotes = () => { items = []; save(); emit(); };
/** test helper */
export const _reset = () => { items = []; loaded = true; subs.clear(); };
export const _snapshot = () => items;

const EMPTY: Note[] = [];
const getSnap = () => { load(); return items; };
export function useNotifications() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, getSnap, () => EMPTY);
  return { items: list, unread: list.filter((n) => !n.read).length, markAllRead, clear: clearNotes };
}
