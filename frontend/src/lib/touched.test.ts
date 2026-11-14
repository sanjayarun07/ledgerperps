import { describe, expect, it } from "vitest";
import { sizeTouched, tpslTouched } from "./touched";
describe("validation after interaction", () => {
  it("an empty or blank size is untouched", () => { expect(sizeTouched("")).toBe(false); expect(sizeTouched("  ")).toBe(false); expect(sizeTouched("0.1")).toBe(true); });
  it("TP/SL errors wait for a typed price", () => {
    expect(tpslTouched(true, "", "")).toBe(false);
    expect(tpslTouched(false, "10", "")).toBe(false);
    expect(tpslTouched(true, "10", "")).toBe(true);
    expect(tpslTouched(true, "", " 9 ")).toBe(true);
  });
});
