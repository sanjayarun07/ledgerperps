import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import baseJson from "../../brand.config.json";
import { contrast, readableOn } from "./color";
import { dockTabs, navLinks, ticketOptions, visibleMarkets } from "./gate";
import { cleanHost, deepMerge, resolveBrand } from "./resolve";
import { BASE_BANNER, disclaimerText, parseBrand, safeParseBrand } from "./schema";
import { brandCss, deriveAccent, deriveTheme } from "./theme";

const base = () => parseBrand(baseJson);

describe("schema validation", () => {
  it("accepts the committed default and fills defaults", () => {
    const b = base();
    expect(b.name).toBe("Ledgerline"); expect(b.features.twap).toBe(true); expect(b.features.studio).toBe(false); expect(b.integrations.analytics.enabled).toBe(false);
  });
  it("rejects a bad colour with a clear path", () => {
    const r = safeParseBrand({ ...baseJson, accent: "blue" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("\n")).toMatch(/accent: must be a 6-digit hex colour/);
  });
  it("rejects bad URLs, non-http schemes and bad logos", () => {
    const r = safeParseBrand({ ...baseJson, links: { docs: "javascript:alert(1)", support: "not a url" }, logo: "ftp://x/y.png" });
    expect(r.ok).toBe(false);
    if (!r.ok) { const t = r.issues.join("\n"); expect(t).toMatch(/links\.docs/); expect(t).toMatch(/links\.support/); expect(t).toMatch(/logo/); }
  });
  it("reports missing required fields", () => {
    const r = safeParseBrand({ shortName: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) { const t = r.issues.join("\n"); expect(t).toMatch(/name/); expect(t).toMatch(/accent/); }
    expect(() => parseBrand({}, "test config")).toThrow(/Invalid test config:/);
  });
  it("accepts inline svg and image data URLs", () => {
    expect(safeParseBrand({ ...baseJson, logo: "<svg xmlns='http://www.w3.org/2000/svg'></svg>" }).ok).toBe(true);
    expect(safeParseBrand({ ...baseJson, favicon: "data:image/png;base64,AAAA" }).ok).toBe(true);
  });
});

describe("mandatory disclaimer", () => {
  it("can only be extended, never replaced, unless a real deployment is declared", () => {
    const b = parseBrand({ ...baseJson, disclaimer: { extra: "Extra words.", override: "Totally safe!" } });
    expect(disclaimerText(b, false)).toBe(`${BASE_BANNER}. Extra words.`);
    expect(disclaimerText(b, false)).toContain(BASE_BANNER);
    expect(disclaimerText(b, true)).toBe("Totally safe!");
    expect(disclaimerText(base(), false)).toBe(BASE_BANNER);
  });
});

describe("contrast fallback", () => {
  it("picks readable button text for light and dark accents", () => {
    for (const c of ["#ffffff", "#ffee00", "#000000", "#1d4ed8", "#e0457b"]) expect(contrast(readableOn(c), c)).toBeGreaterThanOrEqual(4.5);
  });
  it("lightens a dark accent on dark surfaces and darkens a pale one on light surfaces until readable", () => {
    const dark = deriveAccent("#101040", "#12151a", true);
    expect(contrast(dark.brand, "#12151a")).toBeGreaterThanOrEqual(4.5);
    const pale = deriveAccent("#ffee00", "#ffffff", false);
    expect(contrast(pale.brand, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(pale.ink, pale.fill)).toBeGreaterThanOrEqual(4.5);
  });
  it("warns about extreme or long/short-like accents but still derives a theme", () => {
    const t = deriveTheme(parseBrand({ ...baseJson, accent: "#ffee00" }));
    expect(t.warnings.length).toBeGreaterThan(0);
    expect(deriveTheme(parseBrand({ ...baseJson, accent: "#22cc66" })).warnings.join(" ")).toMatch(/green/);
  });
  it("renders css with radius, density and font variables", () => {
    const css = brandCss(parseBrand({ ...baseJson, radius: "sharp", density: "compact", accent: "#e0457b" }));
    expect(css).toContain("--radius:2px"); expect(css).toContain("--ctl-h:32px"); expect(css).toContain('[data-theme="dark"]'); expect(css).toContain("--brand-fill");
    expect(css).not.toMatch(/[<>]/);
  });
});

describe("feature-flag gating", () => {
  it("removes dock tabs for disabled features", () => {
    const f = parseBrand({ ...baseJson, features: { twap: false, conditionals: false } }).features;
    expect(dockTabs(f)).not.toContain("TWAPs"); expect(dockTabs(f)).not.toContain("Conditionals"); expect(dockTabs(f)).toContain("Positions");
    expect(dockTabs(base().features)).toEqual(expect.arrayContaining(["TWAPs", "Conditionals", "Activity"]));
  });
  it("removes ticket options and never renders links for unimplemented pages", () => {
    const f = parseBrand({ ...baseJson, features: { advancedTab: false, isolatedMargin: false, agentKeys: false, subaccounts: false, conditionals: false, leaderboard: true, explore: true } }).features;
    const o = ticketOptions(f);
    expect(o).toEqual({ advancedTab: false, tpsl: false, twap: false, signedRelay: false, isolated: false, sessionKeys: false, subaccounts: false });
    expect(navLinks(f)).toEqual(["trade", "markets", "portfolio", "activity"]);
    expect(ticketOptions(base().features).twap).toBe(true);
  });
  it("orders and filters markets, dropping unknown ids", () => {
    expect(visibleMarkets([1, 0]).map((m) => m.id)).toEqual([1, 0]);
    expect(visibleMarkets([2, 99]).map((m) => m.id)).toEqual([2]);
    expect(visibleMarkets([99]).length).toBeGreaterThan(0);
  });
});

describe("tenant resolution by host", () => {
  const tmp: string[] = [];
  afterEach(() => { delete process.env.BRAND_TENANT_DIR; });
  it("sanitises hosts", () => {
    expect(cleanHost("Nova.Localhost:3147")).toBe("nova.localhost"); expect(cleanHost("a.com, b.com")).toBe("a.com");
    expect(cleanHost("../etc/passwd")).toBeNull(); expect(cleanHost("a/b")).toBeNull(); expect(cleanHost("")).toBeNull(); expect(cleanHost(null)).toBeNull();
  });
  it("resolves the committed sample tenant by host and falls back to the default", () => {
    const nova = resolveBrand("nova.localhost:3147");
    expect(nova.name).toBe("Nova Perps"); expect(nova.accent).toBe("#e0457b"); expect(nova.radius).toBe("sharp"); expect(nova.density).toBe("compact");
    expect(nova.features.twap).toBe(false); expect(nova.features.tour).toBe(true); // merged over the default
    expect(resolveBrand("unknown.example").name).toBe("Ledgerline"); expect(resolveBrand("../../etc/passwd").name).toBe("Ledgerline");
  });
  it("serves the default for an invalid tenant file instead of failing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-")); tmp.push(dir);
    fs.writeFileSync(path.join(dir, "bad.example.json"), JSON.stringify({ accent: "nope" }));
    fs.writeFileSync(path.join(dir, "good.example.json"), JSON.stringify({ name: "Good", shortName: "Good", accent: "#2266cc" }));
    process.env.BRAND_TENANT_DIR = dir;
    expect(resolveBrand("bad.example").name).toBe("Ledgerline");
    expect(resolveBrand("good.example").name).toBe("Good");
  });
  it("deep merges objects and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] })).toEqual({ a: { b: 1, c: 3 }, l: [9] });
  });
});
