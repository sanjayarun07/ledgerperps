import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { decodePerpError, exchangeAbi, PerpError } from "../src/index.js";

describe("error decoding", () => {
  it("decodes custom errors found deep in an error chain", () => {
    const data = encodeErrorResult({ abi: exchangeAbi, errorName: "BadParam", args: ["tick"] });
    const e = Object.assign(new Error("boom"), { cause: { data: { data } } });
    const d = decodePerpError(e)!;
    expect(d).toBeInstanceOf(PerpError);
    expect(d.errorName).toBe("BadParam");
    expect(d.args).toEqual(["tick"]);
    expect(d.is("BadParam", "tick")).toBe(true);
  });
  it("decodes zero-arg errors and returns undefined for noise", () => {
    const data = encodeErrorResult({ abi: exchangeAbi, errorName: "PostOnlyCross" });
    expect(decodePerpError({ raw: data })!.errorName).toBe("PostOnlyCross");
    expect(decodePerpError(new Error("network down"))).toBeUndefined();
  });
});

describe("WithdrawGated", () => {
  it("decodes with a plain message", () => {
    const data = encodeErrorResult({ abi: exchangeAbi, errorName: "WithdrawGated" });
    const d = decodePerpError({ raw: data })!;
    expect(d.errorName).toBe("WithdrawGated");
    expect(d.message).toMatch(/temporarily limited while the exchange has unresolved bad debt/);
  });
});

describe("BackstopCap", () => {
  it("decodes to a named error with a plain message", () => {
    const data = encodeErrorResult({ abi: exchangeAbi, errorName: "BackstopCap" });
    const d = decodePerpError({ raw: data })!;
    expect(d.errorName).toBe("BackstopCap");
    expect(d.message).toMatch(/backstop already holds/i);
  });
});
