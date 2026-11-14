# perp-keeper

Independent Rust keeper for the Perps exchange. **UNAUDITED prototype** — see `../../docs/GAPS.md`.

## Authority: none
The keeper holds **no on-chain role** and has no special power. It only calls functions that are permissionless on the
exchange router, from an ordinary EOA, and nothing else:

| Function | Purpose |
|---|---|
| `pokeFunding(market)` | advance funding sampling/index |
| `liquidate(acct, market)` | liquidate accounts with equity < maintenance margin (the caller earns `keeperShareBps` of the fee) |
| `executeConditional(id)` | trigger TP/SL/stop orders once the on-chain mark crosses the trigger |
| `executeTwapSlice(id)` | run due TWAP slices |
| `adl(targets, market)` | deleverage profitable counterparties against outstanding `adlDebt` |
| `pokeBackstop(market)` | start/relax the backstop elevation clock (phase 2; no-op sends are skipped) |
| `unwindBackstop(targets, market)` | forced reduction of backstop inventory against profitable opposite positions once elevated for `maxAge` (phase 2) |
| `writeOff(acct, market)` | record the loss of a FLAT, NEGATIVE bucket (insurance first, rest to `unresolvedBadDebt`/`adlDebt`). Pays the keeper nothing; cannot touch a healthy bucket |

The one optional exception to "only the exchange router" is the **Pyth price pusher** (`--enable-pyth-push`, default off): it sends
`updatePriceFeeds` (payable, pays Pyth's small update fee) to the *Pyth contract*, never to the exchange. See "Pyth price pusher" below.

It cannot move user funds, change parameters, pause markets, or trade the backstop. A compromised or buggy keeper can at
worst waste its own gas or fail to act (liveness), which is why anyone can run another one. Its only secret is a gas-paying
key: fund it with a small amount of native token and nothing else. Correctness never depends on the keeper: every call is
re-validated by the contract. (For ADL the contract checks ranking order within the list but cannot prove no better-ranked
account was omitted — see `PerpAdl.sol`; the keeper ranks all accounts it knows about.)

## Behaviour
Each poll cycle: (1) scan logs from the checkpoint (`Deposit`, `Fill`, `CondPlaced/Triggered/Canceled`, `TwapPlaced/Done/Canceled`,
`Liquidated`) to discover accounts and orders; (2) `pokeFunding` for each market on its own `fundingInterval`;
(3) liquidation; (4) conditional orders; (5) TWAP; (6) ADL; (7) write-off sweep; (8) save checkpoint.

* **Liquidation**: refresh positions for accounts that are new/touched/holding positions; cross accounts via `accountState`,
  isolated positions via `isoState`; liquidatable iff `equity < mm`. For a cross account the market with the largest notional is
  liquidated first. The call is always `eth_call`-simulated before signing.
* **Stale oracle = wait.** If `markPrice`/`accountState`/`isoState`/the simulation reverts `OracleDegraded` (or `MarketRestricted`),
  the keeper does nothing for that market/account that cycle, counts `keeper_oracle_waits_total`, and does not count a failure.
* **Conditionals** fire when `mark >= trigger` (above) / `mark <= trigger` (below), using `markPrice` (not the index). Siblings of a
  consumed OCO order are dropped via their `CondCanceled` event.
* **TWAP**: `twapStatus(id).active && nextTime <= latest block time` then `executeTwapSlice`.
* **ADL**: for each market with `adlDebt > 0` and a non-flat backstop, scores every known opposite-side account with `adlScore`,
  sorts by score desc / account key asc, takes at most 8, and picks the longest prefix that simulates successfully.
* **Write-off sweep** (`--enable-writeoff`, default on): accounts touched by a `Deposit`/`Fill`/our own liquidation are queued; for each, `positions` for every market
  and (when there is no open cross position) `accountState`. A bucket is a candidate when it is an isolated flat position with `isoMargin < 0`, or the cross collateral is
  negative with no open cross position (`equity < 0`). The cross loss is booked to the first non-isolated market where the backstop holds inventory (so ADL has something to
  use), else the first non-isolated market. The call is `eth_call`-simulated first (`nothing to write off` = already settled, benign). `writeOff` pays no reward, so the
  profitability gate is a gas BUDGET: send only if estimated gas cost <= `--writeoff-max-gas-usd` (default 0.50; `--force-unprofitable` overrides).
  Since LEDGER-1 the contract also writes off inside fills, liquidations and `settleDelisted`, so this sweep is a safety net (LIQ-2).
* **syncBackstop** (`--enable-sync-backstop`, default on; `--sync-backstop-interval-secs`, default 60; `--sync-backstop-max-gas-usd`, default 0.50): the backstop's
  mark-to-market loss is only recorded when someone calls `syncBackstop()` (the contract also syncs inside `liquidate`, `adl`, `settleDelisted` and `withdraw`). The job runs
  every interval and immediately when any market's mark changed while the backstop holds inventory (an oracle update). It reads `backstopEquity`, `bsInsDrawn` and `bsDebt` and
  sends only if the call would change state (equity < 0, or equity > 0 with earlier insurance draws / backstop debt to repay). `OracleDegraded` = wait. No on-chain reward, so the
  gate is a gas BUDGET like write-off; dry-run simulates but never sends; `eth_call` simulation always runs first. Runs before ADL in the cycle.
* **Backstop phase 2 inventory** (`--enable-poke-backstop` default on, `--poke-backstop-max-gas-usd` 0.50; `--enable-unwind-backstop` default on, `--unwind-backstop-max-gas-usd` 1.00; `--backstop-inventory-interval-secs` 15; config keys of the same names): per market with `backstopCfg(m).softNotional > 0` (off markets cost 3 reads and no tx) it reads the backstop position and mark.
  `pokeBackstop(m)` is sent only when the stored clock disagrees with the notional (above the threshold with no clock: start; at or below with a clock: relax). Once `now >= elevatedSince + maxAge` and the notional is still above the threshold, `unwindBackstop` is built like ADL:
  accounts on the side opposite the backstop with slack (`adlHealth`) and `adlScore > 0`, ranked by score (descending, key ascending), at most 8, the longest prefix that simulates. No on-chain reward, so gas-budget gating, `eth_call` simulation first, dry-run never sends.
  `BackstopCap` is classified `backstop_cap`; "not due" is a retry, "not elevated" and "nothing to unwind" are skips. `takeBackstop` (the taker side of the Dutch auction) is deliberately NOT a keeper job: see `bots/src/backstop-taker.ts`.
  Tests: unit tests for `notional`, `plan_poke`, `unwind_due`, calldata and error classification, plus the ABI drift test; there is NO e2e scenario for these jobs.
* **Pyth pusher** (`--enable-pyth-push`, default OFF; details in "Pyth price pusher" below): keeps the Pyth half of `MedianOracle` fresh. Runs first in every cycle, so the
  funding/liquidation reads that follow see the new price.
* **ADL filter**: candidates are first screened with `adlHealth(target, market)`; a target with no slack (equity <= maintenance) is skipped, so the list the keeper submits does not
  hit `AdlSkipped`. `WithdrawGated` reverts are classified as a known benign revert (`withdraw_gated`); the keeper never withdraws.
* **Transactions**: one nonce lane (serialised), nonce cached locally and re-synced from the node on nonce errors/timeouts (a stale
  nonce is re-read and the send retried once), gas = `eth_estimateGas` + buffer, EIP-1559 fees with a hard cap, and if a tx is not mined
  within `tx_timeout_secs` it is replaced at the same nonce with fees bumped by `gas_bump_pct` (up to `max_bump_attempts`).
* **Reorg safety**: the checkpoint stores the hashes of the last `reorg_window` (default 64) scanned blocks plus an undo journal of the
  events applied in that window. Every cycle the newest stored hash is compared with the canonical chain; on a mismatch the keeper finds
  the common ancestor (newest stored block whose hash still matches), undoes the journal back to it (accounts/conditionals/TWAPs
  re-appear or disappear exactly as on the new chain), re-marks all accounts dirty and rescans from `ancestor + 1`. While scanning a
  chunk it also verifies parent-hash continuity, that the tip hash did not change while logs were fetched, and that every log's
  `blockHash` matches the verified header; otherwise it commits nothing and retries next cycle. A reorg deeper than the window rolls the
  whole window back and logs an error (raise `--reorg-window`); state older than the window cannot be undone. `confirmations` still
  works and is additive. Metric: `keeper_reorgs_total`.
* **Batched reads**: positions, `accountState` and `isoState` for all active accounts are read with Multicall3 `aggregate3`
  (`allowFailure = true`, chunks of `multicall_chunk`, up to `rpc_concurrency` requests in flight). `multicall = auto` uses it iff code exists
  at the canonical `0xcA11...CA11` (or `multicall_address`); `on` makes its absence a startup error; `off`, or a failing chunk, falls back
  to individual `eth_call`s run in parallel under the same concurrency limit. Hardhat nodes do not ship Multicall3: `tests/e2e.sh`
  installs an ABI-compatible stand-in (`scripts/sol/Multicall3Lite.sol`) with `hardhat_setCode` and also runs one keeper with
  `--multicall off`. Per-cycle cost is still O(accounts x markets) *reads* (just in a handful of RPC round trips).
* **Profitability**: before sending a `liquidate` the keeper computes the expected reward exactly as `PerpLiquidation.liquidate` does
  (`closeFactorBps`/`fullCloseNotional`/lot -> closed size -> `ceil(notional * liqFeeBps)` -> `keeperShareBps`, all read from public
  getters / `getMarket`), converts `eth_estimateGas * max_fee_per_gas` to USD with `--native-usd-price` and skips (logs `SKIPPING`, counts
  `keeper_skipped_unprofitable_total`) unless `reward - cost >= min_profit_usd` or `--force-unprofitable`. Funding, conditional, TWAP and ADL are
  exempt (write-off has its own gas budget, see above) (they are protocol upkeep and have no fee to compare); their real cost is logged on every mined tx (`cost_wei`, `est_cost_usd`).
  Caveats: the reward is credited as *exchange collateral* to the keeper's account (not liquid USDC/ETH), the native price is a static
  operator setting (no price feed), and if the reward model inputs cannot be read the gate is skipped with a warning (liveness over thrift).
* **Competition**: if a liquidation passes simulation but then loses a race (the estimate or the mined tx reverts), the keeper
  re-simulates; "opportunity gone" reverts (`NotLiquidatable`, inactive, no position) are benign (`keeper_lost_races_total`, not a failure).
  `--submit-jitter-ms N` adds a random 0..N ms delay before submitting a liquidation; `--send-raw-via URL` signs locally and broadcasts the raw
  transaction to that endpoint (private relay / Flashbots-style `eth_sendRawTransaction`) instead of the public RPC, with **no fallback** to
  the public mempool. **MEV competition is not solved**: the keeper is a polling bot with no priority-fee bidding strategy, no bundle
  construction/simulation against a builder, no mempool watching and no gas-auction logic. Against professional liquidators on a
  competitive chain it will usually lose; jitter only de-synchronises identical keeper instances and does not win races.
* **RPC failover**: `rpc_url` + `rpc_urls` form an ordered list behind one failover transport. A transport-level failure (connection error, HTTP
  5xx, undecodable body, `-32005`/rate-limit) marks the endpoint down for `rpc_cooldown_secs` and the same request is retried on the next one.
  Reverts and other node answers are never treated as endpoint failures. Each cycle `eth_blockNumber` is probed on every endpoint: dead
  endpoints and ones lagging the best head by more than `rpc_max_lag_blocks` are demoted, and the preferred (first healthy) endpoint is
  restored. Caveat: a node that is *consistently wrong or behind* but answering is only caught by the lag probe; there is no quorum/cross-check
  of results between endpoints. Metric: `keeper_rpc_active_endpoint`.
* **Funding cadence**: every market is poked on its own `fundingInterval` (from `getMarket`, cached 60 s); `--funding-interval-secs` is an
  optional override for all markets. (If the contract samples the premium on each poke, a shorter override improves sampling accuracy.)
* **Checkpoint lock**: the keeper takes an exclusive OS file lock on `<state_file>.lock` before reading the checkpoint; a second process
  on the same state file exits with an error. The lock is released automatically on exit/crash (no stale lock files to clean up).
* **Dry run** (`--dry-run`): everything is simulated, nothing is signed or sent; a key is optional.
* **Shutdown**: SIGINT/SIGTERM finishes the in-flight action, saves the checkpoint and exits.

## Run
```bash
cd services/keeper
cargo build --release
export KEEPER_PRIVATE_KEY=0x...            # never logged; or: --keystore-path file.json + KEEPER_KEYSTORE_PASSWORD
./target/release/perp-keeper \
  --rpc-url http://127.0.0.1:8545 --exchange 0x<router> --start-block <deploy block> \
  --state-file ./keeper-state.json
# or:  ./target/release/perp-keeper --config config.example.toml
```
Local chain: `cd contracts && npx hardhat node`, then `npx hardhat run scripts/deploy.js --network localhost` and take
`exchange` from `contracts/deployments/localhost.json`. Hardhat dev account keys are public; use them only locally.

Configuration precedence: CLI flags > `KEEPER_*` environment variables > TOML file > defaults. `perp-keeper --help` lists every
option; `config.example.toml` shows them all. `RUST_LOG=debug` raises verbosity; `--log-format json` for structured logs.

### Pyth price pusher
Pyth is a pull oracle: a price exists on-chain only after someone submits a signed update, and `MedianOracle` rejects a source older than its `maxAge`
(3600 s on the testnet config). With a stale Pyth every `markPrice` reverts `OracleDegraded` and the exchange (and this keeper) can only wait. The pusher
replaces the manual `contracts/scripts/testnet/push-pyth.js` (which stays as a fallback). It is **off by default**; when off nothing in this section runs
and no Pyth/Hermes setting is validated.

```bash
export KEEPER_PRIVATE_KEY=0x...            # same wallet as the other features; needs a little ETH. Never logged.
export HERMES_API_KEY=...                  # Hermes needs a key (sent as `Authorization: Bearer`). Also accepted: KEEPER_HERMES_API_KEY. Never logged.
perp-keeper --config keeper.toml           # with the pyth block of config.example.toml uncommented
# or flags/env: --enable-pyth-push --pyth-contract 0x.. --pyth-feed-ids BTC=0x..,ETH=0x.. [--hermes-url https://pyth.dourolabs.app/hermes] [--dry-run]
```
Every `pyth_push_interval_secs` (default 20, +/- `pyth_jitter_pct`):
1. reads `getPriceUnsafe(feed).publishTime` for each configured feed and exports `keeper_pyth_age_seconds{feed}`;
2. if no feed is at least `pyth_push_when_age_secs` old (default `pyth_max_age_secs / 2` = 1800 s of the exchange's 3600 s), it stops: **Hermes is not contacted**;
3. otherwise fetches `GET {hermes_url}/v2/updates/price/latest?ids[]=..&encoding=hex&parsed=true`. If Hermes reports no newer `publish_time` than the chain for
   every due feed (paused feed, closed market), it does not pay for a no-op (`result="skipped_no_newer"`);
4. `getUpdateFee(bytes[])` must be <= `pyth_max_fee_wei`; `updatePriceFeeds` is `eth_call`-simulated with `value = fee` (a revert here usually means the Hermes channel does
   not match the contract: stable vs beta, which is unverified for the Arbitrum Sepolia contract);
5. gas gate: estimated gas cost (same method as the other features) must be <= `pyth_max_gas_usd` (default 0.50). `--force-unprofitable` overrides this gate only;
6. budget: `fee + gas_limit * worst-case fee per gas` of this push plus everything spent in the last hour must be <= `pyth_hourly_budget_wei` (default 0.005 ETH).
   **A hard ceiling, never overridden.** Actual spend is booked from the receipt; a send that times out or mines a revert is booked at its worst case because it may still land.
   The ledger lives in the keeper checkpoint (`state_file`, field `pyth`) and is saved immediately after a push, so a restart cannot reset the budget;
7. `--dry-run` (or no key) stops after the simulation and counts `keeper_pyth_push_total{result="dry_run"}`; nothing is signed or recorded. Otherwise the tx is sent with the
   keeper's normal nonce / fee-bump / `max_fee_gwei` machinery. All configured feeds are pushed in one transaction.

**Failure handling (never panics, never blocks the other features).** Hermes failures use exponential backoff with jitter and are persisted: 401/403 start at 60 s (cap 900 s,
logged at `error` with the fix), 429 honours `Retry-After` (cap 3600 s), 5xx/network/bad body start at 5 s (cap 300 s). An unreadable chain read retries next interval.
Counters: `keeper_pyth_hermes_errors_total{kind}` (`unauthorized|rate_limited|server|client|network|bad_body`), `keeper_pyth_push_total{result}` (`sent, dry_run, skipped_fresh,
skipped_no_newer, skipped_fee_cap, skipped_gas, skipped_budget, failed_hermes, failed_fee_quote, failed_sim, failed_rpc, failed_tx`), `keeper_pyth_fee_wei_total`,
`keeper_pyth_gas_wei_total`; gauges `keeper_pyth_age_seconds{feed}`, `keeper_pyth_budget_spent_wei`, `keeper_pyth_backoff_seconds`, `keeper_pyth_enabled`.
Suggested alerts: `keeper_pyth_age_seconds > 1800` (warn), `> 3000` (page; the exchange degrades at 3600), `increase(keeper_pyth_push_total{result=~"failed_.*"}[15m]) > 3`.

**Hermes access (important).** Pyth's Hermes service requires an API key: the public `https://hermes.pyth.network` answers `401 unauthorized` for `/v2/updates/price/latest` without one
(the `/v2/price_feeds` listing worked). Pyth's docs say both hosts serve the same API and the upgraded endpoint is `https://pyth.dourolabs.app/hermes`, which is the default `hermes_url`.
It was verified (by the project owner, 2026-11-14) to return HTTP 200 with a fresh parsed BTC price when called with `Authorization: Bearer <key>`. The keeper does exactly that by default:
* Export the key as `HERMES_API_KEY` (or `KEEPER_HERMES_API_KEY`, or any name via `hermes_api_key_env`; `HERMES_API_KEY` is the fallback when that one is empty). The header value is `hermes_api_key_prefix` (default `Bearer `) + key,
  in the header `hermes_api_key_header` (default `Authorization`). For an `x-api-key` style provider set header `x-api-key` and prefix `` (empty). The key is held in a sensitive HTTP header value: not in `Config`, not logged, not in `Debug`.
* The request path `/v2/updates/price/latest` is appended to the base URL's own path, so path-prefixed bases such as `https://pyth.dourolabs.app/hermes` work. A key embedded in the URL (path or query) also works: put the URL in `hermes_url` / `KEEPER_HERMES_URL`.
* Logs, startup config dump and `Debug` show URLs as `scheme://host[:port]` only (this now also covers `rpc_url(s)` and `send_raw_via`); request errors are stripped of the URL.
* Where to get a key: from the Hermes provider named in Pyth's docs (docs.pyth.network, "Hermes"); we have not verified terms or pricing.
* Caveat: values in a TOML file or on the command line are visible to local users (`ps`); use the environment for secrets.

**Live format check (optional, never runs by default).** `PYTH_LIVE_TEST=1 HERMES_API_KEY=<key> cargo test --test hermes_live -- --nocapture` makes one real request for the BTC feed and asserts
`binary.data[]` blobs, `parsed[0].price.{price,conf}` (integer strings), `expo` and a fresh `publish_time`. Without both variables it is a no-op that passes. It sends nothing to any chain.

### Endpoints (default `127.0.0.1:9100`)
* `/healthz` — process is up.
* `/readyz` — a poll cycle finished recently **and** scan lag <= `max_ready_lag_blocks`.
* `/metrics` — Prometheus/OpenMetrics: `keeper_liquidations_sent_total`, `keeper_txs_sent_total{kind}`, `keeper_tx_failures_total{kind}`,
  `keeper_sim_reverts_total{kind,reason}`, `keeper_dry_run_actions_total{kind}`, `keeper_oracle_waits_total`, `keeper_head_block`,
  `keeper_scanned_block`, `keeper_head_lag`, `keeper_accounts_tracked`, `keeper_accounts_with_positions`, `keeper_conditionals_tracked`,
  `keeper_twaps_tracked`, `keeper_markets_with_adl_debt`, `keeper_ticks_total`, `keeper_tick_errors_total`, and with the Pyth pusher the `keeper_pyth_*` series above.

## Tests
```bash
cargo test                      # 144 tests (109 lib, 1 hermes_live (skipped without env), 11 pyth_push, 13 chain_mock, 7 abi_drift, 3 wallet): unit (config merge/TOML loading, revert classification, fee bump, nonce policy, state + reorg journal,
                                # simulated-reorg scan, batching incl. Multicall + fallback, profitability, failover selector, lock, JSON logs)
                                # + tests/chain_mock.rs (real alloy stack against a scripted fake node: fee-bump replacement, nonce recovery,
                                #   failover + health check, --send-raw-via, Multicall detection) + tests/wallet.rs (keystore + env key)
                                #   + tests/abi_drift.rs (checks src/abi.rs against contracts/abi/PerpExchange.merged.json, and the Pyth ABI against
                                #     PythAdapter.sol + contracts/scripts/testnet/pyth.js + Pyth's published selectors)
                                #   + tests/pyth_push.rs (real HermesClient against a local fake Hermes: 200/401/403/429/5xx/garbage/unreachable, API-key header;
                                #     real Chain against a fake node playing the Pyth contract: push, no-op, dry-run, 401 backoff, simulation revert)
cargo clippy --all-targets -- -D warnings
tests/e2e.sh                    # needs node + npx + curl + lsof; boots hardhat on :18545, deploys, and exercises the keeper end to end
```
`tests/e2e.sh` asserts: nothing happens on a healthy market while each market's funding is poked exactly once (interval 3600 s) and accounts are
discovered, with Multicall3 auto-detected; a second process on the same checkpoint is refused; a **stale oracle** makes the keeper wait; a
**dry-run** keeper (Multicall off) simulates the liquidation but sends nothing; with an absurd gas price the liquidation is **skipped as unprofitable**
and `--force-unprofitable` overrides; SIGTERM saves a checkpoint (with block hashes); a restarted keeper configured purely by a **TOML file**
(JSON logs, `--send-raw-via`) **resumes from it** and liquidates; a conditional order and a 2-slice TWAP execute; an **`evm_snapshot`/`evm_revert`
reorg** orphans a deposit and the keeper rolls back and forgets that account; a gap move creates bad debt and the keeper runs **ADL**. The e2e runs with the Pyth pusher disabled (it proves the keeper is unaffected by the feature); there is NO e2e scenario for the pusher (it would need a Pyth mock contract on the hardhat chain, which would have to live under `contracts/`) and none for `syncBackstop` yet (unit tests only: `plan`, `check_due`, the ADL slack filter, error classification). The e2e
drives hardhat through `scripts/hardhat.e2e.config.js` (reusing, read-only, the contracts project) and writes nothing under `contracts/`.

## Refreshing the ABI
`src/abi.rs` is a deliberately minimal hand-written `sol!` interface (only what the keeper calls/decodes), not a copy of the whole contract. It is
kept honest by `tests/abi_drift.rs`, which reads `../../contracts/abi/PerpExchange.merged.json` **at test time** and fails if any function,
event, error, return type or the `getMarket` struct word offsets (`lot`, `fundingInterval`) the keeper relies on changed. When the contracts
agent regenerates the merged ABI: run `cargo test --test abi_drift`; if it fails, update `src/abi.rs` (and `MARKET_*_WORD` in `src/chain.rs`)
accordingly. Purely additive contract changes (new functions/events/appended struct fields) need no keeper change.

## Known limitations
* Account discovery relies on `Deposit`/`Fill` logs from `start_block`; set it to the deployment block. Health is re-read for every active
  account each cycle: batched (Multicall3), so thousands of accounts are a handful of RPC calls, but it is still O(accounts x markets)
  per cycle, response sizes/`eth_call` gas limits bound `multicall_chunk`, and there is no incremental/event-driven health tracking.
  Not load-tested beyond the e2e (2-3 accounts).
* Reorg handling covers up to `reorg_window` blocks (default 64) and only what the keeper derives from logs; transactions the keeper itself
  sent in an orphaned block are not specially tracked (the next cycle simply re-evaluates the chain state). Finality-less chains with deeper reorgs need a larger window.
* The profitability gate needs an operator-supplied native token price and compares against the reward as *exchange collateral*; gas is the
  conservative max-fee bid, so the check is deliberately pessimistic. Unreadable inputs disable the gate (with a warning).
* MEV/competition is NOT solved (see above): no priority-fee bidding, no mempool or bundle logic, no multi-builder submission. The private endpoint hook only changes where the signed tx is sent.
* Liquidation of a cross account closes `closeFactorBps` of one market per call; the next cycle re-evaluates.
* ADL completeness is bounded by the accounts this keeper has seen; it is not a proof of the global ranking.
* RPC failover rotates on transport failure and lag, not on semantic disagreement between nodes. The checkpoint is a local JSON file
  (atomic write, exclusive lock): there is no shared/HA state, so two keepers must use two checkpoints.
