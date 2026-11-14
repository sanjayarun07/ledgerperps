import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import Providers from "@/components/Providers";
import { brandCss } from "@/brand/theme";
import { realDeployment, resolveBrand } from "@/brand/resolve";
import { logoSrc } from "@/components/BrandBits";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// self-hosted by next/font at build time: no layout shift, no runtime request to Google
const ui = Inter({ subsets: ["latin"], variable: "--font-ui", display: "swap", weight: ["400", "500", "600"], adjustFontFallback: true });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap", weight: ["400", "500", "600"], preload: false });

const hostOf = async () => { const h = await headers(); return h.get("x-forwarded-host") ?? h.get("host"); };

export async function generateMetadata(): Promise<Metadata> {
  const b = resolveBrand(await hostOf());
  const icon = b.favicon ? logoSrc(b.favicon) : b.logo ? logoSrc(b.logo) : undefined;
  const title = b.tagline ? `${b.name} - ${b.tagline}` : b.name;
  const description = `${b.name}: ${b.tagline || "perpetual futures trading terminal"}. Local demo with mock USDC and a manual oracle.`;
  return { title, description, icons: icon ? { icon } : undefined, openGraph: { title, description, siteName: b.name, type: "website" }, twitter: { card: "summary", title, description } };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const brand = resolveBrand(await hostOf());
  const real = realDeployment();
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`} data-theme={brand.defaultTheme === "light" ? "light" : "dark"}>
      <head>
        {/* brand tokens are rendered on the server, so there is no flash of the default theme. All values are zod-validated (hex / enum). */}
        <style id="brand-css" dangerouslySetInnerHTML={{ __html: brandCss(brand) }} />
      </head>
      <body>
        <a href="#main" className="sr">Skip to trading</a>
        <Providers brand={brand} real={real}>{children}</Providers>
      </body>
    </html>
  );
}
