import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, clampLayout, clampTo, LIMITS } from "./layout";
describe("layout", () => {
  it("defaults and garbage input", () => {
    expect(clampLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(clampLayout({ book: NaN, side: "x" as unknown as number })).toEqual(DEFAULT_LAYOUT);
  });
  it("clamps to limits", () => { expect(clampTo(9999, LIMITS.side)).toBe(460); expect(clampTo(1, LIMITS.book)).toBe(200); });
  it("squeezes the book, never the ticket, on narrow screens", () => {
    const l = clampLayout({ book: 420, side: 460 }, 1280);
    expect(l.side).toBe(460); expect(l.book).toBeLessThan(420); expect(l.book + l.side + 420).toBeLessThanOrEqual(1280 + 0);
  });
  it("dock cannot exceed half the viewport height", () => { expect(clampLayout({ dock: 460 }, 1440, 600).dock).toBe(300); });
});
