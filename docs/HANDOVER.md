# Ledgerline: developer handover (setup and technical explanation)

Written 2026-11-17 for the incoming dev team. Covers deploy #5 on Arbitrum Sepolia (chain 421614), source at the commit of this file.

**Read this first.** Ledgerline is an UNAUDITED prototype on a TESTNET. Collateral is a free mintable token (`tUSDC`, MockUSDC). Part of the liquidity is simulated by bots we run. Nothing here is audited, formally verified or mainnet-ready, and it must not be described that way. Anything marked "NOT VERIFIED" in section 11 has not been seen working on a public chain.

Other docs go deeper on single topics; this file is the map. Where this file and a deeper doc disagree, the code wins, then the deeper doc, then this file; please fix the doc.

---

## 1. What it is

A perpetual-futures exchange in the style of Hyperliquid, with its own on-chain central limit order book (CLOB) and clearinghouse. There is no off-chain matching engine: every order, fill, margin check, funding payment and liquidation is decided by EVM execution. The only off-chain parts are helpers (keeper, indexer, bots, UI) that hold no authority over balances.

| Feature | State |
|---|---|
| Markets | BTC-USD, ETH-USD, SOL-USD (Chainlink-priced), DEMO-USD (admin-set price, for demos only; id 3) |
| Margin | cross and isolated, tiered by whole-position notional |
| Orders | GTC, IOC, FOK, post-only, reduce-only, client order ids, expiry, TP/SL conditionals, brackets, TWAP |
| Batch | `batchPlace`, `batchCancel`, `requote` (cancel and place in one transaction), up to 32 items |
| Fees | taker 5 bps, maker -1 bp (a rebate funded by the taker fee) |
| Risk | funding, liquidation (partial, close factor), insurance fund, backstop with Dutch-auction inventory sale, auto-deleveraging (ADL), delisting settlement |
| Accounts | sub-accounts (0-9 per owner), session keys ("agents") with scope limits, EIP-712 signed orders (relayable) |
| Vault | `MarketMakerVault` (pooled market making). Written and tested, NOT deployed |
| Off-chain | Rust keeper, Rust indexer (Postgres, REST and WebSocket), TypeScript and Python SDKs, TypeScript bots, Next.js frontend with Privy email login |

Only OpenZeppelin 5.1.0 is used as an external contract dependency.

## 2. Repository map

```
contracts/            Solidity (hardhat 2.22 + foundry), tests, deploy and testnet scripts
  src/                PerpBase (storage + shared logic), PerpExchange (router), PerpTrading, PerpExtras,
                      PerpLiquidation, PerpTwap, PerpAdl, Governance, MarketMakerVault, oracles/, mocks/
  test/               hardhat tests (JS) ; foundry-test/ = Foundry fuzz, invariant and stress suites
  scripts/            deploy.js (local), export-abi.js, testnet/* (Arbitrum Sepolia operations)
  deployments/        arbitrumSepolia.json = THE source of truth for addresses (+ archived earlier deploys)
services/
  indexer/            Rust: chain events -> Postgres -> REST/WS API
  keeper/             Rust: funding pokes, liquidations, TWAP slices, ADL, backstop upkeep, write-offs
sdk/ts, sdk/python    clients (viem; web3). TS ABI is generated from the contracts
bots/                 TypeScript: market maker, taker, oracle driver, seed (local); testnet-mm, testnet-taker (Sepolia)
frontend/             Next.js 15 / React 19 app (terminal, /maker console, /builder, brand studio)
infra/
  testnet/            everything for the Sepolia stack: run-indexer.sh, run-keeper.sh, rpc-proxy.js, configs
  docker-compose.yml  LOCAL dev stack (hardhat chain, postgres, redis, prometheus, grafana)
  nitro*, helm, terraform   exploratory; not used by the testnet stack
docs/                 SPEC, ARCHITECTURE, THREAT_MODEL, SELF_AUDIT, GAPS, RUNBOOKS, TESTNET_RUNBOOK, VAULT, GAS_REPORT, ...
```

## 3. Prerequisites

| Tool | Notes |
|---|---|
| Node 22, pnpm | contracts, SDK, bots; frontend uses npm or pnpm scripts |
| Rust (cargo) | to build the keeper and indexer |
| PostgreSQL | the testnet indexer uses a local DB named `perps_testnet` |
| Foundry (optional) | `forge test` for the invariant and stress suites |
| Docker (optional) | only for the local `make up` stack |
| A funded testnet wallet | Arbitrum Sepolia ETH for gas. A separate key per role (see section 9) |

## 4. First-time setup and tests (no keys, no network)

```bash
# contracts: compile and run the full suite
cd contracts && pnpm install --frozen-lockfile && npx hardhat compile && npx hardhat test
```
Last recorded result: 141 passing. The suite includes unit, fuzz (fast-check), model-based stress, batch, fee and vault tests. Foundry suites: `cd contracts && forge test`.

```bash
# SDK, bots, frontend
cd sdk/ts   && pnpm install && pnpm build && pnpm typecheck       # `pnpm test` needs a local hardhat node
cd bots     && pnpm install && pnpm typecheck && pnpm test         # 52 unit tests, no node needed
cd frontend && npm install  && npm run typecheck && npm test       # vitest
# services
cd services/keeper  && cargo build --release --locked && cargo test
cd services/indexer && cargo build --release --locked && cargo test
```
Test counts other than the contracts' were recorded earlier and may have drifted; treat a red suite as a finding, not as noise.

Local end-to-end stack (hardhat chain with mock oracle, deploy, seed, monitoring): `make up` (needs Docker). Details in the top-level `README.md` and `docs/RUNBOOKS.md`.

ABI flow after any contract change: `cd contracts && npx hardhat run scripts/export-abi.js`, then `cd sdk/ts && pnpm gen:abi` (regenerates `src/abi.ts`; there is a pinned entry-count test in `sdk/ts/test/units.test.ts` that you must update), then `cd frontend && node scripts/sync-deployment.mjs arbitrumSepolia`. The Python ABI is `sdk/python/src/perps_sdk/abi/exchange.json`.

## 5. Running the Arbitrum Sepolia stack

Everything reads `contracts/deployments/arbitrumSepolia.json`; no address is hardcoded elsewhere. Current deploy #5: exchange `0x5524Edf75e1eE356FeA9557E6f209D06ce4768E8`, token `0x47c6642D916b3E097EDe6f543359DB5b671E28B3` (MockUSDC), start block 329840006. Earlier deploys are archived next to it.

| Service | Start | Port |
|---|---|---|
| RPC forwarders + indexer | `infra/testnet/run-indexer.sh start` | indexer API :18700; forwarders :18701 (indexer/bots) and :18702 (browser) |
| Keeper (dry-run) | `infra/testnet/run-keeper.sh start` | metrics :9150 |
| Keeper (live) | see section 9 | metrics :9150 |
| Frontend (testnet mode) | `cd frontend && npm run dev:testnet` | :3150 |
| Ladder bot | `cd bots && DEPTH=thick MARKETS=BTC-USD npx tsx src/testnet-mm.ts run` | none |
| Taker bot | `cd bots && TAKER_EVERY_SEC=20 npx tsx src/testnet-taker.ts run` | none |

Why forwarders exist: the Rust services have no TLS client, so they talk to a local HTTP forwarder (`infra/testnet/rpc-proxy.js`) that calls the HTTPS RPC, chunks large batches, spaces upstream calls and retries on 429/5xx.

**Forwarder pitfalls (learned the hard way).**
* The :18701 forwarder allows ONE upstream call at a time and is shared by the indexer, bots and frontend. A heavy client starves the rest. The live keeper's first replay (about 220k blocks) made no progress for 14 minutes behind them. Give the keeper its own forwarder:
  `UPSTREAM_RPC_URL=https://arbitrum-sepolia-rpc.publicnode.com PROXY_PORT=18703 PROXY_CONCURRENCY=3 PROXY_MIN_GAP_MS=150 node infra/testnet/rpc-proxy.js`
  then start the keeper with `KEEPER_RPC_URL=http://127.0.0.1:18703`. The first replay then took about 3 minutes.
* A forwarder can hang; restart it and the clients recover. A bot stops itself after 20 consecutive failures.
* A bot or keeper wallet that runs out of ETH shows up as "total cost exceeds the balance" errors. Fund it (`contracts/scripts/testnet/send-eth.js`).

After any redeploy: move the old `arbitrumSepolia.json` aside (the script refuses to overwrite), deploy, sync the frontend deployment, `infra/testnet/run-indexer.sh reset`, restart keeper and bots. Full procedure: `docs/TESTNET_RUNBOOK.md` sections 16 to 18 and `infra/testnet/README.md`.

### Environment variables (names only; never commit values)

| Where | Variables |
|---|---|
| `contracts/.env` (git-ignored) | `DEPLOYER_PRIVATE_KEY`, `ARB_SEPOLIA_RPC_URL`, optional `ARBISCAN_API_KEY`, `GUARDIAN_ADDRESS`; per-script `CONFIRM_*` switches |
| `bots/.env.mm-testnet`, `.env.taker-testnet` | `MM_PRIVATE_KEY`, `TAKER_PRIVATE_KEY` |
| keeper (your shell only) | `KEEPER_PRIVATE_KEY`, `KEEPER_LIVE=yes`, `KEEPER_RPC_URL`, `KEEPER_FUNDING_INTERVAL_SECS`, optional `KEEPER_HERMES_API_KEY` |
| frontend | `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_NETWORK_KIND`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_INDEXER_URL`, `NEXT_PUBLIC_EXPLORER_URL`, `NEXT_PUBLIC_PRIVY_APP_ID` (enables email login) |
| indexer / keeper compose | see `infra/testnet/env.testnet.example` |

## 6. Architecture

```
            Arbitrum Sepolia
   ┌───────────────────────────────────────────────────────┐
   │ PerpExchange (router, holds ALL state)                │
   │   delegatecall → PerpTrading   (orders)               │
   │                → PerpExtras    (batch, replace, ...)  │
   │                → PerpLiquidation                      │
   │                → PerpTwap, PerpAdl                    │
   │ RoutingOracle → ChainlinkAdapter, ManualOracle (DEMO) │
   └───────▲───────────────▲──────────────▲────────────────┘
           │ txs           │ txs          │ events (logs)
  frontend/SDK/bots     keeper           indexer ──► Postgres ──► REST + WS ──► frontend
```

**Module router.** `PerpExchange` is the only address users call. Functions live in modules (`PerpTrading`, `PerpExtras`, `PerpLiquidation`, `PerpTwap`, `PerpAdl`) reached by `delegatecall`, all sharing the storage layout of `PerpBase`. This exists to stay under the 24,576-byte EIP-170 limit (the router is 23,105 bytes, `PerpExtras` 20,719 bytes: little headroom). Selectors are registered with `registerModule`; the deploy script and the test helper auto-register every selector from the module ABIs. `lockModules()` freezes this, and it has NOT been called: until then the admin can swap logic, i.e. it is an upgrade power.

`placeFor` is a self-call: the router calls itself so batch code can use try/catch around one order. It must stay unreachable from outside.

**Units.** price 1e6 (USDC per base unit), size 1e8 (1e8 = 1 BTC, signed), USDC 1e6, funding rate 1e12 = 100%, fees and margin in bps. Account key = `keccak256(abi.encode(owner, sub))`.

**Order book.** Each side of each market is a doubly linked list of price levels (`Level{total, head, tail, nextPrice, prevPrice}`), and the orders inside a level form a FIFO queue (time priority). Bounds: 16 price levels and 40 maker touches per match, a 64-level insertion walk, 32 open orders per account (`MAX_OPEN_ORDERS`), 16 conditionals per account. A GTC that hits a bound rests nothing for the remainder and emits `OrderTruncated`. Self-trade cancels the resting maker. Cancel/replace always loses time priority. An ordinary fill executes only if the resting price is within `bandBps` of the current index; otherwise the resting order is cancelled.

**Order storage.** The `Order` struct was packed from 4 to 3 storage slots in deploy #5 (`reserve` uint96, `prev`/`next` uint48, `expiry` uint32). The `orders(id)` getter tuple is now: acct, size, reserve, market, isBuy, reduceOnly, price, expiry, prev, next, cloid. Anything decoding it by position (SDKs, indexer) must match; the TS and Python SDKs were updated.

**Margin and PnL.** Equity = collateral + unrealised PnL - unsettled funding. Initial and maintenance margin are tiered on whole-position notional (BTC: 10%/5% up to 100k USDC notional, 20%/10% to 1M, 50%/25% above). Withdrawable = max(0, min(collateral, equity) - IM - reserved order margin); unrealised profit is not withdrawable. Open orders reserve margin (opposing orders are not netted). Rounding is always against the user; dust goes to the protocol. Formulas and worked examples that are asserted in tests: `docs/SPEC.md`.

**Mark and index.** Index comes from the oracle. Mark = book mid, clamped to index ± `bandBps`, only if the book is two-sided, uncrossed and the spread is within `maxSpreadBps`; otherwise the index. Last trade price is never used. Oracle mode is Chainlink with per-feed sanity bounds and a stale-round check (SA-8). A stale feed on an unrelated market is valued at the last good index moved 20% in the account's favour for liquidation purposes (`STALE_FAV_BPS`, a constant).

**Funding.** `pokeFunding(market)` is permissionless. It samples premium = (mark - index)/index as a step function; each sample is capped at `MAX_SAMPLE_HOLD` = 300 s (SA-2), so the keeper must poke at least every 60-120 s or the sampled average stops tracking. Once per `fundingInterval` (3600 s) the rate = clamp(time-weighted average premium / `premiumDivisor`, ±cap) is applied; positive rate means longs pay shorts. Pays round up, receipts down; the residual sits in `fundingPool`.

**Fees.** Taker fee = ceil(notional × bps). Maker fee may be negative (rebate, rounded down). `setFees` enforces |maker| ≤ taker so one fill can never pay more rebate than the taker paid. Defaults: taker 5 bps, maker -1 bp. `FeesUpdated` is emitted on change.

**Liquidation.** An account with equity below maintenance margin can be liquidated by anyone (`liquidate`). A close-factor fraction of the position moves to the BACKSTOP account at mark; a fee is split between keeper and insurance. Any negative leftover is written off (insurance first, then `unresolvedBadDebt` and per-market `adlDebt`). `settleDelisted` and the permissionless `writeOff` handle delisted markets and flat negative buckets.

**Backstop.** The backstop is an internal account that inherits liquidated positions. `syncBackstop()` (permissionless; also run inside liquidation, ADL and withdraw) books its mark-to-market deficit against insurance first, then as bad debt. When its inventory exceeds a per-market soft threshold the market is "elevated": `takeBackstop` sells it to takers on a Dutch auction (price steps from the index toward a maximum discount after a dwell time), and after `maxAge` `unwindBackstop` closes the excess at mark against profitable opposite positions. Off unless `softNotional` is set per market (`enable-backstop.js`; enabled for BTC-USD and DEMO-USD on deploy #5). Design and accounting: `docs/BACKSTOP_DESIGN.md`, `docs/SPEC.md`.

**ADL.** When bad debt exceeds insurance, profitable opposite positions are haircut in score order (`adl`). The concession is capped by the target's equity minus maintenance, so ADL never creates a new liquidation. While `unresolvedBadDebt` exceeds a threshold, withdrawals above an account's deposited `principal` revert (`WithdrawGated`); deposits, closes and cancels still work.

**Ledger identity** (tested): Σcollateral + Σ isolated margin + insurance + feePool + fundingPool - unresolvedBadDebt + dust = deposits - withdrawals. A broken identity in any test is a P0.

**Authority.** `DEFAULT_ADMIN_ROLE` sets markets, fees, oracle and backstop parameters. `GUARDIAN_ROLE` can only restrict (pause, tighten). Agents (session keys) can place and cancel within an expiry, market mask and max order notional but can never call `withdraw` or `transferInternal`. EIP-712 signed orders (`OrderAction`, domain `PerpExchange`/`1`) allow relaying. Today admin and deployer are the same EOA `0x50C0…6B29`, there is no guardian address set, no timelock is wired in, and the module set is unlocked.

**Market-making vault** (`MarketMakerVault`, NOT deployed; `docs/VAULT.md`). Depositors hold ERC-20 shares (`LLMM`, 12 decimals) of a pooled exchange sub-account; share price = NAV (idle USDC + exchange equity) over shares, with virtual shares as an inflation guard. A protocol-run operator trades via a scoped agent key that cannot withdraw. Deposit cap, lock period (≤ 7 days, inherited on share transfer), guardian can pause deposits, redeems are never blocked by the vault (limited by free liquidity). `totalAssets()` reverts on a stale oracle (fail closed). The trust model is explicit: a bad or malicious operator can lose depositor funds.

## 7. Off-chain services

**Keeper (`services/keeper`, Rust).** Permissionless; holds no roles. Jobs: funding pokes, liquidations, conditional (TP/SL) execution, TWAP slices, ADL, write-offs, backstop sync/poke/unwind, optional Pyth push (off; Chainlink mode). It scans events from `start_block` to learn accounts and positions, keeps a checkpoint in `infra/testnet/keeper-state.json` (guarded by a `.lock` file; two keepers cannot share it), and exposes Prometheus metrics at :9150 (`keeper_ticks_total`, `keeper_scanned_block`, `keeper_accounts_with_positions`, `keeper_liquidations_sent_total`, ...). Config: `infra/testnet/keeper.testnet.toml` (gas budget 0.05 USD per job, `max_fee_gwei` 2). Only liquidations earn the keeper anything; every other job costs gas, so watch its ETH balance (about 120 funding pokes an hour at a 2-minute interval). Dry-run by default; live needs `KEEPER_LIVE=yes` and `KEEPER_PRIVATE_KEY` in the shell.

**Indexer (`services/indexer`, Rust).** Reads logs, applies a reorg window (600 blocks of hashes), writes Postgres, serves REST and WebSocket. It is a convenience: never authoritative for balances or margin; always verify against the contract. Routes: `/v1/status`, `/v1/markets`, `/v1/markets/{id}/book?depth=`, `/trades`, `/candles`, `/v1/accounts/{owner}/positions`, `/v1/accounts/{acct}/orders`, `/fills`, WS `/v1/ws`. Unknown events are assumed ignored; verify that the two events added in deploy #5 (`BatchItemRejected`, `FeesUpdated`) are handled as intended.

**SDKs.** `sdk/ts` (viem, bigint everywhere) and `sdk/python`. Include batch calls, signed orders, agents, keeper calls, `decodePerpError`. The Python SDK was only syntax-checked after the deploy #5 changes.

**Bots.** SIMULATED LIQUIDITY, labelled as such. `testnet-mm.ts` is a ladder market maker (tiers of levels around the oracle, inventory skew, quotes pre-checked so they never cross); it refreshes with `requote` (one transaction per sub-account per tick) and falls back to single orders if the exchange lacks batching (`MM_BATCH=no` forces that). `testnet-taker.ts` crosses the book on a timer. The deployer key must NEVER run bots.

**Frontend.** Next.js app: terminal (`/`), maker console (`/maker`, places a ladder as one `batchPlace`), `/builder` (UI-only checklist; no builder fee exists in the contracts), brand studio. Reads chain via the :18702 forwarder and the indexer. Privy email login activates when `NEXT_PUBLIC_PRIVY_APP_ID` is set. UI labels testnet and simulated pieces; keep that.

## 8. Cost model (live gas, Arbitrum Sepolia)

Measured on deploy #4 and compared on deploy #5 (`docs/GAS_REPORT.md`, raw JSON in `infra/testnet/`). Gas used includes the L1 data component. Examples (deploy #5): new resting order 326,379 gas, same-level order 257,515, cancel about 75k, taker fill about 311k, `cancelAll` of 8 orders 313,827, funding poke 99k. Packing saved 6-9% on place/cancel. Dollar figures at the time: 0.02 gwei and ETH 1,825 USD, i.e. about 0.012 USD for a new resting order; they scale linearly and are a testnet model, not a mainnet quote. The next gas target is the `openOrders[acct]` `EnumerableSet` (about 40k gas per order); replacing it needs `cancelAll` to take caller-supplied ids.

## 9. Keys, roles and security hygiene

| Role | Where the key lives | Rule |
|---|---|---|
| Deployer / admin | `contracts/.env` | deploys and runs admin scripts; never runs bots or the keeper |
| Keeper | the operator's shell only | separate funded testnet-only key; never a file; never the deployer |
| Ladder bot, taker bot | `bots/.env.*-testnet` | testnet-only; funded with tUSDC and a little ETH |
| Liquidation test account | `contracts/.env.liqtest` | throwaway, see section 10 |
| Privy embedded wallets | Privy | users' own |

All env files are git-ignored. Do not paste keys into chat or tickets; if one leaks, rotate it. No mainnet or real-value key should ever touch this repo. Every script that broadcasts is dry-run by default and needs its own `CONFIRM_*=yes`, a chain id check (421614) and, where it signs as the deployer, an address check. Open a new broadcast script the same way. The exposed Pyth/Hermes key from earlier work still needs rotating.

## 10. Operating procedures

* **Smoke test after deploy:** `CONFIRM_TESTNET_SMOKE=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/smoke-testnet.js --network arbitrumSepolia` (14 checks, includes a live Chainlink read).
* **Enable backstop:** `enable-backstop.js`. **Backstop/ADL demo on DEMO-USD:** `demo-backstop.js` (admin-set price, so NOT evidence about real feeds).
* **Mint test collateral:** `mint-test-usdc.js` (`TO=`, `AMOUNT=`). **Gas for wallets:** `send-eth.js`. **Refresh DEMO price:** `refresh-demo-price.js` (goes stale after 30 min). **Poke funding by hand:** `poke-funding.js`.
* **Measure gas:** `measure-gas.js` (writes a JSON report; `GAS_REPORT_FILE=` to keep both).
* **Liquidation test account:** `CONFIRM_LIQ_POSITION=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/open-liq-position.js --network arbitrumSepolia` opens a 0.001 BTC long at near-maximum leverage from the throwaway key in `contracts/.env.liqtest`. A real Chainlink fall of roughly 6.5% from entry (about 65,045) should let the live keeper liquidate it. Currently open (account `0x9130…07DC`, sub 0).
* **Deploy:** `docs/TESTNET_RUNBOOK.md` section 16 (ordered commands, costs), `docs/DEPLOY_5_CHECKLIST.md` (what deploy #5 changed). Locking modules, transferring admin to a timelock and renouncing the deployer are irreversible and have not been done.
* **Health checks:** `curl localhost:18700/v1/status` (exchange address, `synced`), `infra/testnet/run-keeper.sh status`, `curl localhost:9150/metrics`, Arbiscan for the exchange address.

## 11. What is NOT verified (be honest about this)

* No independent audit, no formal verification, no bug bounty. Self-audit only (`docs/SELF_AUDIT.md`); the code added since that review (batching, packing, rebate, vault) has had no independent review.
* Liquidation on a real feed (Chainlink BTC) and ADL on a real feed have not been observed on a public chain; the DEMO-USD flows used an admin-set price. The liquidation test position (section 10) exists to change that.
* Funding under the 300 s sample cap has run live only since the keeper moved to deploy #5 on 2026-11-17 and has not been observed over a full interval.
* The `/maker` batch path in the UI has not been clicked end to end (the ladder bot's batched `requote` was observed live: 18 actions in one transaction).
* Privy login with MFA has never been exercised against a real Privy app.
* The vault: no deployment, no operator bot, no UI, no review.
* Large price gaps, sequencer outages, forced-inclusion and bridge behaviour are untested. Nitro appchain validation is only a local deploy/size/gas smoke.
* No load, latency or WebSocket fan-out benchmarks (gas only).
* Python SDK tests were not run after the latest ABI changes.

## 12. Known issues and sharp edges

* Margin tiering is by whole-position notional, which creates margin cliffs; the maker pre-check ignores tier jumps.
* A 40-fill taker costs about 2.2-2.4M gas (oracle and risk reads repeat per fill).
* TP/SL conditionals are not cancelled when the position closes (harmless, clutter, count toward limits).
* Expired orders are removed lazily, only while matching.
* ADL leaks up to about 1e-3 USDC per event to the vault (rounding).
* Admin is a single EOA, there is no timelock and no guardian address; modules are unlocked.
* `registerModule` is an upgrade power until `lockModules()`.
* `EIP-170` headroom is thin (router and `PerpExtras`); adding functions may require moving code between modules.
* Keeper and indexer both depend on the single-lane forwarder; see section 5.
* The `:18701` forwarder, the keeper lock and out-of-gas bot wallets are the usual causes of "nothing is happening".
* Full lists with dates: `docs/GAPS.md`, `docs/THREAT_MODEL.md`.

## 13. Suggested first week for the team

1. Run section 4 end to end; confirm green. Read `docs/SPEC.md`, then `PerpBase.sol`, then follow one order through `PerpExchange` → `PerpTrading` → `_executeFill`.
2. Bring up the testnet stack (section 5) with your own keys and a fresh funded wallet; place and cancel an order from the SDK and the UI.
3. Read `docs/THREAT_MODEL.md` and `docs/SELF_AUDIT.md`; arrange the independent review before any value is involved.
4. Decide on the open items: lock modules and move admin to a timelock + multisig; deploy the vault or drop it; cut the `openOrders` gas.
5. Watch the liquidation test account and the live keeper over a few days; record real-feed liquidation and funding evidence in `docs/GAPS.md`.

## 14. Document index

`README.md` overview and addresses · `docs/SPEC.md` math and accounting · `docs/ARCHITECTURE.md` trust and matching bounds · `docs/BACKSTOP_DESIGN.md` · `docs/THREAT_MODEL.md` · `docs/SELF_AUDIT.md` · `docs/GAPS.md` status and weaknesses · `docs/TESTNET_RUNBOOK.md` operations · `docs/RUNBOOKS.md` local operations · `docs/GAS_REPORT.md` · `docs/VAULT.md` · `docs/MARKET_MAKER_GUIDE.md` · `docs/LAUNCH_CHECKLIST.md` and `docs/PRODUCTION_READINESS.md` (go/no-go beyond testnet) · `infra/testnet/README.md` · `services/*/README.md` · `sdk/*/README.md` · `bots/README.md`.
