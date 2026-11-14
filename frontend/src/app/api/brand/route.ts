import { NextResponse } from "next/server";
import { realDeployment, resolveBrand } from "@/brand/resolve";

export const dynamic = "force-dynamic";
/** Read-only: the brand resolved for the requesting host (default + env override + tenants/<host>.json). Never writes anything. */
export async function GET(req: Request) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return NextResponse.json({ brand: resolveBrand(host), realDeployment: realDeployment() }, { headers: { "cache-control": "no-store" } });
}
