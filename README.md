# Ledgerline Perps: an on-chain perpetual futures exchange (prototype)

> **UNAUDITED PROTOTYPE. TESTNET ONLY. Do not put real funds near it.**
> It runs on Arbitrum Sepolia with free test USDC. Order-book liquidity there is **simulated** by our own bots. The contracts have had a
> self-review by the same party that helped write them (see `docs/SELF_AUDIT.md`), **not** an independent audit. It is not mainnet-ready.

The order book, positions, margin, funding and liquidations live in Solidity contracts (about 2,000 lines, OpenZeppelin building blocks only).
The keeper, indexer, frontend and bots are derived infrastructure with no authority over balances. The matching engine is our own
price-time-priority central limit order book, written in the contracts; it is not a library.

## Live testnet (Arbitrum Sepolia, chain id 421614)
Deploy #5, 2026-11-16 (addresses change on every redeploy; the source of truth is `contracts/deployments/arbitrumSepolia.json`):

| What | Address |
|---|---|
| Exchange (router) | `0x5524Edf75e1eE356FeA9557E6f209D06ce4768E8` |
| Test collateral (free-mint `MockUSDC`, **not real USDC**) | `0x47c6642D916b3E097EDe6f543359DB5b671E28B3` |
| Oracle router | `0x5Da99394406cDd548b92FdaBCF45db0B4F84a234` |

- **Markets:** BTC-USD, ETH-USD, SOL-USD priced by Chainlink feeds with sanity bounds, and DEMO-USD, an **admin-set price** (not a real feed) used to demo liquidation and the backstop.
- **What is real:** the oracle prices, and on-chain matching, margin, funding and liquidation logic.
- **What is simulated:** all liquidity (our market-maker bot and a small taker), and the collateral. Treat charts and depth as a demo, not market data.
- **Checks on deploy #5:** a 14-step live smoke test passed; backstop enabled for BTC-USD and DEMO-USD; module table still **unlocked** (admin can replace modules).
- **Verified on testnet:** a DEMO-USD liquidation to the backstop and its Dutch auction (admin-set price, so it says nothing about real-market behaviour).
- **Not yet verified on testnet:** liquidation on a real feed, ADL, multi-interval funding accrual with the new sampling cap, and the email-wallet signing/MFA flow end to end.

## What the contracts implement
Price-time-priority CLOB with bounded matching; GTC / IOC / FOK / post-only / reduce-only; cross **and isolated** margin; tiered initial and maintenance
margin; funding with lazy settlement and capped premium sampling; permissionless liquidation to a backstop account with a Dutch-auction unwind; insurance fund;
**ADL** and `recapitalize`; stop, take-profit and bracket orders; **TWAP**; EIP-712 / EIP-1271 relayed and signed orders; trading-only agent (session) keys with
optional market and notional scopes; subaccounts (up to 32 open orders each); market states including delisting and final settlement; bounded per-market parameter updates.
Units and formulas: `docs/SPEC.md`. Known gaps: `docs/GAPS.md`.

Design note: one contract was split into a router plus five delegatecall modules (`PerpTrading`, `PerpExtras`, `PerpLiquidation`, `PerpTwap`, `PerpAdl`, shared
storage in `PerpBase`) to fit the EIP-170 size limit. The module table is admin-controlled until `lockModules()`; treat module registration as an upgrade power.

## Layout
| Path | What |
|---|---|
| `contracts/` | Solidity contracts, Hardhat tests, Foundry tests, testnet deploy and ops scripts (`scripts/testnet/`) |
| `services/keeper/` | Rust keeper: funding pokes, liquidation, conditional and TWAP triggers, ADL, backstop sync |
| `services/indexer/` | Rust indexer with REST and WebSocket API on PostgreSQL (derived from chain events, never authoritative) |
| `frontend/` | Next.js trading terminal ("Ledgerline"); email login via Privy; `/maker` console for placing quote ladders by hand |
| `sdk/ts`, `sdk/python` | SDKs. The TypeScript indexer client is checked against the live indexer; the Python SDK lacks conditional, TWAP, isolated and ADL wrappers |
| `bots/` | Simulated market makers (a 3-tier thick BTC ladder over several subaccounts), a separate 20 s taker so the 1-minute chart moves, local-dev helpers |
| `infra/` | Testnet scripts (`infra/testnet/`), docker-compose, monitoring and cloud templates (the cloud templates are unverified) |
| `docs/` | See below |

## Tests (last run 2026-11-16)
- Hardhat: **141 passing** (`cd contracts && npx hardhat test`, about 4 minutes; includes fuzz and stress suites).
- Foundry: 26 tests (last recorded; needs Foundry installed, not re-run in this update).
- Bots: 52 passing. SDK: unit tests pass; live-chain suites are skipped by default.

## Quickstart
**Local demo (no wallet needed):**
```bash
cd contracts && pnpm install
npx hardhat node                                          # terminal 1
npx hardhat run scripts/deploy.js --network localhost     # terminal 2: mock USDC + manual oracle
```
Then see each component's own README for the indexer, frontend, keeper and bots. There is no verified single command that starts the whole stack.

**Run the testnet UI against the live deployment:**
```bash
cd frontend && npm install && npm run dev:testnet         # http://localhost:3150 (needs the indexer and RPC forwarder from infra/testnet/run-indexer.sh)
```
Operations (deploy, smoke test, indexer, keeper, bots) are in `docs/TESTNET_RUNBOOK.md`. After any redeploy follow its section 18.
Keys: use fresh testnet-only keys, keep them in git-ignored env files or your shell, never commit or paste them. The deployer key must never run bots.

## Deploy and set up from scratch (Arbitrum Sepolia testnet)
Run commands from the repo root unless a `cd` is shown. Everything is testnet only. Never use a key that holds real funds.

**0. Prerequisites:** Node 20+ with pnpm and npm, Rust (`cargo`), PostgreSQL running locally, and optionally Foundry. A public Arbitrum Sepolia RPC works for a quick start; a keyed RPC is better for bots.

**1. Install and build**
```bash
(cd contracts && pnpm install)
(cd frontend && npm install)
(cd bots && pnpm install)
(cd services/indexer && cargo build --release --locked)     # then set INDEXER_BIN if the path differs, see infra/testnet/run-indexer.sh
(cd services/keeper && cargo build --release --locked)
```

**2. Keys and gas.** Create a fresh testnet-only deployer key and keep it in your shell or a git-ignored env file (`DEPLOYER_PRIVATE_KEY`). Fund it with Arbitrum Sepolia ETH
(a faucet, or bridge Sepolia ETH through the Arbitrum Inbox). Create separate keys for the roles below; none of them may be the deployer key:
`npx tsx src/testnet-mm.ts keygen` (market maker) and `npx tsx src/testnet-taker.ts keygen` (taker), both run in `bots/`, and your own keeper key (`KEEPER_PRIVATE_KEY`, shell only).

**3. Configure.** Markets, risk tiers, oracle feeds and feed sanity bounds are in `infra/testnet/testnet.config.json`. Check the feed addresses on-chain first:
```bash
cd contracts
npx hardhat --config hardhat.testnet.config.js run scripts/testnet/verify-addresses.js --network arbitrumSepolia
```

**4. Deploy** (dry run first; it sends nothing without the confirm variable)
```bash
ORACLE_MODE=chainlink USE_MOCK_USDC=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/deploy-testnet.js --network arbitrumSepolia
ORACLE_MODE=chainlink USE_MOCK_USDC=yes CONFIRM_TESTNET_DEPLOY=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/deploy-testnet.js --network arbitrumSepolia
```
This writes `contracts/deployments/arbitrumSepolia.json` (refuses to overwrite an existing one: archive the old file first). `USE_MOCK_USDC=yes` deploys a free-mint test token.
Mint some to the deployer for the smoke test: `TO=<deployer> AMOUNT=2000 CONFIRM_MINT=yes npx hardhat ... run scripts/testnet/mint-test-usdc.js --network arbitrumSepolia`.

**5. Prove it works, then enable the backstop** (same `--config hardhat.testnet.config.js ... --network arbitrumSepolia` flags)
```bash
CONFIRM_TESTNET_SMOKE=yes npx hardhat ... run scripts/testnet/smoke-testnet.js ...     # expect 14 ok
CONFIRM_ENABLE_BACKSTOP=yes npx hardhat ... run scripts/testnet/enable-backstop.js ...
```
Run `lock-modules.js` only when you will not redeploy; it makes the module table permanent.

**6. Start the services**
```bash
infra/testnet/run-indexer.sh reset            # starts the RPC forwarders and the indexer on a fresh database, from the deployment's start block
export KEEPER_PRIVATE_KEY=0x...               # your keeper key, shell only
KEEPER_FUNDING_INTERVAL_SECS=120 KEEPER_LIVE=yes infra/testnet/run-keeper.sh start
cd frontend && node scripts/sync-deployment.mjs arbitrumSepolia --out deployment.testnet.json && npm run dev:testnet    # http://localhost:3150
```
For email login set `NEXT_PUBLIC_PRIVY_APP_ID` (a public app id from dashboard.privy.io) before starting the frontend. Fund the keeper with a little ETH (about 0.02).

**7. Add simulated liquidity** (in `bots/`; fund each bot address with ETH and mint it test USDC first)
```bash
MM_DEPOSIT_USDC=149800 CONFIRM_MM_SETUP=yes npx tsx src/testnet-mm.ts setup
DEPTH=thick CONFIRM_MM_FANOUT=yes npx tsx src/testnet-mm.ts fanout
DEPTH=thick npx tsx src/testnet-mm.ts preflight                                  # exits 1 on errors
DEPTH=thick MARKETS=BTC-USD TAKER_EVERY_SEC=0 npx tsx src/testnet-mm.ts run
TAKER_DEPOSIT_USDC=500 CONFIRM_TAKER_SETUP=yes npx tsx src/testnet-taker.ts setup && TAKER_EVERY_SEC=20 npx tsx src/testnet-taker.ts run
```
Details and sizing: `docs/PAPER_TRADING.md`.

**8. Use it.** Open the UI, sign in, mint test USDC from the account panel ("Get 1,000 test USDC"), deposit, and trade. `/maker` is the hand-placed quote ladder console.

**9. Keep it healthy.** The DEMO-USD price goes stale after 30 minutes: `CONFIRM_REFRESH_DEMO=yes npx hardhat ... run scripts/testnet/refresh-demo-price.js ...`.
Watch ETH balances for the bots and keeper, and re-run steps 3 to 7 (plus `docs/TESTNET_RUNBOOK.md` section 18) after every redeploy.

**Mainnet is not covered.** It needs independent audits, a timelock and multisig, a sequencer-uptime check and more (`docs/PRODUCTION_READINESS.md`).

## New in deploy #5
`batchPlace` / `batchCancel` / `requote`, a 3-slot order layout (about 22k gas less per resting order, measured live), a maker rebate (taker 5 bps, maker -1 bp) and the `MarketMakerVault` contract. The vault is **source and tests only: not deployed**. See `docs/GAS_REPORT.md`, `docs/VAULT.md` and `docs/DEPLOY_5_CHECKLIST.md`.

## Docs
| Doc | Read it for |
|---|---|
| `docs/ARCHITECTURE.md`, `docs/SPEC.md` | How it is built; units and formulas |
| `docs/SELF_AUDIT.md` | Our own review: findings SA-1 to SA-10 and their status. **Not an independent audit** |
| `docs/THREAT_MODEL.md`, `docs/GAPS.md`, `docs/PRODUCTION_READINESS.md` | Risks, known gaps and what must happen before any mainnet use |
| `docs/BACKSTOP_DESIGN.md` | Liquidation backstop and auction design |
| `docs/TESTNET_RUNBOOK.md`, `docs/RUNBOOKS.md` | Deploying and operating on testnet |
| `docs/PAPER_TRADING.md` | The thick-book paper-trading setup and the simulated taker |
| `docs/MARKET_MAKER_GUIDE.md` | How an outside market maker connects through the SDK, and how it differs from Hyperliquid |
| `docs/DEPENDENCIES.md`, `docs/MARKET_LAUNCH.md`, `docs/BENCHMARKS.md`, `docs/LAUNCH_CHECKLIST.md` | Supporting detail |

## Known limits (short list)
- **Self-audit open items:** SA-3 (mark price is book mid, manipulable on a thin book), SA-4 (single admin, no timelock or multisig, modules replaceable until locked),
  SA-5 (no L2 sequencer-uptime check), SA-6 to SA-7 (liveness and USDC dependency), SA-9, SA-10. SA-1, SA-2 and SA-8 are fixed in the deployed source.
- **Cost and speed:** every order is an on-chain transaction (about 350k gas for a resting order on testnet) and latency is bounded by the chain. See the
  discussion of economics and options in the project notes; nothing here is a throughput or cost claim for mainnet.
- **Testnet only:** collateral is a free-mint token, liquidity is simulated, and prices in the UI are not market data.
- **Mainnet blockers:** independent audits, a timelock and multisig, the sequencer-uptime check, and economic simulation. See `docs/PRODUCTION_READINESS.md`.

## Licence
No licence has been chosen yet, so by default all rights are reserved. Add one before inviting reuse.
