import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandProvider } from "./context";
import { resolveBrand } from "./resolve";
import { BASE_BANNER } from "./schema";
import { brandCss } from "./theme";
import { DemoBanner, Wordmark } from "@/components/BrandBits";

const render = (host: string, real = false) => {
  const brand = resolveBrand(host);
  return { brand, html: renderToStaticMarkup(<BrandProvider brand={brand} real={real}><Wordmark /><DemoBanner /></BrandProvider>) };
};
describe("tenant rendering", () => {
  it("the default tenant renders its name and the demo banner", () => {
    const { html } = render("localhost:3147");
    expect(html).toContain("Ledgerline"); expect(html).toContain(BASE_BANNER);
  });
  it("the second tenant renders its own name, accent and the disclaimer (extended, not hidden)", () => {
    const { html, brand } = render("nova.localhost");
    expect(html).toContain("Nova Perps"); expect(html).not.toContain("Ledgerline");
    expect(html).toContain(BASE_BANNER); expect(html).toContain("Nova demo tenant");
    const css = brandCss(brand);
    expect(css).toContain("--radius:2px"); expect(css).toContain("--ctl-h:32px");
    expect(css).not.toBe(brandCss(resolveBrand("localhost")));
    expect(css.toLowerCase()).toContain("--brand-fill:#e0457b");
  });
  it("a tenant cannot hide the notice without the real-deployment flag", () => {
    const { html } = render("nova.localhost", false);
    expect(html).toContain("LOCAL DEMO");
  });
});
