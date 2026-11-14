"use client";
import { useBrand } from "@/brand/context";
import { BASE_NOTICE } from "@/brand/schema";

/** data URL for inline SVG logos: rendered through <img>, so scripts in a tenant-supplied SVG can never run. */
export const logoSrc = (logo: string) => (logo.trim().startsWith("<svg") ? `data:image/svg+xml;utf8,${encodeURIComponent(logo.trim())}` : logo);

export function Wordmark({ size = 24 }: { size?: number }) {
  const { brand } = useBrand();
  return (
    <span className="brand">
      {brand.logo
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={logoSrc(brand.logo)} alt="" width={size} height={size} style={{ objectFit: "contain" }} />
        : (
          <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden>
            <rect x="1" y="1" width="24" height="24" rx="5" fill="none" stroke="var(--brand)" strokeWidth="1.6" />
            <path d="M5 18h5l3-8 3 5 2-3h3" fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      <span>{brand.name}</span>
    </span>
  );
}
/** Mandatory demo / unaudited notice. Tenants can extend it; only NEXT_PUBLIC_REAL_DEPLOYMENT=1 lets an operator replace it. */
export function DemoBanner() {
  const { banner } = useBrand();
  return <div className="demo" role="note">{banner}</div>;
}
export function NoticeLine() {
  const { brand, real } = useBrand();
  return <p className="foot-note">{real && brand.disclaimer.override ? "" : `${BASE_NOTICE} `}{brand.footerText}</p>;
}
