import { beforeEach, describe, expect, it } from "vitest";
import { _reset, _snapshot, clearNotes, markAllRead, pushNote } from "./notifications";

beforeEach(() => _reset());
describe("notifications store", () => {
  it("adds once per id and keeps newest first", () => {
    pushNote({ id: "a", kind: "fill", title: "A", body: "" }); pushNote({ id: "b", kind: "order", title: "B", body: "" }); pushNote({ id: "a", kind: "fill", title: "dup", body: "" });
    expect(_snapshot().map((n) => n.id)).toEqual(["b", "a"]);
  });
  it("marks read and clears", () => {
    pushNote({ id: "a", kind: "incident", title: "A", body: "" });
    expect(_snapshot()[0].read).toBe(false); markAllRead(); expect(_snapshot()[0].read).toBe(true);
    clearNotes(); expect(_snapshot()).toEqual([]);
  });
  it("is capped", () => { for (let i = 0; i < 130; i++) pushNote({ id: String(i), kind: "order", title: "", body: "" }); expect(_snapshot().length).toBe(100); });
});
