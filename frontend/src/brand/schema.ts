import { z } from "zod";
import { HEX } from "./color";

/**
 * The single typed brand + tenant configuration. Everything that can differ between white-label tenants lives here.
 * Chain id, RPC URL, contract addresses and the indexer URL are NOT part of it: they stay deployment-level
 * (NEXT_PUBLIC_RPC_URL / NEXT_PUBLIC_CHAIN_ID / NEXT_PUBLIC_INDEXER_URL and src/generated/deployment.json, see docs/WHITE_LABEL.md).
 */
const colour = z.string().regex(HEX, "must be a 6-digit hex colour such as #5b8cff");
const httpUrl = z.string().url("must be a valid URL").refine((u) => /^https?:\/\//i.test(u), "must start with http:// or https://");
const imageRef = z.string().max(150_000, "is too large (max ~150 KB; use a URL for big images)").refine(
  (v) => /^https?:\/\//i.test(v) || /^data:image\/(png|jpeg|webp|svg\+xml|gif);/i.test(v) || /^<svg[\s>]/i.test(v), "must be an http(s) URL, an image data URL or inline <svg>");
const text = (max: number) => z.string().max(max);

export const FONTS = ["system", "humanist", "mono-ui", "serif"] as const;
export const RADII = ["sharp", "default", "round"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export const NEUTRALS = ["ink", "graphite", "slate"] as const;

export const FeaturesSchema = z.object({
  twap: z.boolean().default(true),
  conditionals: z.boolean().default(true), // take-profit / stop-loss brackets and trigger orders
  isolatedMargin: z.boolean().default(true),
  signedRelay: z.boolean().default(true),
  agentKeys: z.boolean().default(true), // session keys
  subaccounts: z.boolean().default(true),
  tour: z.boolean().default(true),
  advancedTab: z.boolean().default(true),
  commandPalette: z.boolean().default(true),
  /** reserved: no leaderboard / explore pages exist yet, so these have no effect and no links are rendered */
  leaderboard: z.boolean().default(false),
  explore: z.boolean().default(false),
  /** exposes the /brand studio route */
  studio: z.boolean().default(false),
}).default({});
export type Features = z.infer<typeof FeaturesSchema>;

export const BrandSchema = z.object({
  name: z.string().trim().min(1, "is required").max(40),
  shortName: z.string().trim().min(1, "is required").max(14),
  tagline: text(120).default(""),
  logo: imageRef.optional(),
  favicon: imageRef.optional(),
  accent: colour,
  neutral: z.enum(NEUTRALS).default("graphite"),
  font: z.enum(FONTS).default("system"),
  radius: z.enum(RADII).default("default"),
  density: z.enum(DENSITIES).default("comfortable"),
  defaultTheme: z.enum(["dark", "light", "system"]).default("dark"),
  links: z.object({ support: httpUrl.optional(), docs: httpUrl.optional(), terms: httpUrl.optional(), privacy: httpUrl.optional(), status: httpUrl.optional() }).default({}),
  social: z.array(z.object({ label: text(24).min(1), url: httpUrl })).max(6).default([]),
  footerText: text(200).default(""),
  /** `extra` is appended to the mandatory demo / unaudited notice. `override` replaces it ONLY when NEXT_PUBLIC_REAL_DEPLOYMENT=1. */
  disclaimer: z.object({ extra: text(400).default(""), override: text(400).optional() }).default({}),
  copy: z.object({ hero: text(120).optional(), welcomeTitle: text(60).optional(), welcomeBody: text(300).optional(), emptyPositions: text(200).optional(), emptyOrders: text(200).optional() }).default({}),
  features: FeaturesSchema,
  markets: z.object({ order: z.array(z.number().int().min(0).max(63)).min(1, "must list at least one market id").max(32) }).default({ order: [0, 1, 2] }),
  integrations: z.object({
    faucetUrl: httpUrl.optional(),
    explorerTxUrl: httpUrl.optional(), // e.g. https://explorer.example/tx/ ; the tx hash is appended
    collateral: z.object({ label: z.string().min(1).max(10).default("USDC"), decimals: z.number().int().min(0).max(18).default(6) }).default({ label: "USDC", decimals: 6 }),
    analytics: z.object({ enabled: z.boolean().default(false), endpoint: httpUrl.optional() }).default({ enabled: false }),
  }).default({ collateral: { label: "USDC", decimals: 6 }, analytics: { enabled: false } }),
});
export type BrandConfig = z.infer<typeof BrandSchema>;
export type BrandInput = z.input<typeof BrandSchema>;

/** Human-readable issues, one per line: "accent: must be a 6-digit hex colour ...". */
export function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}
export function parseBrand(input: unknown, source = "brand config"): BrandConfig {
  const r = BrandSchema.safeParse(input);
  if (!r.success) throw new Error(`Invalid ${source}:\n  - ${formatIssues(r.error).join("\n  - ")}`);
  return r.data;
}
export const safeParseBrand = (input: unknown) => { const r = BrandSchema.safeParse(input); return r.success ? { ok: true as const, brand: r.data } : { ok: false as const, issues: formatIssues(r.error) }; };

/** Mandatory notice. Tenants can only extend it, unless the operator declares a real deployment. */
export const BASE_BANNER = "LOCAL DEMO - mock USDC, manual oracle, not real liquidity";
export const BASE_NOTICE = "Unaudited prototype contracts: do not use with real funds.";
export function disclaimerText(b: BrandConfig, realDeployment: boolean): string {
  if (realDeployment && b.disclaimer.override) return b.disclaimer.override;
  return b.disclaimer.extra ? `${BASE_BANNER}. ${b.disclaimer.extra}` : BASE_BANNER;
}
