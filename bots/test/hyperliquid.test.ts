import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { HL_TESTNET, HyperliquidVenue, actionHash, buildOrderAction, floatToWire, roundPerpPrice, signL1Action } from "../src/hyperliquid.js";

describe("wire formatting", () => {
  it("strips zeros and keeps 8 decimals max", () => {
    expect(floatToWire(1)).toBe("1");
    expect(floatToWire(0.0100)).toBe("0.01");
    expect(floatToWire(64600.5)).toBe("64600.5");
    expect(floatToWire(0.123456789)).toBe("0.12345679");
  });
  it("rounds perp prices to 5 sig figs and (6 - szDecimals) decimals", () => {
    expect(roundPerpPrice(64612.37, 5)).toBe(64612);
    expect(roundPerpPrice(3123.456, 4)).toBe(3123.5);
    expect(roundPerpPrice(148.7654, 2)).toBe(148.77);
    expect(roundPerpPrice(70000, 5)).toBe(70000);
  });
});

describe("signing", () => {
  const a = buildOrderAction(3, true, 65000, 0.001, false);
  it("keeps msgpack key order, so the hash is stable and nonce-dependent", () => {
    expect(Object.keys(a)).toEqual(["type", "orders", "grouping"]);
    expect(Object.keys(a.orders[0]!)).toEqual(["a", "b", "p", "s", "r", "t"]);
    expect(actionHash(a, 1)).toBe(actionHash(buildOrderAction(3, true, 65000, 0.001, false), 1));
    expect(actionHash(a, 1)).not.toBe(actionHash(a, 2));
  });
  it("produces a 65-byte-equivalent signature (r, s, v in 27/28)", async () => {
    const v = new HyperliquidVenue(generatePrivateKey(), HL_TESTNET, (async () => new Response("{}")) as unknown as typeof fetch);
    const sig = await signL1Action(v.account, a, 1);
    expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
    expect([27, 28]).toContain(sig.v);
  });
});

describe("HyperliquidVenue", () => {
  it("refuses any host other than the testnet API", () => {
    expect(() => new HyperliquidVenue(generatePrivateKey(), "https://api.hyperliquid.xyz")).toThrow(/REFUSING/);
  });
  it("sends a signed IOC order with rounded price/size and returns the fill", async () => {
    const calls: { url: string; body: any }[] = [];
    const f = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body); calls.push({ url, body });
      if (body.type === "meta") return new Response(JSON.stringify({ universe: [{ name: "BTC", szDecimals: 5 }] }));
      if (body.type === "allMids") return new Response(JSON.stringify({ BTC: "65000.0" }));
      return new Response(JSON.stringify({ status: "ok", response: { data: { statuses: [{ filled: { avgPx: "63100.0" } }] } } }));
    }) as unknown as typeof fetch;
    const v = new HyperliquidVenue(generatePrivateKey(), HL_TESTNET, f);
    const r = await v.marketOrder("BTC", false, 0.0123456);
    expect(r.price).toBe(63100);
    const ex = calls.find((c) => c.url.endsWith("/exchange"))!.body;
    expect(ex.action.orders[0]).toMatchObject({ a: 0, b: false, s: "0.01235", r: false, t: { limit: { tif: "Ioc" } } });
    expect(ex.action.orders[0].p).toBe("63050"); // 65000 * 0.97 = 63050
    expect(ex.signature.r).toMatch(/^0x/);
  });
  it("surfaces venue errors", async () => {
    const f = (async (_u: string, init: { body: string }) => {
      const t = JSON.parse(init.body).type;
      if (t === "meta") return new Response(JSON.stringify({ universe: [{ name: "BTC", szDecimals: 5 }] }));
      if (t === "allMids") return new Response(JSON.stringify({ BTC: "65000" }));
      return new Response(JSON.stringify({ status: "ok", response: { data: { statuses: [{ error: "Insufficient margin" }] } } }));
    }) as unknown as typeof fetch;
    await expect(new HyperliquidVenue(generatePrivateKey(), HL_TESTNET, f).marketOrder("BTC", true, 0.01)).rejects.toThrow(/Insufficient margin/);
  });
});
