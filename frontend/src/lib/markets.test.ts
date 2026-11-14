import { describe, expect, it } from "vitest";
import { marketsFromDeployment } from "./config";

describe("marketsFromDeployment", () => {
  it("defaults to the three real markets with no demo flag", () => {
    const m = marketsFromDeployment({});
    expect(m.map((x) => x.name)).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
    expect(m.some((x) => x.demo)).toBe(false);
  });
  it("adds DEMO-USD from the deployment and flags it as admin-priced", () => {
    const m = marketsFromDeployment({ marketIds: { "SOL-USD": 2, "BTC-USD": 0, "ETH-USD": 1, "DEMO-USD": 3 }, demo: { market: "DEMO-USD" } });
    expect(m.map((x) => x.id)).toEqual([0, 1, 2, 3]);
    expect(m[3]).toMatchObject({ name: "DEMO-USD", base: "DEMO", demo: true });
    expect(m.filter((x) => x.demo)).toHaveLength(1);
  });
  it("flags a DEMO-named market even without a demo block", () => {
    expect(marketsFromDeployment({ marketIds: { "DEMO-USD": 0 } })[0].demo).toBe(true);
  });
});

describe("oracle kind per market", () => {
  it("testnet chainlink deployment: real markets chainlink, DEMO demo", () => {
    const m = marketsFromDeployment({ oracleMode: "chainlink", marketIds: { "BTC-USD": 0, "DEMO-USD": 3 }, demo: { market: "DEMO-USD" } });
    expect(m.map((x) => x.oracle)).toEqual(["chainlink", "demo"]);
  });
  it("median mode and local (no oracleMode) deployments", () => {
    expect(marketsFromDeployment({ oracleMode: "median", marketIds: { "BTC-USD": 0 } })[0].oracle).toBe("median");
    expect(marketsFromDeployment({ marketIds: { "BTC-USD": 0 } })[0].oracle).toBe("manual");
  });
});

