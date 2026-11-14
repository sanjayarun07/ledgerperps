# White-label guide

One build serves many brands. Brand is data, validated by a zod schema (`src/brand/schema.ts`), turned into CSS variables on the server (no theme flash), and exposed to components through `useBrand()`.

## Resolution order (later layers override earlier ones, objects merge, arrays are replaced)
1. `brand.config.json` (default brand)
2. env `BRAND_CONFIG` (inline JSON) or `BRAND_CONFIG_PATH` (file)
3. `tenants/<host>.json`, chosen by request host (port stripped), e.g. `tenants/nova.localhost.json`. Directory override: `BRAND_TENANT_DIR`.
4. `GET /api/brand` returns the resolved brand (read only) for other clients.

An invalid tenant file logs an error and falls back to the base brand. It never crashes the page.

## What a tenant can change
name, shortName, tagline, logo (https URL, path, or inline SVG/data URL under 100 KB), favicon, accent colour, neutral palette (graphite, slate, ink), font stack, radius, density, default theme, nav items, docs/terms/privacy/social/support links, copy overrides (welcome, empty states, hero), markets shown and their order, collateral label, explorer tx URL, faucet URL, and the feature flags below.

Accent contrast is checked (WCAG). Button text colour is picked automatically and a failing accent is nudged to a readable one; warnings are shown in Brand Studio.

## Feature flags
twap, conditionals, isolatedMargin, signedRelay, agentKeys, subaccounts, tour, advancedTab, commandPalette, leaderboard and explore (reserved, no page yet), studio. A disabled feature disappears from the UI (tabs, sections, palette entries, shortcuts), it is not greyed out.

## Disclaimer rule
The banner "LOCAL DEMO - mock USDC, manual oracle, not real liquidity" is always shown. A tenant can append text with `disclaimer.extra`. `disclaimer.override` replaces the base text only when `NEXT_PUBLIC_REAL_DEPLOYMENT=1`; otherwise it is ignored.

## Brand Studio
`/brand` is a 404 unless `features.studio` is true or `BRAND_STUDIO=1`. It edits a local copy, shows contrast warnings and a live preview, exports `brand.config.json` as a browser download and imports one from a local file. It writes nothing on the server and makes no network calls.

## Env vars
`BRAND_CONFIG`, `BRAND_CONFIG_PATH`, `BRAND_TENANT_DIR`, `BRAND_STUDIO`, `NEXT_PUBLIC_REAL_DEPLOYMENT`.

## Try it
`npm run dev`, open `http://localhost:3000` (default brand) and `http://nova.localhost:3000` (sample tenant). `*.localhost` resolves to loopback in Chrome and Firefox.

## Still deployment-level (not per tenant)
Chain id, RPC, contract addresses and indexer URL (env + `src/generated/deployment.json`), wallet connector list, language and currency display, analytics (only a disabled no-op hook exists).
