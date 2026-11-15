import { describe, expect, it } from "vitest";
import { EMPTY, addressIssue, envFile, feeIssue, launchChecklist, marginBps, nameIssue, ownershipMessage, progress, revenueUsd } from "./builder";

const A = "0x50C05D162dF2EFc2f2b9a24708bE0BcDAf8d6B29" as const;

describe("builder profile", () => {
  it("validates names", () => {
    expect(nameIssue("ab")).toMatch(/3/);
    expect(nameIssue("x".repeat(33))).toMatch(/32/);
    expect(nameIssue("bad<name>")).toMatch(/letters/);
    expect(nameIssue("Acme Perps")).toBeNull();
  });
  it("binds the signed text to name, wallet, site and chain", () => {
    const m = ownershipMessage(" Acme ", A, "https://a.example", 421614);
    expect(m).toContain("Name: Acme\n");
    expect(m).toContain(A);
    expect(m).toContain("https://a.example");
    expect(m).toContain("421614");
    expect(m).toMatch(/does not move funds/);
  });
});

describe("fees", () => {
  it("margin is fee minus exchange fee, and revenue follows", () => {
    expect(marginBps(6, 5)).toBe(1);
    expect(revenueUsd(1_000_000, 4)).toBe(400); // Orderly's own worked example: 4 bps on $1M
    expect(revenueUsd(1_000_000, -1)).toBe(-100);
  });
  it("flags fees below the exchange fee, negative, and absurd", () => {
    expect(feeIssue(3, 5)).toMatch(/lose money/);
    expect(feeIssue(-1, 5)).toMatch(/0 or more/);
    expect(feeIssue(80, 5)).toMatch(/very high/);
    expect(feeIssue(6, 5)).toBeNull();
  });
});

describe("progress", () => {
  it("starts with only the default fee step done and completes step by step", () => {
    const ctx = { exchangeBps: 5 };
    expect(progress(EMPTY, ctx)).toEqual({ profile: "todo", frontend: "todo", fees: "done", revenue: "todo", launch: "todo" });
    const s = { ...EMPTY, name: "Acme", owner: A, signature: "0xsig", brandExported: true, payoutAddress: A, testnetChecked: true };
    expect(Object.values(progress(s, ctx)).every((x) => x === "done")).toBe(true);
    expect(launchChecklist(s).every((c) => c.ok)).toBe(true);
    expect(addressIssue("0x123")).toBeTruthy();
  });
});

describe("envFile", () => {
  it("contains only public values", () => {
    const e = envFile({ rpc: "https://rpc.example", chainId: 421614, indexer: "" });
    expect(e).toContain("NEXT_PUBLIC_CHAIN_ID=421614");
    expect(e).not.toMatch(/KEY|SECRET/i);
  });
});
