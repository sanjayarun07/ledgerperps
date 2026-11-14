import fs from "node:fs";
import path from "node:path";
import baseJson from "../../brand.config.json";
import { parseBrand, type BrandConfig } from "./schema";

/**
 * Server-side brand resolution (never imported by client code).
 *   1. committed default   frontend/brand.config.json
 *   2. operator override   BRAND_CONFIG (JSON string) or BRAND_CONFIG_PATH / NEXT_PUBLIC_BRAND_CONFIG_PATH (file), deep-merged over the default
 *   3. tenant by host      frontend/tenants/<hostname>.json (port stripped), deep-merged over (2)
 * The merged result is validated with zod; invalid base config throws at first use with one line per problem, an invalid
 * tenant file is logged and that host falls back to the base brand (one bad tenant must not take the others down).
 */
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function deepMerge<T>(a: T, b: unknown): T {
  if (!isObj(a) || !isObj(b)) return (b === undefined ? a : (b as T));
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}
export const cleanHost = (h: string | null | undefined): string | null => {
  const host = (h ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) && !host.includes("..") ? host : null; // no path separators, no traversal
};
const TENANT_DIR = () => process.env.BRAND_TENANT_DIR ?? path.join(process.cwd(), "tenants");

let base: BrandConfig | null = null;
export function loadBaseBrand(): BrandConfig {
  if (base) return base;
  let raw: unknown = baseJson;
  const file = process.env.BRAND_CONFIG_PATH ?? process.env.NEXT_PUBLIC_BRAND_CONFIG_PATH;
  if (file) {
    try { raw = deepMerge(raw, JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))); }
    catch (e) { throw new Error(`Cannot read BRAND_CONFIG_PATH (${file}): ${(e as Error).message}`); }
  }
  if (process.env.BRAND_CONFIG) {
    try { raw = deepMerge(raw, JSON.parse(process.env.BRAND_CONFIG)); }
    catch (e) { throw new Error(`BRAND_CONFIG is not valid JSON: ${(e as Error).message}`); }
  }
  return (base = parseBrand(raw, "brand config (brand.config.json + env overrides)"));
}
export function resolveBrand(host?: string | null): BrandConfig {
  const b = loadBaseBrand();
  const h = cleanHost(host);
  if (!h) return b;
  const f = path.join(TENANT_DIR(), `${h}.json`);
  if (!fs.existsSync(f)) return b;
  try {
    const raw = deepMerge(b as unknown, JSON.parse(fs.readFileSync(f, "utf8")));
    return parseBrand(raw, `tenant file tenants/${h}.json`);
  } catch (e) {
    console.error(`[brand] ${(e as Error).message}; serving the default brand for ${h}`);
    return b;
  }
}
export const realDeployment = () => process.env.NEXT_PUBLIC_REAL_DEPLOYMENT === "1";
