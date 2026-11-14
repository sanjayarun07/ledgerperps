# Frontend testnet label plan (for the frontend owner; NOT applied by the testnet preparation)

Goal: when connected to Arbitrum Sepolia (421614) the app must say it is a public testnet with test funds, not "LOCAL DEMO".
Banner text required: **`TESTNET - Arbitrum Sepolia - test funds only`** (keep the "Unaudited prototype contracts: do not use with real funds." notice).

| File (frontend/) | Current | Change |
|---|---|---|
| `src/brand/schema.ts` `BASE_BANNER` (line ~80) | `LOCAL DEMO - mock USDC, manual oracle, not real liquidity` | Make banner chain-dependent: 421614 -> `TESTNET - Arbitrum Sepolia - test funds only`; 31337/1337 keep LOCAL DEMO. `disclaimerText()` currently takes no chain id, add one. Do not let `NEXT_PUBLIC_REAL_DEPLOYMENT=1` hide it on testnet. |
| `src/brand/brand-render.test.tsx` (line ~29) | expects `LOCAL DEMO` | add a testnet case |
| `docs/WHITE_LABEL.md` (line ~22) | documents the always-shown LOCAL DEMO banner | document the testnet text |
| `src/app/layout.tsx` (line ~21) | description: "Local demo with mock USDC and a manual oracle." | derive from chain: "Public testnet (Arbitrum Sepolia), test funds only." |
| `src/lib/config.ts` | `IS_LOCAL` only 31337/1337; chain name `Perps chain`; `RPC_URL` default 127.0.0.1:8545; explorer none | add `IS_TESTNET = CHAIN_ID === 421614`; chain name `Arbitrum Sepolia`; add `blockExplorers: { default: { url: "https://sepolia.arbiscan.io" } }` to `defineChain`; testnet RPC from `NEXT_PUBLIC_RPC_URL` |
| `src/lib/config.ts` `usdcAbi` from `MockUSDC.json` | MockUSDC ABI (has `mint`) | Circle USDC has no public `mint`; use a plain ERC20 ABI (balanceOf/allowance/approve/decimals/symbol). Hide the mint button when `!IS_LOCAL` (already gated) and show a "Get test USDC" link to https://faucet.circle.com instead |
| `src/components/Header.tsx` (line ~112) | "Dev accounts (local demo only)" burner list | must stay hidden on 421614 (`NEXT_PUBLIC_DEV_BURNER` must not be set) |
| `src/generated/deployment.json` | local `env: LOCAL-DEMO` | produced by `node scripts/sync-deployment.mjs arbitrumSepolia`; `env` will read `TESTNET-ARBITRUM-SEPOLIA ...`; show it in a footer/status area |
| `src/lib/messages.ts` (line ~112) | "no-gas" copy mentions local | add Arbitrum Sepolia faucet pointers |
| Wallet add-chain (`src/test/injected-wallet.test.ts` shows the local variant) | local chain params | testnet: chainId 0x66eee, rpc from env, explorer above, ETH 18 decimals |

Also needed on testnet (feature work, not strings):
* Oracle status indicator per market (Chainlink age, Pyth age) - Pyth can be stale; trading will revert "stale source" until a pusher runs.
* Link every tx hash and the exchange address to https://sepolia.arbiscan.io.
* Markets: all three have Chainlink+Pyth feeds. Any future market without a feed must show `manual-oracle-only (testnet demo)`.
* Build env: see `env.testnet.example` (NEXT_PUBLIC_RPC_URL, NEXT_PUBLIC_CHAIN_ID=421614, NEXT_PUBLIC_INDEXER_URL).

## Update (round 3): DEMO-USD market and Backstop status

* A fourth market `DEMO-USD` (id 3) exists on testnet only. Its price is set by the admin through a ManualOracle behind a RoutingOracle: it is NOT a real feed. The UI must label it **`DEMO - admin-set price`** in the market list and show a banner on the ticket ("demo market, admin-set price, not a real feed"). Local chains keep their three markets and never show the tag. Marked the same way in `infra/testnet/testnet.config.json` (`demo.label`).
* The market list must be derived from `deployment.marketIds` (not a hardcoded 3), so DEMO-USD appears only when the deployment has it.
* Status popover has a "Backstop" entry: inventory notional vs soft threshold, auction active / price / discount, dashes when the contract or indexer cannot answer.
* Activity and notifications cover `BackstopElevated`, `BackstopTaken`, `BackstopUnwound`; `BackstopCap` has a plain-language message.
* Demo steps and expected output: `docs/TESTNET_RUNBOOK.md` section 16.
