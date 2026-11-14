import { describe, expect, it } from "vitest";
import { VIEW_STATES, describeState } from "./stateView";
describe("state matrix", () => {
  it("every state has copy, a tone, and a role", () => {
    for (const s of VIEW_STATES) { const c = describeState(s, "positions"); expect(c.title.length).toBeGreaterThan(3); expect(c.body.length).toBeGreaterThan(10); expect(["status", "alert"]).toContain(c.role); }
  });
  it("only failures interrupt screen readers", () => { for (const s of VIEW_STATES) expect(describeState(s).role).toBe(s === "failed" ? "alert" : "status"); });
  it("states that need the user to act expose an action; passive ones do not", () => {
    expect(describeState("disconnected").action).toBe("connect"); expect(describeState("failed").action).toBe("retry");
    expect(describeState("stale-data").action).toBe("refresh"); expect(describeState("restricted-market").action).toBe("view-rules");
    for (const s of ["loading", "empty", "pending"] as const) expect(describeState(s).action).toBe("none");
  });
  it("copy states the consequence, not only the symptom", () => {
    expect(describeState("failed").body).toMatch(/unaffected|out of date/i); expect(describeState("stale-data").body).toMatch(/last known/i);
    expect(describeState("pending").body).toMatch(/confirmed on-chain/i);
  });
  it("tones: failures are bad, degraded are warn", () => { expect(describeState("failed").tone).toBe("bad"); expect(describeState("stale-data").tone).toBe("warn"); expect(describeState("restricted-market").tone).toBe("warn"); });
});
