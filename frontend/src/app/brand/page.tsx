import { headers } from "next/headers";
import { notFound } from "next/navigation";
import BrandStudio from "@/components/BrandStudio";
import { resolveBrand } from "@/brand/resolve";

export const dynamic = "force-dynamic";
/** Operator-facing Brand Studio. Off by default: enable with features.studio in the brand config or BRAND_STUDIO=1. Read-only on the server; export is a client-side download. */
export default async function Page() {
  const h = await headers();
  const brand = resolveBrand(h.get("x-forwarded-host") ?? h.get("host"));
  if (!brand.features.studio && process.env.BRAND_STUDIO !== "1") notFound();
  return <BrandStudio initial={brand} />;
}
