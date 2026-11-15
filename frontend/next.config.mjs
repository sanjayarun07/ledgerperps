import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
/** NEXT_PUBLIC_DEPLOYMENT_FILE=testnet makes `@/generated/deployment.json` resolve to src/generated/deployment.testnet.json (written by `pnpm sync:testnet`),
 *  so a testnet dev server never touches the LOCAL demo's deployment.json (which the :3147 server hot-reloads). */
const alt = process.env.NEXT_PUBLIC_DEPLOYMENT_FILE;
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true, devIndicators: false, distDir: process.env.NEXT_DIST_DIR || ".next",
  webpack(config) {
    if (alt) {
      const to = path.join(here, `src/generated/deployment.${alt}.json`);
      config.resolve.alias["@/generated/deployment.json"] = to; // as written in imports
      config.resolve.alias[path.join(here, "src/generated/deployment.json")] = to; // after the tsconfig `@/*` path mapping has resolved it
    }
    // Privy ships optional Solana support whose packages do not resolve together. We only use email + Ethereum wallets, so stub them out.
    for (const m of ["@solana/kit", "@solana-program/system", "@solana-program/token", "@solana-program/token-2022", "@solana-program/compute-budget"]) config.resolve.alias[m] = false;
    return config;
  },
};
export default nextConfig;
