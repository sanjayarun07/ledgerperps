# Feature status and known gaps (updated 2026-11-13)

"Tested" means a test in this repo passed on a local Hardhat node (and Foundry where noted). The fixed contracts were also deployed and smoke-tested (deploy, code size, gas) on a LOCAL Nitro testnode (2026-11-13); nothing has run on a public testnet.
Hyperliquid reference links were not fetched or verified; no parity claim is made.

## Contracts
| Area | Status |
|---|---|
| CLOB, price-time priority, bounded matching (16 levels, 40 touches, 64-level insert walk) | Implemented, tested (unit, fuzz, invariants) |
| GTC/IOC/FOK/PostOnly/reduce-only/market-as-IOC | Implemented, tested. PostOnly resting bug found by fuzz and fixed |
| Stop/TP/bracket (OCO) conditionals | Implemented (keeper-triggered on mark price), tested |
| TWAP | Implemented as an on-chain schedule executed by keepers (not a resting order); failed slices counted; tested |
| Cross margin, reserved order margin, tiered IM/MM | Implemented, tested |
| Isolated margin (per market, flat-only mode switch, add/remove margin, loss capped at margin) | Implemented, tested. Leverage = margin amount; no leverage setter |
| Funding | Implemented, tested (one funding scenario + fuzz touches). Missed intervals applied at sampled average |
| Liquidation (partial, to backstop at mark, keeper fee, insurance) | Implemented, tested (incl. large-gap stress, see below). **No hysteresis**; no book-based liquidation. A cross account stays liquidatable when an UNRELATED held market's feed is stale (that market is valued at its last good index moved 20% in the account's favour); the liquidated market itself needs a fresh mark |
| ADL | Implemented. Keeper supplies a ranked candidate list; contract checks order, eligibility and bounds but **cannot prove no better candidate was omitted**. Concession capped by `adlMaxPremBps` (default 25%), or by `adlHardPremBps` (default 100%, governed) while backstop-originated debt is outstanding; the target's break-even and (new) its maintenance requirement over ALL cross markets always bind, so residual debt may still need `recapitalize`. ADL works on the GLOBAL debt pool: it clears the market's own `adlDebt` record first, then other markets' records (needs backstop inventory opposite the target in the ADL market). Fixed 2026-11-13: wrong backstop sign when a LONG target was fully closed. **Fixed (phase 1 of docs/BACKSTOP_DESIGN.md): ADL-2 cross-target underwater (targets without slack are skipped, `AdlSkipped`)** |
| Delisting / final settlement | Implemented (ReduceOnly -> delist -> `settleDelisted`), tested. Settle price is admin-supplied. `settleDelisted` now records bad debt for accounts insolvent at the settle price (same helper as liquidation) |
| Governance | Roles + OZ `TimelockController` tested as admin holder. **No multisig or timelock is deployed by default**; `setOracle` is global and instant unless behind the timelock |
| Pause policy | Global pause blocks new risk; liquidation, ADL and cancels stay live |
| EIP-712/1271 relayed orders, signed cancel, agent keys, scopes | Implemented, tested (incl. smart-wallet mock). Scopes: market mask + max order notional. No read-only API keys on-chain (the indexer has hashed read-only API keys) |
| Oracles | Chainlink/Pyth adapters and `MedianOracle` written; **unverified on any real chain**. Local uses `ManualOracle` |
| Oracle recovery | `Recovery` state exists but has **no automatic grace logic** |
| Bridge / parent-chain withdrawals | **Not implemented** |
| Contract size | All 6 contracts < 24,576 bytes (deployed bytes, optimizer 200 runs, viaIR): PerpExchange 22,425; PerpExtras 18,495; PerpTrading 17,573; PerpLiquidation 13,835; PerpAdl 13,557; PerpTwap 10,465 (after BACKSTOP-1 phase 1; PerpExchange has ~2.1 KB of headroom left). `replaceOrder` and `backstopPlace` moved from PerpTrading to PerpExtras to make room (same selectors, same ABI) |

## Services and apps (agent-reported results; keeper/indexer/frontend suites were run by the agents)
| Component | Status | Main limits |
|---|---|---|
| Keeper (Rust) | 2026-11-13 after the fixes (re-run by me): 97 cargo tests (78 unit + 3 ABI-drift + 13 chain-mock + 3 wallet) and e2e (26 assertions) pass; new permissionless `writeOff` sweep for flat negative accounts is unit-tested and its calldata/ABI is drift-checked, but the e2e never creates a flat-negative account so the live send path is NOT exercised | MEV competition unsolved; O(accounts x markets) per cycle; reorgs deeper than the window not fully undone; e2e uses a Multicall3 stand-in; profitability gate needs an operator-set native price |
| Indexer/API (Rust, Postgres) | 2026-11-13 after the fixes: 60 cargo tests pass (PriceBand label, snapshot round trip, bad-debt from non-liquidation txs); `price_band` cancel verified live against the redeployed UI chain (see below); e2e passes (124 PASS lines, 0 FAIL) | Only fills are memory-bounded (other models and snapshots grow with history); ADL realized PnL approximate; no Redis TLS/cluster; tested only on local Hardhat/Postgres 14; new events (`MarketDelisted`, `DelistedSettled`, `MarketParams`) decoded but not modelled |
| Frontend | 2026-11-13: typecheck clean, eslint 0 errors (4 pre-existing unused-import warnings), 316 vitest tests, `next build` OK (separate `NEXT_DIST_DIR`); page loads data from the redeployed chain+indexer (screenshot); browser-driven on a local chain | No accessibility audit tool run; toast intermediate stages never seen live (automine); several flows not re-driven after the redesign (TWAP slice, transfer, session keys, relayer, recapitalize, FOK/PostOnly errors, indexer mode); no real wallet extension tested |
| TS SDK | 19 tests pass (run against a private hardhat node), includes `writeOff` revert on a healthy account and the PriceBand enum | Indexer client was written before the indexer existed and was never run against it; EIP-1271 not exercised |
| Python SDK | 10 tests pass (private hardhat node); `write_off` and `CancelReason` added but the write-off call itself is not integration-tested | No conditional/TWAP/isolated/ADL wrappers |
| Bots | 14 unit tests (2 new for the price band: quotes limited to 80% of `bandBps`) + earlier 1-2 minute live runs (NOT re-run after the fixes) | Simulated liquidity only; no soak test; shares hardhat account indexes with SDK tests |
| Infra | gas bench re-run after the fixes; local Nitro testnode: deploy, code-size, smoke re-run (`infra/nitro-local/README.md`); `docker compose config` valid, `make up` brought up chain/Postgres/Redis/Prometheus/Grafana and seeded accounts; Helm lint/template and `tofu validate` passed; gas bench run | Nitro, Terraform and Helm never applied; keeper/indexer/bots images not built; Nitro parameters marked UNVERIFIED; dashboard metric names may not match services |

## Verified 2026-11-13 after the fixes (redeploy and consumers)
- Redeployed to the UI hardhat chain (:18647) and to the local Nitro testnode; frontend `src/generated` and the Rust indexer (rebuilt with the new ABI, fresh DB) now point at the new exchange; indexer lag 0 and event/trade counts equal the chain.
- Live on-chain: a resting order outside index +/- `bandBps` was cancelled with `OrderCanceled(reason=8)` when a taker walked the book, and the indexer reported `cancel_reason: "price_band"`.
- Gas: the price-band oracle read costs about +1.2-1.6% per single fill on Hardhat and Nitro, up to +5.4% for a 40-fill taker (`docs/BENCHMARKS.md`).
- Still unverified: `writeOff` in the keeper against a live flat-negative account (no scenario produces one now that fills/liquidations write off inline), the PriceBand message in a real browser notification, keeper/indexer against Nitro after the fixes, bots live run after the fixes, L1 data cost.
- Test-gap note: SDK integration tests default to `127.0.0.1:8545`, which on this machine is the Nitro testnode's L1 geth, not a hardhat node. Run them with `PERP_RPC_URL=http://127.0.0.1:<hardhat port>`.

## Not built or not done
- Verified single-command full-stack launcher.
- Public testnet validation and full Nitro validation (only deploy/size/gas smoke on a local testnode); real oracle feeds; bridge integration.
- Independent audit, formal verification, bug bounty, load/latency/WebSocket fan-out benchmarks (only gas was measured: `docs/BENCHMARKS.md`).
- Large-gap liquidation/ADL coverage is now a model-based fuzz suite (`test/stress.test.js`) plus Foundry invariants (`foundry-test/Stress*.sol`), but it is a test of THIS code with oracle shocks to -60%/+150%; it is not an audit and says nothing about real oracles or a real sequencer.

## Known design weaknesses
- Gas: a 40-fill taker costs ~2.2-2.4M gas (oracle and risk reads repeat per fill).
- Whole-position tiering creates margin cliffs; maker margin pre-check ignores tier jumps.
- A failed OI cap reverts the taker (griefable by makers near the cap). Fills that do NOT raise OI (reduce-only closes) no longer hit the cap, so lowering `maxOI` below current OI cannot trap positions.
- **BACKSTOP-1 (FIXED in phase 1, 2026-11-13; design: docs/BACKSTOP_DESIGN.md)**: the backstop's mark-to-market deficit is now recognised by `syncBackstop()` (permissionless; also run inside `liquidate`, `settleDelisted`, `adl` and `withdraw`): insurance first, then `unresolvedBadDebt`/`adlDebt`/`bsDebt`; recoveries repay insurance first, then debt. Stale feeds value the backstop adversely by 20%. **What this does NOT do**: it records, it does not move USDC. While `unresolvedBadDebt > 0`, positive claims exceed the vault by that amount until ADL / `recapitalize` clears it. A withdrawal limiter (`wdGateThreshold`, default 100 USDC) restricts withdrawals to deposited principal while debt exceeds the threshold, which reduces but does not remove the run risk. Backstop inventory SIZE and DURATION are still unbounded (phase 2 auction/soft cap not built); a gap larger than insurance + ADL capacity leaves residual debt for `recapitalize`. Recognition lags if no keeper calls `syncBackstop()` and no hooked transaction happens.
- **Bad-debt market attribution (mitigated)**: debt is still booked on the market of the last cross position closed (victim) or of the backstop's largest unrealised loss (sync), but ADL now clears the global pool (own market's record first, then other markets in ascending order), so attribution no longer blocks clearing. Cross-market socialisation is a deliberate choice: winners on market B can be haircut for debt that arose on market A, subject to their break-even and maintenance.
- **ADL-2 (FIXED in phase 1)**: concession is capped by `equity - maintenance - 1` of the target over all its cross markets (conservative: ignores margin freed by the closed slice, so ADL may clear less than an exact check). Targets with no slack are skipped. `adlScore` is 0 for `equity <= 0` (such accounts must be liquidated; previously they ranked first).
- **ADL rounding leak (open, tiny)**: the vault retains up to ~1e-3 USDC per ADL event (floor rounding); the break-even floor can realise up to size/1e8 micro-USDC below zero.
- Price-band residual: every ordinary fill must be within +/- `bandBps` (<= 20%, default 5%) of the index. An account that is already underwater can still wash within the band; the shortfall is written off immediately, and the value an accomplice extracts is bounded by `bandBps` x notional (it would otherwise have been bad debt at mark anyway). Out-of-band resting orders are cancelled (`CancelReason.PriceBand`) when a taker reaches them, so a stale quote is lost rather than filled.
- Stale-feed liquidation rule has a residual: an account can be liquidated through a stale unrelated feed only if that feed's true price has moved more than 20% in the account's favour since its last good index. `STALE_FAV_BPS` is a constant, not governable.
- Module registration (`registerModule`) is an upgrade power until `lockModules()`.
- Expired orders are removed lazily during matching only.

## Stress campaign 2026-11-13: findings fixed vs open
Large-gap stress tests (`test/stress.test.js`, `foundry-test/Stress*.sol`) found the items below. **None of this is an audit**; the suites test this code against random oracle shocks and keeper sequences only.

| ID | Finding | Status |
|---|---|---|
| WASH-1 | Reducing fills had no price check: an off-market reduce-only wash could leave an account at large negative collateral with no recorded debt and drain the vault (Critical) | **Fixed**: every ordinary fill must be within +/- `bandBps` of the index (resting order outside the band is cancelled); a fill that leaves a flat account negative writes the loss off immediately (insurance, then `unresolvedBadDebt`/`adlDebt`). Residual: in-band wash bounded by `bandBps` x notional |
| ADL-1 | `_adlOne` read the target's side after the first fill zeroed it: backstop got the wrong sign when a long target was fully closed (Critical) | **Fixed** (side captured before the fills) |
| FUND-1 | Backstop `lastFundingIdx` not synced on takeover (liquidation, ADL, settleDelisted): phantom funding, funding no longer zero-sum (High) | **Fixed** (`_settleMarket(BACKSTOP, m)` before the fills) |
| LIQ-1 | A stale feed on an UNRELATED market blocked liquidation and ADL ranking of cross accounts (High) | **Fixed** with a documented rule (see above) |
| LIQ-2 | A flat account with negative collateral could never be written off (High) | **Fixed**: shared write-off helper in fills, liquidation, `settleDelisted`, and a permissionless `writeOff(account, market)` that only acts on a flat negative bucket |
| SETTLE-1 | `settleDelisted` did not record bad debt (High) | **Fixed** |
| LEDGER-1 | `ledgerTotals` omitted `isoMargin` (Low-Medium) | **Fixed** (same signature) |
| OI-1 | Lowering `maxOI` below current OI made reduce-only closes revert `OICap` (Low-Medium) | **Fixed** (only OI-raising fills are capped) |
| BACKSTOP-1 | Unfunded backstop inventory losses; physical solvency not guaranteed (High) | **Fixed (phase 1)**: mark-to-market recognition + withdrawal limiter; tests are required (no `STRESS_KNOWN_GAPS` gating). Residual: run window while debt is uncleared, inventory size/duration unbounded (phase 2), keeper-triggered recognition lag |
| ADL-2 | ADL can push a cross target underwater (Medium) | **Fixed (phase 1)**: slack check over all cross markets, skip not revert |
| - | Bad-debt market attribution | **Mitigated** (global-pool ADL). ADL rounding leak still **OPEN** |

ABI/behaviour changes for integrators: new function `writeOff(bytes32,uint8)`; new `CancelReason.PriceBand` (value 8, appended); `BadDebtUnresolved` can now be emitted from fills, `settleDelisted` and `writeOff` (not only `liquidate`); `OrderCanceled` can be emitted for a resting order touched out of band; `ledgerTotals` now includes isolated margin; `replaceOrder`/`backstopPlace` are served by PerpExtras (same selectors, router unchanged). Existing local chains deployed with old bytecode do not have any of these fixes.

ABI/behaviour changes for integrators (BACKSTOP-1 phase 1): new functions `syncBackstop()`, `backstopEquity()`, `adlHealth(bytes32,uint8)`, `setAdlHardPremBps(uint32)`, `setWithdrawGate(uint256)`, getters `adlHardPremBps()`, `bsInsDrawn()`, `bsDebt()`, `wdGateThreshold()`, `principal(bytes32)`; new events `BackstopSynced`, `AdlSkipped`, `AdlHardPremSet`, `WithdrawGateSet`; new error `WithdrawGated()`. `adl()` no longer requires `adlDebt[market] > 0` (it requires `unresolvedBadDebt > 0`) and no longer reverts for a target without slack (emits `AdlSkipped`). `BadDebtUnresolved(BACKSTOP, amount)` can be emitted by the backstop sync. Insurance can now move down/up on a sync. Storage layout changed (new variables in PerpBase): redeploy, existing chains keep the old behaviour.

## Off-chain consumers after BACKSTOP-1 phase 1 (2026-11-14)
- Indexer decodes `BackstopSynced`, `AdlSkipped`, `AdlHardPremSet`, `WithdrawGateSet` (`GET /v1/backstop/events`); `BadDebtUnresolved` with the BACKSTOP key shows in `/v1/bad-debt` as a normal row. The indexer does not expose `backstopEquity`/`wdGateThreshold` (contract views; read from chain).
- Keeper `syncBackstop` job exists (periodic + on mark change). Not covered by an e2e scenario; unit tests only. ADL candidate lists are pre-filtered with `adlHealth`.
- SDKs (TS, Python) and the frontend expose the new views/events and map `WithdrawGated`. The frontend withdraw message uses `principal(account)` as the allowed amount.
- Live check on the local UI chain: with the book cleared, a liquidation to the backstop at a 40% gap created 673.125 USDC of unresolved bad debt (76.875 USDC drawn from insurance, 673.125 backstop debt); a withdrawal above principal then reverted `WithdrawGated()` (simulated via `eth_call`, not sent); after the oracle returned, `syncBackstop()` refunded the insurance and repaid the debt (one `BackstopSynced` event, indexed).
- Not verified: the WithdrawGated message rendered in the UI against a connected gated wallet (the indicator in the footer was verified live; the account-panel callout is covered by unit tests only).
