# @perps/sdk (TypeScript) - UNAUDITED local prototype

viem-based client for the Perps exchange (single router address; modules behind it). Pinned deps, built with tsup, tested with vitest.

```bash
pnpm install && pnpm build        # dist/ (esm+cjs+d.ts)
pnpm gen:abi                      # regenerate src/abi.ts from contracts/abi/*.json (normalises stateMutability "undefined")
pnpm test                         # needs `cd contracts && npx hardhat node` running; deploys a FRESH exchange per run
pnpm tsx examples/01-quickstart.ts   # needs a deploy: npx hardhat run scripts/deploy.js --network localhost
```

All numbers are RAW bigints: price 1e6, size 1e8, USDC 1e6. Use `toPrice/toSize/toUsdc` (decimal strings -> raw) and `fromPrice/...`.

| Area | API |
|---|---|
| collateral | `deposit`, `withdraw`, `transferInternal`, `approveUsdc`, `mintMockUsdc` (local only) |
| orders | `placeOrder` (Tif.GTC/IOC/FOK/PostOnly, reduceOnly, cloid via `newCloid()`, expiry), `marketOrder` (IOC + `slippagePrice`), `cancelOrder`, `cancelAll`, `replaceOrder` |
| signed | `signOrder` / `PerpClient#signOrder` (EIP-712 `OrderAction`, domain `PerpExchange`/`1`), `placeSigned` (relay), agent keys `approveAgent`/`revokeAgent`/`agentExpiry` |
| advanced | `placeConditional`, `placeBracket`, `cancelConditional`, `executeConditional`, `placeTwap`, `executeTwapSlice`, `cancelTwap`, `setIsolated`, `addIsoMargin`, `removeIsoMargin` |
| keepers | `liquidate`, `isLiquidatable`, `pokeFunding`, `writeOff`, `syncBackstop`, `backstopEquity`, `adlHealth`, `principal`, `withdrawGateActive`, `adl`, `adlScore`, `adlDebt`, `recapitalize` |
| reads | `markets`, `marketConfig`, `markPrice`, `oracleStatus`, `bookSnapshot`, `accountState`, `isoState`, `positions`, `openOrders`, `getFills`, `watchFills` |
| helpers | `validateOrder`/`assertValidOrder` (tick, lot, min notional, max size), `roundPriceToTick`, `decodePerpError` -> `PerpError{errorName,args}` |
| indexer | `IndexerClient` (REST `/v1/*` + WS) - **UNVERIFIED until the indexer lands**; types are hand-written guesses |

Authentication: there are no API keys. Authority = owner wallet key, expiring trading-only agent keys, or per-order EIP-712 signatures that anyone may relay. See `examples/03-authentication.ts`.

Integration tests (`npm test`) deploy fresh contracts to a LOCAL hardhat node: default `http://127.0.0.1:18660` (`cd contracts && npx hardhat node --port 18660`), override with `PERP_RPC_URL`. Port 8545 is refused (on the dev machine it is the Nitro testnode's L1). Without a node they skip.

Gotchas found while testing (real behaviour of the deployed prototype):
* **Dev-chain clock drift**: every mined block advances `block.timestamp` by >= 1s, so a busy automining node runs far ahead of wall-clock. Deadlines/expiries must be built from chain time (`PerpClient#chainTime()`); `PerpClient#signOrder` does this. The standalone `signOrder` defaults to wall-clock+300s - pass `deadline` explicitly on dev chains.
* `cancelAll` is per **subaccount** (all markets), not per market.
* `PostOnly` orders that do not cross are NOT rested by the contract (known contract bug: they are cancelled). Use GTC with your own cross check until fixed.
* Agent `withdraw` acts on the *agent's own* account (so it just fails `Unhealthy`); agents can never touch the owner's funds.
