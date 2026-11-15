# infra/testnet - Arbitrum Sepolia preparation (UNAUDITED PROTOTYPE, test funds only)

| File | Purpose |
|---|---|
| `testnet.config.json` | single source of truth: USDC, Chainlink feeds, Pyth contract + feed ids, market parameters, expected deployer. Every address has a `source` URL; `verifiedOnChain` is written only by `contracts/scripts/testnet/verify-addresses.js` |
| `env.testnet.example` | variable names for keeper/indexer/frontend (copy to `services.env`, git-ignored) |
| `docker-compose.testnet.yml` | postgres + indexer + keeper in dry-run; reads the chain only |
| `TESTNET_UI_PLAN.md` | what the frontend owner must change |
| `smoke-last-run.json` | written by `smoke-testnet.js` (no secrets) |
| `backstop-enable-last-run.json`, `backstop-demo-last-run.json` | written by `enable-backstop.js` and `demo-backstop.js` after a broadcast (tx hashes, Arbiscan links; no secrets) |

Scripts live in `contracts/scripts/testnet/`, config in `contracts/hardhat.testnet.config.js`, secrets template in `contracts/.env.example`.
Everything is dry-run by default; each broadcast needs its own `CONFIRM_*=yes` variable AND chainId 421614 AND (for signing) a key whose address equals `expectedDeployer`.
Optional variables: `ORACLE_MODE=median|chainlink` (default from `oracle.mode`, see the decision rule in the runbook), `DEMO_MARKET=no` (skip the admin-priced DEMO-USD market), `CONFIRM_ENABLE_BACKSTOP=yes`, `CONFIRM_BACKSTOP_DEMO=yes`, `DEMO_DEPOSIT_USDC` (default 6), `DEMO_WAIT_SECS`, `BACKSTOP_MARKETS`.
Step-by-step (including the ordered backstop demo command list and cost estimate): `docs/TESTNET_RUNBOOK.md` section 16. Go/no-go beyond testnet: `docs/LAUNCH_CHECKLIST.md`.

## Run the testnet stack (read-only indexer, optional keeper dry-run, UI)
Nothing here uses a key or sends a transaction (the keeper is dry-run unless you opt in below). Everything is driven by `contracts/deployments/arbitrumSepolia.json`; no address is hardcoded elsewhere.

| What | Command | URL / port | PID file, log (git-ignored) |
|---|---|---|---|
| RPC forwarders + indexer (Postgres DB `perps_testnet`) | `infra/testnet/run-indexer.sh start` | indexer API `http://127.0.0.1:18700` (`/v1/status`, `/metrics`), forwarders `:18701` (indexer/keeper) and `:18702` (browser, CORS + cache) | `indexer.pid`, `rpc-proxy.pid`, `rpc-proxy-ui.pid`; `indexer.log`, `rpc-proxy*.log` |
| Keeper, DRY-RUN | `infra/testnet/run-keeper.sh start` | metrics `http://127.0.0.1:9150/metrics` | `keeper.pid`, `keeper.log` |
| UI (testnet mode) | `cd frontend && npm run dev:testnet` | `http://localhost:3150` (dist dir `.next-testnet`; the LOCAL demo on :3147 is untouched) | `ui.pid`, `ui.log` |

Upstream RPC: the indexer defaults to `https://arbitrum-sepolia-rpc.publicnode.com` because the official `https://sepolia-rollup.arbitrum.io/rpc` answered 429 to most indexer traffic (batches above ~40 and bursts); the UI forwarder (`:18702`) also uses the same upstream (override with `INDEXER_RPC_URL`).
Why forwarders: the Rust indexer and keeper binaries have no TLS client (`invalid URL, scheme is not http`), so they talk to a local http forwarder (`rpc-proxy.js`) that calls the https RPC, splits large batches into chunks, spaces upstream calls, spaces upstream calls and retries with backoff. The browser UI uses the second instance because the public endpoint sends a duplicate CORS header that browsers reject.
Own RPC (fewer rate limits): `INDEXER_RPC_URL=https://<your provider>/<key> infra/testnet/run-indexer.sh start` (set it in your shell; do not write it into a file in git). Indexer parameters for Arbitrum Sepolia (about 0.25 s blocks): `--reorg-window 600` (2.5 min of blocks for the hash walk), `--block-retention 2000000` (about 6 days of block hashes), `--confirmations 0`, 1 s poll, 1000-block log batches, header batches of 50. Finality of L2 blocks on the parent chain is not tracked: unknown. Status: `infra/testnet/run-indexer.sh status`.
Optional keeper dry-run: `infra/testnet/run-keeper.sh start` (config `keeper.testnet.toml`: dry_run on, no signer, Pyth pusher off because oracle mode is chainlink, writeoff/sync/poke/unwind jobs enabled in simulation only, gas budgets 0.05 USD).
**Live keeper (later, optional):** use a SEPARATE funded testnet-only key, never the deployer key: `export KEEPER_PRIVATE_KEY=0x...` (the keeper's real env name; stays in your shell) then `KEEPER_LIVE=yes infra/testnet/run-keeper.sh start`. Warning: only liquidations pay the keeper; writeOff/syncBackstop/pokeBackstop/unwindBackstop pay nothing and spend its testnet ETH (budgets in `keeper.testnet.toml`, `max_fee_gwei = 2`); fund it with a small amount only.
Stop everything: `infra/testnet/run-keeper.sh stop; infra/testnet/run-indexer.sh stop; kill $(lsof -tiTCP:3150 -sTCP:LISTEN) $(cat infra/testnet/ui.pid)` (the listener on 3150 is the testnet UI only).

### Re-point after a REDEPLOY (new addresses)
1. Deploy as in the runbook; it writes a new `contracts/deployments/arbitrumSepolia.json` (move the old one aside first; the script refuses to overwrite). Keep the ABI in sync if contracts changed: `cd contracts && npx hardhat run scripts/export-abi.js`, then `cd frontend && node scripts/sync-deployment.mjs arbitrumSepolia --out deployment.testnet.json` copies the ABI too.
2. Indexer: `infra/testnet/run-indexer.sh reset` (stops, drops and recreates `perps_testnet`, starts from the new `startBlock`). If the event set changed, rebuild the binary (`cd services/indexer && cargo build --release --locked`) and refresh the ABI (`scripts/refresh-abi.sh`).
3. Keeper (if running): `run-keeper.sh stop; rm -f infra/testnet/keeper-state.json; run-keeper.sh start` (reads the exchange and start block from the same file).
4. UI: `cd frontend && npm run sync:testnet`; the dev server picks up the new file (restart `npm run dev:testnet` if the market list changed).
5. Update `infra/testnet/testnet.config.json` only if parameters changed.

## Forwarder limits and the market-maker bot
The `:18701` forwarder (indexer + keeper) handles ONE upstream call at a time. A bot on it starves the indexer: run the bot on the browser forwarder instead:
`MM_RPC_URL=http://127.0.0.1:18702 npm run testnet-mm run` (from `bots/`). `rpc-proxy.js` now times out an upstream call after 12 s (`PROXY_UPSTREAM_TIMEOUT_MS`); before, one call that never answered held the only slot forever and froze the indexer, keeper and bot. If a bot shutdown (Ctrl-C) hangs, `kill -9` it: its quotes expire on their own after `QUOTE_TTL_SEC` (900 s).
