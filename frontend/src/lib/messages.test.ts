import { describe, expect, it } from "vitest";
import abi from "@/generated/PerpExchange.merged.json";
import { BAD_PARAM, CUSTOM_ERRORS, friendlyClient, friendlyFromContract } from "./messages";

const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(2);

describe("error message lookup", () => {
  it("covers EVERY custom error in the contract ABI (no raw fallback text)", () => {
    const names = (abi as { type: string; name: string }[]).filter((x) => x.type === "error").map((x) => x.name);
    for (const n of names) expect(CUSTOM_ERRORS, `${n} missing from CUSTOM_ERRORS`).toContain(n);
    for (const n of CUSTOM_ERRORS) {
      const f = friendlyFromContract(n, n === "BadParam" ? ["size"] : []);
      expect(f.title.length).toBeGreaterThan(5);
      expect(f.detail).not.toMatch(/^Contract error/); // not the generic fallback
      expect(f.title + f.detail).not.toMatch(/0x[0-9a-f]{8}/i);
    }
  });
  it("Unhealthy names the shortfall and offers Deposit / Reduce size", () => {
    const f = friendlyFromContract("Unhealthy", [], { shortfall: 120_000_000n, fmtUsd: fmt });
    expect(f.detail).toContain("120.00 USDC more");
    expect(f.actions.map((a) => a.target)).toEqual(["deposit", "size"]);
    expect(friendlyFromContract("Unhealthy").detail).not.toContain("NaN");
  });
  it("every BadParam reason used by the contracts has friendly text with a title and no raw quote", () => {
    const reasons = ["amount", "cancel orders first", "cond", "fee-on-transfer unsupported", "inactive", "interval", "lot", "lot/size", "market", "min notional", "no adl debt", "no order", "no position", "no room", "nonce used", "not in profit", "not isolated", "not opposite to backstop", "not ranked", "not triggered", "nothing to repay", "position/orders open", "remove isolated margin first", "size", "slice < lot", "slices", "slippage", "targets", "tick", "too early"];
    for (const r of reasons) { expect(BAD_PARAM[r], r).toBeTruthy(); expect(friendlyFromContract("BadParam", [r]).detail).not.toContain(`"${r}"`); }
  });
  it("require() strings used by admin paths are mapped; unknown reasons still give a readable message", () => {
    for (const r of ["bad cfg", "bounds", "backstop", "locked", "must be reduce-only", "self only", "insurance"]) expect(BAD_PARAM[r], r).toBeTruthy();
    const u = friendlyFromContract("BadParam", ["something new"]);
    expect(u.detail).toContain("something new");
    expect(u.title).not.toBe("");
  });
  it("each fix action targets a known UI anchor", () => {
    const ok = new Set(["deposit", "size", "price", "orders", "positions", "withdraw", "session", "glossary", "poke"]);
    for (const n of CUSTOM_ERRORS) for (const a of friendlyFromContract(n, n === "BadParam" ? ["tick"] : []).actions) expect(ok.has(a.target)).toBe(true);
    for (const r of Object.keys(BAD_PARAM)) for (const a of friendlyFromContract("BadParam", [r]).actions) expect(ok.has(a.target)).toBe(true);
  });
  it("client-side failures are friendly and never claim success", () => {
    for (const k of ["rejected", "no-gas", "no-wallet", "wrong-chain", "receipt-timeout", "reverted", "network"] as const) {
      const f = friendlyClient(k, "x");
      expect(f.title).toBeTruthy();
      expect(f.title.toLowerCase()).not.toContain("success");
    }
  });
});

describe("WithdrawGated (backstop phase 1)", () => {
  it("explains the limit in plain language and names the amount that can still be withdrawn", () => {
    const f = friendlyFromContract("WithdrawGated", [], { principal: 2_500_000n, fmtUsd: (v) => (Number(v) / 1e6).toFixed(2) });
    expect(f.title).toBe("Withdrawal is temporarily limited");
    expect(f.detail).toBe("Withdrawals above your deposited amount are temporarily limited while the exchange has unresolved bad debt. You can withdraw up to 2.50 USDC.");
    expect(friendlyFromContract("WithdrawGated").detail).toContain("up to the amount you deposited");
  });
});
