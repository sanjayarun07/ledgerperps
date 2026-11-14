# perps-indexer

Event indexer + read API (REST `/v1`, WebSocket `/v1/ws`) for the Perps exchange in `../../contracts`.

> **UNAUDITED prototype. Derived infrastructure.** The database, REST API and WebSocket feed are computed from chain
> events and are **never authoritative for balances, collateral, margin, positions or solvency**. The contract is. This
> service tracks no collateral at all, only event-derived history. Reconstructed positions can be wrong (for example if
> the indexer starts after an account traded, or has a bug); always verify against `positions(acct, market)` /
> `accountState` on chain before relying on a number. Nothing here can move funds or sign anything.

## How it works

```
JSON-RPC node --(batched headers + getLogs)--> Indexer --commit per block--> PostgreSQL: blocks(hash chain), events(decoded + raw),
                                          |                                           snapshots(read-model JSON @ block+hash)
                                          +--apply (pure reducer)--> in-memory read models <--snapshot + tail replay at startup/reorg
                                                       |                    |
                                              WebSocket hub            REST API (axum)
```

* **Decode**: every log of the router address is decoded with the merged ABI (`abi/PerpExchange.merged.json`, a copy of
  `contracts/abi/`) into a typed `Ev`. Decoding is **tolerant**: a log whose selector the ABI does not know (a newer
  contract) or whose payload does not decode is stored as `Other` (`Unknown:<topic0>` / `Undecodable:<name>`), counted in
  `indexer_undecoded_events_total`, and never stops ingestion. **Raw topics + data are stored next to every decoded
  event**, so after refreshing the ABI `perps-indexer reindex-from-raw` re-derives the decoded events from Postgres alone
  (no RPC) and the next start rebuilds the read models. See "Refreshing the ABI".
* **Ordering / idempotency**: events are keyed by `(block_number, log_index)`. The DB insert is `ON CONFLICT DO NOTHING`
  and the reducer skips any key `<=` the last applied one, so ingesting the same logs twice equals once.
* **Checkpoint**: the `blocks` table (hash + parent hash) is committed atomically with the block's events; its highest
  row is the checkpoint. Hashes are kept for `--block-retention` blocks (default 100000, 0 = forever) and pruned beyond.
* **Snapshots**: every `--snapshot-every` blocks (default 5000) the whole reducer state is saved as JSON in the
  `snapshots` table keyed by `(block number, block hash)`; `--snapshot-keep` of them are retained. Startup and reorg
  recovery load the newest snapshot **at or below the common ancestor whose hash is still on the stored chain**, then
  replay only the events after it with the same pure reducer. Tests assert `snapshot + tail == full replay` (digest
  equality) and that a reorg replays only the tail; the e2e prints the snapshot block and replayed-event counts. A full
  replay happens only on a first start, after `reindex-from-raw`, or when no usable snapshot exists (a checkpoint is
  then written at the end of that replay).
* **Reorgs**: each step verifies the stored tip hash against the node and each new header's `parentHash` against the
  stored chain. On a mismatch it walks the stored hash chain back, page by page (`--reorg-window` blocks per page, batched
  header requests), to the first block that is still canonical, deletes events/blocks/snapshots after it, restores the
  newest snapshot at or below it, replays the tail, swaps the models in and tells websocket clients to resync. A reorg
  **deeper than `--reorg-window` is not fatal**: it is re-anchored beyond the window, counted in
  `indexer_deep_reorgs_total`, and sets a sticky operator alert (`/v1/status.data.alert`, `indexer_alert_active 1`).
  Indexing halts (`/v1/status.halted`, `/readyz` fails) only if the node's chain shares no block with the retained
  history (deeper than `--block-retention`, or a different chain). With `--block-retention` huge that means "never".
* **Read models are a pure function of the event log** (`src/state.rs::State::apply`): markets, orders (derived status),
  fills/trades, 1m/5m/1h candles, positions (from fills + liquidations + ADL), market funding updates and per-account
  settlements, liquidations, bad-debt/ADL/recapitalisation events, deposits/withdrawals/internal transfers/isolated
  margin, TWAP and conditional order status, and the order book (levels rebuilt from events, per-market `seq`).
  A wiped DB re-indexed from block 0 yields byte-identical read models (`State::digest`; checked in unit tests and e2e).
* Market tick/lot/limits are not events (the contract has no market-created event), so they are read once at startup with
  `eth_call getMarket(i)`; market names come from the deployment JSON. Static metadata is excluded from determinism checks.

### What is bounded in memory (exactly)

Only **fills / trades** are bounded: the newest `--mem-fills` (default 500000) fill rows stay in memory (a `VecDeque` with
absolute indexes); older ones are evicted and `/v1/markets/{m}/trades` and `/v1/accounts/{a}/fills` page through
PostgreSQL (indexed SQL; the taker order id is derived with a lateral join) transparently across the boundary, with the same
cursors. Candle buckets, the book, positions, and **orders, transfers, funding, TWAP/conditional rows, liquidations are
still O(history) in memory** (and so is the snapshot JSON, which grows with them: ~17 kB for the 100-event e2e chain).
Snapshot cost is a serialization of the full state every `--snapshot-every` blocks, done while holding the state lock.
Startup/reorg cost is therefore O(events since the last snapshot) plus O(snapshot size), no longer O(all events).

### Order status derivation

`accepted` (transient inside a tx) -> `open` (OrderRested) -> `partially_filled` / `filled` (Fill) ; `canceled` (any
user / liquidation / replace cancel, including IOC remainders); `expired` (lazy expiry cancel); `rejected` (the
contract cancelled a resting order for self-trade / invalid reduce-only / maker margin **with zero fills**). The
contract emits `OrderCanceled(Filled)` *before* the last `Fill`, which the reducer handles.

### Reverted transactions

A reverted transaction emits **no events**, so no indexer built on logs can see it: orders rejected at entry, failed
withdrawals, etc. do not appear in any endpoint. That is a property of the chain, not something to fix in the indexer.
For clients that need to know, an **opt-in receipt tracker** (`--enable-tx-tracker`) lets them `POST /v1/tx/track
{"tx_hash":...}` and then `GET /v1/tx/{hash}` for `pending | success | reverted | dropped` (block, gas used) taken from
`eth_getTransactionReceipt`. It only reports what the client asks about; it does not discover other people's reverts.
`dropped` means no receipt within `--tx-track-timeout-secs`; it can still change if the tx lands later.

### ADL accounting

`AdlExecuted` does not carry the backstop leg's price (the contract's newer ABI may add `markPrice`; when present the leg is
exact). Without it the indexer estimates it as `pT -/+ debtCleared*1e8/size`, which is within `1e8/size + 1` price units. The
ADL leg only reduces the backstop pro rata, so the backstop's **size and basis stay exact** (the e2e asserts them against
`positions(BACKSTOP)`); only `realized_pnl` is approximate, flagged `approximate: true` with an explicit
`realized_pnl_error_bound` (micro-USDC) on the position. The e2e gap-move scenario (`BadDebtUnresolved` -> `AdlExecuted` ->
`Recapitalized`) asserts `/v1/bad-debt` rows and the debt arithmetic against ethers-decoded chain events and `adlDebt()`.

### Backstop events
`BackstopSynced`, `AdlSkipped`, `AdlHardPremSet` and `WithdrawGateSet` are decoded and served at `GET /v1/backstop/events` (see `docs/openapi.yaml`; kinds `backstop_synced`,
`adl_skipped`, `adl_hard_prem_set`, `withdraw_gate_set`). A `BadDebtUnresolved` whose `acct` is the BACKSTOP key comes from a backstop sync. Current backstop equity, `bsDebt`,
insurance and the withdrawal-gate threshold are contract views (`backstopEquity`, `bsDebt`, `insurance`, `wdGateThreshold`); the indexer does not poll views (no RPC calls beyond logs),
so clients read those from the chain.

### Cancel reasons and bad-debt sources
`cancel_reason` on orders is one of `user, expired, self_trade, invalid_reduce_only, maker_margin, filled, liquidation, replaced, price_band, unknown`.
`price_band` (contract `CancelReason.PriceBand = 8`) means a resting order was outside index +/- `bandBps` when a taker reached it; it derives to status `canceled`.
`/v1/bad-debt` rows of kind `bad_debt_unresolved` can now come from liquidations, ordinary fills, delist settlement or the permissionless `writeOff(account, market)`
call; the indexer is event-based so the originating tx type does not matter (it does not separately index `writeOff` calls: no call tracing). Refresh the embedded ABI with
`scripts/refresh-abi.sh` and rebuild (the label table in `src/ser.rs` must contain every cancel label or snapshot restore fails).

## Run

PostgreSQL is the target store and is what is tested (PostgreSQL 14 on this machine). Create an empty database first.

```bash
cd services/indexer
createdb perps_indexer

# local chain (from ./contracts) and deployment
(cd ../../contracts && npx hardhat node) &
(cd ../../contracts && npx hardhat run scripts/deploy.js --network localhost)

cargo run --release -- \
  --rpc-url http://127.0.0.1:8545 \
  --database-url "host=localhost user=$USER dbname=perps_indexer" \
  --deployment ../../contracts/deployments/localhost.json \
  --listen 127.0.0.1:8080

curl -s localhost:8080/v1/status | jq
curl -s localhost:8080/v1/markets/0/book | jq
```

Useful flags (many also settable by env: `RPC_URL`, `DATABASE_URL`, `DEPLOYMENT`, `EXCHANGE`, `START_BLOCK`, `LISTEN`,
`REDIS_URL`, `CORS_ORIGINS`, `TRUSTED_PROXIES`, `ABI_FILE`; `--help` lists all with defaults):
`--exchange 0x..` (instead of `--deployment`), `--start-block N` (for an already-live chain: positions of accounts that
traded earlier will be incomplete, `indexer_unknown_refs_total` shows when events reference unseen orders), `--batch`,
`--confirmations`, `--wipe` (drop tables, full re-index), `--ready-max-lag`, `--ws-queue`; history: `--snapshot-every`,
`--snapshot-keep`, `--mem-fills`, `--reorg-window`, `--block-retention`; RPC: `--rpc-batch-size` (default 50 headers per
JSON-RPC batch), `--header-concurrency` (4), `--no-prefetch`; `--abi-file`; `--enable-tx-tracker`. The DB is pinned to one
`(chain id, exchange)`; pointing it at another deployment is refused.

### Security (all optional, all off or deny-by-default)

* **CORS**: default deny except `localhost`/`127.0.0.1` origins; add exact origins with `--cors-origins a,b` (`*` only if you
  explicitly pass it). Foreign origins get no `Access-Control-Allow-Origin`.
* **API keys**: `perps-indexer keys create --label x [--rps N --burst N]` prints `pk_<id>_<secret>` **once**; Postgres stores
  only its keccak256 (compared in constant time). `keys list` / `keys revoke <id>`; running servers reload the table every
  `--key-refresh-secs`. Send `X-API-Key` or `Authorization: Bearer`. `--require-api-key` makes keys mandatory on `/v1`;
  without it a presented key is still validated. Keys are read-only by construction (the API has no write route besides the
  opt-in tracker POST, which also needs a key when keys are required). `/healthz`, `/readyz`, `/metrics` stay open.
* **Rate limits**: token bucket per key (key override or `--key-rate-*`) when authenticated, else per client IP
  (`--rate-rps/--rate-burst`; 0 disables). The client IP is the socket peer; `X-Forwarded-For` is read **only** when the
  peer is in `--trusted-proxies` (IPs/CIDRs), taking the right-most untrusted hop, so an untrusted client cannot rotate
  the header to dodge limits.
* **Redis**: with `--redis-url`/`REDIS_URL` the buckets are shared by all replicas (a Lua token bucket using Redis `TIME`);
  if Redis is unreachable the limiter logs, counts `rate_limit_backend_errors_total` and falls back to the in-process
  bucket, so the API stays up. The client is a minimal RESP implementation: plain TCP + optional password, **no TLS, no
  cluster/sentinel** (untested; terminate TLS in a sidecar or use a proxy).

Backfill performance (`scripts/bench_headers.sh`, release build, local hardhat node, 3020 blocks indexed from scratch;
"proxy" adds a fixed 20 ms to each HTTP request like a remote provider):

| case | time | blocks/s |
|---|---|---|
| direct, legacy one request per header (`--rpc-batch-size 1 --header-concurrency 1 --no-prefetch`) | 1.62 s | 1860 |
| direct, batched 100 + prefetch | 0.71 s | 4276 |
| 20 ms/request, legacy | 69.45 s | 43 |
| 20 ms/request, batched 100 + prefetch | 2.84 s | 1064 |

The gain is round trips: 24x against a latency-bound node, 2.3x against a local one (where the bottleneck becomes Postgres
and the reducer). Numbers vary run to run (an earlier run measured 14.0 s vs 0.84 s for a 600-block slice at 20 ms).

### Refreshing the ABI

When the contracts change, run `scripts/refresh-abi.sh` (copies `contracts/abi/PerpExchange.merged.json`, validates it, and
lists added/removed events), then `cargo build --release`. Events the old binary did not know were stored raw: run
`perps-indexer reindex-from-raw` once against the database and restart (the command also clears snapshots because they
embed the old decoding). `--abi-file` lets a running deployment decode with a newer ABI without rebuilding. Events that
exist in the ABI but that the reducer does not model yet (for example newly added events) are decoded and kept as `Other`
until the reducer learns them.

Endpoints: see `docs/openapi.yaml` (OpenAPI 3.1) and `docs/ws-schemas.md`. `/v1/status` reports the indexed head, chain
head and lag, and keeps **canonical execution** (latest block on the execution node) separate from **parent-chain
finality**, which is always `unknown` here (local chains have no parent chain and this service does not read batch
posting or finality data). `/healthz` (liveness), `/readyz` (synced), `/metrics` (Prometheus) are exempt from rate limits.

## Tests

```bash
cargo build --locked
cargo clippy --locked --all-targets -- -D warnings
TEST_DATABASE_URL="host=localhost user=$USER dbname=postgres" cargo test --locked   # without it the Postgres tests print a skip notice
./tests/e2e.sh               # needs node, jq, curl, a running local PostgreSQL (creates DB perps_indexer_e2e), free ports; redis-server optional
scripts/bench_headers.sh     # backfill benchmark
```

Unit tests (59) use `MemStore`, which honours the `PgStore` contract, plus real PostgreSQL integration tests (own scratch
databases) and a real Redis test (skipped when `redis-server` is absent). They cover status derivation, book deltas,
candles, position math, liquidation/ADL/TWAP/conditional handling, idempotent double ingestion, replay == incremental
for every chunking, snapshot + tail == full replay, bounded reorg replay, re-anchoring beyond the window, pagination across
the memory/Postgres boundary, tolerant decoding and `reindex-from-raw`, CIDR/XFF handling, API keys, CORS, per-key and per-IP
limits, Redis-shared limits with fallback, the receipt tracker, API error codes, readiness, metrics and websocket behaviour.

`tests/e2e.sh` boots its own `hardhat node` on a free port (via `scripts/hardhat.e2e.config.js`, which only *reads* the
contracts project; nothing in `contracts/` is modified and `deployments/` is written under `.e2e/`), deploys, starts
the indexer **before** trading, runs `scripts/scenario.js`, then asserts the REST/WS output against ground truth read from
the contracts (views and ethers-decoded events, independent of the Rust decoder), restarts from the checkpoint, wipes the
DB and re-indexes from block 0 (dumps of ~90 endpoint results must be byte-identical). The same run then checks: restart
replays only the snapshot tail; raw topics/data are stored for every event; an ABI missing `AdlExecuted`/`Recapitalized`
keeps ingesting and `reindex-from-raw` restores identical read models; API keys, CORS, per-key/per-IP limits, a trusted
proxy and Redis-shared limits (killing Redis mid-run); the reverted-tx tracker (`scripts/txtrack.js`); a real chain reorg
with `evm_snapshot`/`evm_revert` (`scripts/reorg.js`); and a reorg deeper than `--reorg-window` (`scripts/deepreorg.js`),
each compared against a fresh re-index. (Mining uses `evm_mine`: `hardhat_mine` writes zero parent hashes, which no
hash-linked indexer can follow.)

## Known limitations (read before trusting it)

* **Not everything is bounded**: only fills/trades have a memory cap. Orders, transfers, funding, TWAP/conditional rows,
  liquidations and candle buckets are O(history) in memory, and so are snapshots. Startup is O(snapshot + tail), not O(1).
  Postgres holds the canonical *log* and snapshots, not queryable read-model tables.
* Reorg recovery is bounded by `--block-retention` (default 100000 blocks of hashes) and by the snapshots kept: if no kept
  snapshot is at or below the fork point the rebuild replays from the start. A chain that shares no retained block halts
  indexing. Deep reorgs are survivable but should be treated as an incident (alert, metric).
* Amounts above `u128` saturate (cannot occur for 1e6/1e8-scaled values; `indexer_overflow_total` counts any saturation).
* Positions/`realized_pnl` mirror the contract's `_applyFill` math from events; the e2e compares size and basis to
  `positions()` on chain for every account and market in the scenario, but there is no continuous on-chain reconciliation job.
  The backstop's post-ADL `realized_pnl` is approximate with an explicit error bound unless the event carries the mark price.
  Unrealised PnL / mark price are not exposed (mark price is not an event).
* EIP-1271/signed orders are covered by unit-test fixtures only. Funding settlements only appear when the contract settles an
  account (lazily on its next action). Reverted transactions are invisible except through the opt-in tracker.
* Candles only exist for buckets with trades (no gap filling). Open interest is the contract's definition (sum of longs).
* Auth is a coarse read-only key, not user accounts; account channels remain public data. The Redis client has no TLS or
  cluster support and was only tested against a single local redis-server. Put a real gateway in front of anything public.
* Verified only against a local Hardhat node, PostgreSQL 14 and a local Redis. Not tested against Nitro, a remote RPC, other
  Postgres versions, or reorgs produced by a real consensus layer (the e2e uses `evm_revert`).
