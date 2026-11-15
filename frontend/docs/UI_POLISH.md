# UI polish pass (frontend only)

Screens: `docs/screens/polish/` (after, 1440x900, 1375x733, 1280x720, 1920x1080, 375x812, dark + light, default + Nova, plus Portfolio, Markets and the mobile ticket sheet). Before: `polish/before/`.
Tools: `scripts/dev/shoot.mjs` (headless Chrome over CDP: screenshots + in-page audits), `scripts/dev/type-audit.js`, `scripts/dev/overlap-audit.js`.

## What changed
- **Type**: Inter only (numbers too, tabular), scale 11/12/13/14/16/20/28, weights 400/500/600, no uppercase labels, no letter-spacing except the 28px price. Mono face removed from numbers. Chart axis uses the same family. Nova's humanist stack now starts with Avenir Next (Gill Sans rendered "1" like "I").
- **Spacing**: 4/8px grid, 8px gutters, every panel header 40px (chart, book, dock), controls 40px (Nova compact was 36, now 40), dense table/chip controls 32px, header 48, stat bar 56.
- **Ticket**: Direction > risk row > order type > price/size > slider+chips > time in force + post-only > TP/SL > Details (collapsed) ; the 4 key lines (est. entry, required margin, est. liquidation, fees) + checks + action button are a sticky footer, so they never scroll away.
- **Account overview**: pinned under the ticket; collapses (remembered) below 940px height; always inside the viewport (measured below).
- **Getting started**: header chip with progress + popover; no longer covers chart or dock.
- **Chart**: muted candles with matching borders, same-family axis, refined toolbar, icon fullscreen, mobile toolbar wraps. **Book**: asks/bids anchored on a centred spread row, grouping/unit on their own sub-row, skeleton rows match row height.
- **Positions**: stacked Entry/Mark, PnL/%, Margin/mode, TP/SL columns, so no horizontal scroll at 1280+.
- One icon set (`components/Icon.tsx`, 1.5px strokes) plus filled `Tri` direction markers replace mixed glyphs. Portfolio Deposit button no longer stretches. Next dev badge hidden.
- **Contrast**: `src/brand/contrast.test.ts` checks ~160 token pairs (both themes x both tenants) for AA. It found real failures (brand text on hover/control surfaces, light-theme long green); `deriveAccent` now checks every surface and tint, and `--long` (light) was darkened.

## Measured
- Type audit (all 5 viewports x light/dark x default/Nova): 0 violations across ~240 text nodes; one family (Inter 400/500/600 loaded via next/font); panel headers 40px; buttons 40/44; inputs 40.
- Account overview fully inside viewport: 1440x900 (756-864), 1375x733 (589-697), 1280x720 (576-684), 1920x1080.
- Gates: tsc, eslint, vitest (313 tests incl. new contrast suite), `next build` all green. Two test assertions updated: compact density is now `--ctl-h:40px`.

## Remaining flaws / unverified
- At <=800px height the ticket uses a short mode: inline labels for price/size, slider only (the 25/50/75/100 chips are hidden), 32px time-in-force select, one-line collapsed account overview. At 1280x720 and 1375x733 every field, TP/SL, Details, the 4 key lines, the action button and the account overview are visible with at most ~10px of scroll.
- Limit price sits above Position size (spec order lists size after order type) because price is part of the order type.
- 1m chart with sparse seeded trades still draws flat dashes (real data; not faked). Chart canvas colours do not re-tint volume bars on live theme toggle until next data tick.
- Quick-size chips and table actions are 32px, not 40.
- 375px checked headless (emulated), not on a device; hyperdash comparison was by structure only. Light/Nova at 1280 and 1920 not individually reviewed beyond the audits.

## Round 3: terminal-reference port (final state)
Design language aligned to the reference hyperliquid-style terminal (own brand, name and copy kept via the white-label tokens):
near-black ink palette (#080808 / #0e0e0e chrome / #161616 panels), emerald long #2fcb73, red short, Inter at 10.5 / 11.5 / 12.25 / 14 / 16 / 20 / 28,
10px radius, 6px gutters, collapsible left sidebar, market strip, pair bar, chart with Chart/Book tabs when folded, order book, ticket
(Cross/leverage, Market/Limit/Advanced, Buy/Sell, available + position lines, size with unit toggle and slider, TIF, TP/SL, sticky submit bar),
collapsible account overview, dock tabs Balances / Positions / Open orders / Trade history / Funding history / Order history.

Verified at 1440x900, 1375x733, 1280x720, 1920x1080, 375x812, dark and light, default and Nova tenants (screens: `docs/screens/polish/final-*`).
Gates: tsc clean, eslint src 0 problems, vitest 316/316 (includes AA contrast suite over both themes x both tenants), next build OK (separate dist dir, removed).
Type audit: 0 violations at 1440x900, 1280x720, 1920x1080, 1375x733, 375x812. Overlap audit: account overview fully visible at every desktop size.
Not done: reference ticket extras (Reduce only checkbox, size % input, slippage list) are not added; Nova dark and tablet widths (768-1279) got only a visual spot check.

## Order types and dock (2026-11-15)
Ticket tabs: **Market** (size, % slider, max slippage, reduce-only, TP/SL), **Limit** (price, TIF GTC/IOC/FOK, post-only, good-until 1h/24h/7d, reduce-only, TP/SL), **Advanced** with a type selector: Limit (all options, signed relay on local), Stop / Take-profit (stop-market, stop-limit, take-profit-market, take-profit-limit via `placeConditional`; direction derived from kind and side, trigger checked against the mark), TP/SL on position (`placeBracket`), TWAP (`placeTwap`), Scale (2 to 10 limit orders across a price range, one transaction each because the exchange has no batch call). Pure logic and tests: `lib/order.ts` (`triggerAbove`, `validateTrigger`, `scaleLevels`, `validateScale`). Dock: Triggers and TWAPs are now first-class tabs, plus a Cancel all orders action.
Not built (no contract support): Chase, Swarm, VWAP, POV, Iceberg, Chase TWAP. Not verified: placing any of the new order types with a connected wallet on testnet (forms render and validate; no transaction was sent from the new forms).
