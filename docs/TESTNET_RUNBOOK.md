# Arbitrum Sepolia testnet runbook

UNAUDITED PROTOTYPE. Public testnet, test funds only. Nothing here is a statement that the contracts are safe.
Nothing in this runbook has been broadcast yet: as of writing, every script was exercised only read-only (public RPC) or on an in-process chain.

All commands run from `/Users/arunmozhi/Perps/contracts` unless stated. Shorthand used below:

```bash
cd /Users/arunmozhi/Perps/contracts
export HH="npx hardhat --config hardhat.testnet.config.js"
```

"Who": **user** = you, in your terminal; **agent** = Claude can run it (read-only or no key needed).
Every broadcast is a dry run until you set its own `CONFIRM_*=yes` for that single command (use an inline prefix, do not leave it exported).

## 0. Key hygiene (user, once)

* Use a **testnet-only** wallet that never held real funds. Expected deployer address (public): `0x50C05D162dF2EFc2f2b9a24708bE0BcDAf8d6B29`, recorded as `expectedDeployer` in `infra/testnet/testnet.config.json`. Every signing script refuses to run if the key in `.env` derives a different address.
* The key lives only in `contracts/.env` (variable `DEPLOYER_PRIVATE_KEY`). Never paste it into chat, a ticket, a shell history line, or a commit. Use the template `contracts/.env.example` (value-free).
* Lock the file down: `chmod 600 contracts/.env`. **The config refuses to load any private key while `.env` is readable by group/others** (as of writing `contracts/.env` is mode 644, so any key placed there will be refused until you run this). It also refuses if a `*PRIVATE_KEY=<64 hex>` assignment appears in `.env.example`, `infra/testnet/**` or these docs.
* `.gitignore` (repo root) now ignores `.env`, `.env.*` (except `.env.example`), `infra/testnet/services.env`, keeper state and keystores. **The repo is not a git repository yet**, so `git check-ignore` cannot work until `git init`. After `git init` run:
  `git check-ignore -v contracts/.env infra/testnet/services.env` (both must print a rule) and `git ls-files | grep -E '(^|/)\.env$'` (must print nothing).
* Use a different key for the keeper (`KEEPER_PRIVATE_KEY`) and never reuse the deployer key anywhere else.

## 1. Accounts and keys (user)

| Item | Variable (in `contracts/.env`) | How |
|---|---|---|
| Deployer key | `DEPLOYER_PRIVATE_KEY` | Export a **new** account from your wallet (account details > show private key), paste into `.env` on your machine only. |
| RPC | `ARB_SEPOLIA_RPC_URL` | Create a free Arbitrum Sepolia endpoint at Alchemy, Infura or QuickNode. The public `https://sepolia-rollup.arbitrum.io/rpc` is the default and fine for read-only checks, but rate-limited; use a dedicated URL to deploy. The URL may embed a key: treat it as a secret. |
| Arbiscan key | `ARBISCAN_API_KEY` | Create one at https://etherscan.io (API Keys). One Etherscan v2 key covers Arbiscan, chain 421614. Only needed for step 11. |
| Guardian (optional) | `GUARDIAN_ADDRESS` | A *separate* address that may pause markets. Not set to your deployer unless you decide so. |

## 2. Faucets (user)

* Arbitrum Sepolia ETH (gas). Faucets listed in Arbitrum's own docs (https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info): https://arbitrum.faucet.dev/ , https://ethfaucet.com/networks/arbitrum , https://sepoliafaucet.com/ . Also found (not in that Arbitrum list): https://faucets.chain.link/arbitrum-sepolia . Limits and sign-in requirements change; check each page.
* Test USDC: Circle faucet https://faucet.circle.com (select Arbitrum Sepolia, paste address). Token: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (Circle docs: https://developers.circle.com/stablecoins/usdc-contract-addresses). I did not open the faucet page itself (no per-request amount verified); the HTTP check only confirmed it responds.
* State at the time of writing (read-only RPC query): deployer `0x50C0...6B29` holds **0.018992 ETH, 0 USDC**, nonce 0, no code (plain EOA). A dry-run estimate for the whole deployment is about 0.001 ETH at the observed 0.04 gwei, so the ETH is probably enough; **you need test USDC for the smoke test** (default deposit is 5 USDC per side).

## 3. Offline checks (agent or user, no key needed)

```bash
unset DEPLOYER_PRIVATE_KEY TRADER2_PRIVATE_KEY   # optional: makes everything read-only even if .env has a key
node --test scripts/testnet/tests/lib.test.js scripts/testnet/tests/backstop-guards.test.js   # 14 + 6 guard/config tests (agent)
$HH run scripts/testnet/tests/selectors-check.js                               # every merged-ABI function is registered by deploy-testnet.js (agent)
$HH run scripts/testnet/tests/backstop-scripts-local.js                        # enable-backstop + demo-backstop end to end on in-process chain (agent)
SMOKE_NO_MAIN=1 $HH run scripts/testnet/tests/local-e2e.js                     # smoke logic on in-process chain (agent)
LOCAL_SIMULATE=1 $HH run scripts/testnet/deploy-testnet.js                     # deploy plan on in-process chain (agent)
```
Expected: 14 + 6 pass; `selectors-check: PASSED`; `ALL BACKSTOP SCRIPT CHECKS PASSED`; "14 ok / 0 failed" for markets 0,1,2,3; a 23-step table ending `Local sanity: 38 selectors routed correctly; modulesLocked=false; marketCount=4`.
Abort if any fails: do not continue.

## 4. Environment check (agent: read-only; user: with key)

```bash
$HH run scripts/testnet/check-env.js --network arbitrumSepolia
```
Expected: `chainId OK 421614`, config OK, your address, ETH balance, USDC balance; `RESULT: PASS` (warnings are fine). With the key set it also prints `key matches expected deployer yes`. It prints the address, never the key. **Abort** on FAIL, especially a key/address mismatch.

## 5. Verify external addresses on-chain (agent: read-only)

```bash
$HH run scripts/testnet/verify-addresses.js --network arbitrumSepolia
```
Checks code, USDC `decimals()==6`/symbol, Chainlink `decimals/description/latestRoundData` freshness, Pyth `getPriceUnsafe`. Writes `verifiedOnChain` into `infra/testnet/testnet.config.json` (set `NO_WRITE=1` to skip). The deploy broadcast refuses unless all of these are `ok` and under 24 h old.

Observed on 2026-11-14 (block 329188932): 8 PASS / 0 FAIL. See "Verified facts" at the end. **Important:** the Pyth prices were ~6.8 days old, and Chainlink vs the (stale) Pyth prices differed by more than 3 percent (BTC 65.5k vs 75.6k). MedianOracle (3% max deviation, immutable) will revert with "source disagreement" if the two sources still disagree after a fresh Pyth push. Check this BEFORE deploying (step 6).

## 6. Pyth freshness (user; needs a Hermes endpoint)

Pyth is a pull oracle: prices only exist on-chain when somebody pushes a signed update. The exchange cannot trade until BOTH sources are fresh (< `medianMaxAgeSecs`, 3600 s).

```bash
$HH run scripts/testnet/push-pyth.js --network arbitrumSepolia                          # dry-run: fetch + fee quote
CONFIRM_PYTH_PUSH=yes $HH run scripts/testnet/push-pyth.js --network arbitrumSepolia    # user: broadcast (tiny fee)
$HH run scripts/testnet/verify-addresses.js --network arbitrumSepolia                   # compare Chainlink vs Pyth price per market
```
**Known problem:** when tested, both `https://hermes.pyth.network` and `https://hermes-beta.pyth.network` answered `401 unauthorized` on `/v2/updates/price/latest` (the `/v2/price_feeds` listing worked). So the dry run currently fails at the fetch. Set `HERMES_URL` to an endpoint you can use (do not paste a keyed URL in chat). Whether the Arbitrum Sepolia Pyth contract expects the stable or the beta Hermes channel is **unverified**; the contract answered with stable feed ids, but the simulated `updatePriceFeeds` (the script simulates before sending) will tell you.
**Decision point:** if after a push the two prices differ by more than 3 percent for a market, either change `oracle.medianMaxDevBps` in `testnet.config.json` BEFORE deploying (it is an immutable constructor argument) or accept that this market's reads revert.

### Keeper Pyth pusher (implemented; off by default)
`services/keeper` can keep Pyth fresh itself (`src/features/pyth_push.rs`; details, metrics and failure handling in `services/keeper/README.md` "Pyth price pusher", operations in `docs/RUNBOOKS.md` 1a). It is unit-tested against mocks and a fake node only; it has **not** been run against Arbitrum Sepolia or a real Hermes (no usable Hermes endpoint was available), so treat the first live run as a test.
```bash
# keeper env (see infra/testnet/env.testnet.example): KEEPER_PRIVATE_KEY (testnet-only key with a little ETH), HERMES_API_KEY (Hermes needs a key; the keeper also accepts KEEPER_HERMES_API_KEY), optional KEEPER_HERMES_URL (default https://pyth.dourolabs.app/hermes)
KEEPER_ENABLE_PYTH_PUSH=true \
KEEPER_PYTH_CONTRACT=0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF \
KEEPER_PYTH_FEED_IDS=BTC=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43,ETH=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace,SOL=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d \
KEEPER_DRY_RUN=true  perp-keeper ...        # first: dry-run, watch keeper_pyth_push_total{result="dry_run"} and the `pyth:` logs
```
Then drop `KEEPER_DRY_RUN` to let it send. Defaults: check every 20 s, push when any feed is older than 1800 s (half of `medianMaxAgeSecs` 3600), at most 0.0001 ETH update fee per push, gas <= $0.50 per push, 0.005 ETH per rolling hour (fee + worst-case gas), all configurable (`KEEPER_PYTH_*`). It will not push when Hermes has nothing newer than the chain, and it backs off on Hermes 401/429/5xx. The **Hermes 401 problem above** is solved by a key: the keeper sends `Authorization: Bearer $HERMES_API_KEY` to `https://pyth.dourolabs.app/hermes` by default (verified for the manual curl-equivalent by the project owner). To check the real response format with your key: `PYTH_LIVE_TEST=1 HERMES_API_KEY=... cargo test --test hermes_live -- --nocapture` in `services/keeper`. Set `pyth_max_age_secs` to `oracle.medianMaxAgeSecs` from `testnet.config.json`.
Metrics: `keeper_pyth_age_seconds{feed}` (alert > 1800), `keeper_pyth_push_total{result}`, `keeper_pyth_fee_wei_total`, `keeper_pyth_gas_wei_total`, `keeper_pyth_hermes_errors_total{kind}`.
**Fallback:** `push-pyth.js` above (manual, or `SMOKE_PUSH_PYTH=yes`) remains the way to push by hand and to dry-run the Hermes channel question. The keeper does not remove the "decision point" below: the Chainlink vs Pyth 3 percent deviation check is independent of who pushes.

## 7. Deployment dry-run (agent with key-less read-only, or user)

```bash
$HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia
```
Prints: mode `DRY-RUN`, deployer, the ordered plan (ChainlinkAdapter + 3 `setFeed`, PythAdapter, MedianOracle, PerpExchange, 5 modules each followed by `registerModule`, 4 `createMarket` incl. the DEMO-USD market, DemoManualOracle + RoutingOracle, one demo `set(100)`), predicted addresses, bytecode sizes (largest: PerpExchange 22,697 B < 24,576; PerpExtras 19,034; PerpLiquidation 18,306; PerpTrading 17,815; PerpAdl 15,112; PerpTwap 10,701; RoutingOracle 739), gas estimates for steps that do not depend on undeployed contracts (calls show `estimate n/a`). Observed: about 28M gas in total for chainlink mode (deploys ~25M, calls ~3M; 27.7M for the steps the local simulation shows); reference gas from the in-process run for the dependent calls: setFeed 44k, registerModule 99k-348k, createMarket 288k each.
Optional env: `GUARDIAN_ADDRESS=0x..`, `USE_MOCK_USDC=yes` (deploys MockUSDC faucet token instead of using Circle USDC; useful if you cannot get faucet USDC).
**Differences from `scripts/deploy.js` (local):** oracle = MedianOracle(Chainlink, Pyth) instead of ManualOracle; collateral = Circle test USDC instead of MockUSDC; `maxOrderSize`/`maxOI` cut about 10,000x (BTC 1 / 10, ETH 20 / 200, SOL 400 / 4000 units) to bound testnet exposure; tick, lot, minNotional, band, spread, funding, margin tiers identical; admin is the deployer EOA (as locally) and the module table is NOT locked.

## 8. Deploy (USER ONLY: broadcasts transactions)

Preconditions: steps 4-7 clean, `chmod 600 .env`, key in `.env`, `verifiedOnChain` fresh, Pyth decision (step 6) made.

```bash
CONFIRM_TESTNET_DEPLOY=yes $HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia
```
Expected: `MODE: BROADCAST`, about 22 transactions in chainlink mode, 24 in median mode (+1 with GUARDIAN_ADDRESS) with block numbers, `Wrote contracts/deployments/arbitrumSepolia.json`. The script refuses to overwrite an existing deployment file. **Rollback:** there is none on-chain; testnet contracts are abandoned and redeployed (move the JSON aside first). If it fails midway, nothing is recorded in the JSON; note the addresses from the console and redeploy from scratch.
Why the module table stays unlocked: `lockModules()` is irreversible. During smoke tests you may discover a module bug; with the table unlocked you can deploy a fixed module and `registerModule` it, with it locked you must redeploy everything. Lock after tests pass (step 13).
Why ADMIN stays the deployer EOA: the smoke/rehearsal steps need admin calls. Hand over in step 14.

## 9. Check on Arbiscan (user)

Open `https://sepolia.arbiscan.io/address/<exchange>`: contract created by `0x50C0...6B29`; about 22 txs from the deployer in sequence; in Read Contract: `modulesLocked=false`, `marketCount=4`, `oracle` = the RoutingOracle address (its `main` is the ChainlinkAdapter, or the MedianOracle in median mode; `demoFeed` routes to the demo ManualOracle), `usdc` = `0x75fa...AA4d`, `hasRole(DEFAULT_ADMIN_ROLE, deployer)=true`. The JSON also has every tx hash.

## 10. Smoke test (agent can dry-run; USER broadcasts)

```bash
$HH run scripts/testnet/smoke-testnet.js --network arbitrumSepolia                    # dry-run: preflight + oracle read
CONFIRM_TESTNET_SMOKE=yes SMOKE_PUSH_PYTH=yes $HH run scripts/testnet/smoke-testnet.js --network arbitrumSepolia   # user
```
Needs >= 5 USDC (`SMOKE_DEPOSIT_USDC`) from the Circle faucet in the deployer wallet. Optional second trader: `TRADER2_PRIVATE_KEY` (another testnet-only key with ETH and USDC); otherwise sub-account 1 of the deployer is the counterparty. Steps: approve, deposit x2, place + cancel a resting bid, maker bid + taker IOC cross (requires a `Fill` event), close both sides reduce-only, `pokeFunding`, `accountState`, withdraw 1 USDC. Output: `infra/testnet/smoke-last-run.json` with gas, submit latency, 1-confirmation mined latency per stage. Stops trading steps at the first failure. If the oracle read fails, the message tells you to push Pyth.
Not a result yet: the local in-process version of this script passed all 14 stages on all 3 markets; the live run has not happened.

## 11. Verify source on Arbiscan (user; needs ARBISCAN_API_KEY)

```bash
VERIFY_DRY=1 $HH run scripts/testnet/verify-contracts.js --network arbitrumSepolia   # preview args
$HH run scripts/testnet/verify-contracts.js --network arbitrumSepolia
```
Compiler settings are inherited from `hardhat.config.js` (solc 0.8.24, viaIR, optimizer 200 runs, cancun). "Already verified" is reported as ALREADY. If a viaIR contract fails to match, check you compiled with the same config (`$HH compile --force`).

## 12. Wire up services and frontend (user + frontend owner)

```bash
cp infra/testnet/env.testnet.example infra/testnet/services.env    # fill from arbitrumSepolia.json (exchange, startBlock)
docker compose -f infra/testnet/docker-compose.testnet.yml --env-file infra/testnet/services.env up -d --build
(cd ../frontend && node scripts/sync-deployment.mjs arbitrumSepolia)   # frontend owner; see infra/testnet/TESTNET_UI_PLAN.md first
```
**Without docker (what is actually running for the demo):** `infra/testnet/run-indexer.sh start`, optional `infra/testnet/run-keeper.sh start` (dry-run), `cd frontend && npm run dev:testnet` (http://localhost:3150). Stop, ports, own-RPC and the re-point steps after a redeploy are in `infra/testnet/README.md` section "Run the testnet stack".

`docker compose config` validated the compose file's syntax only; images were not built. The Dockerfiles are the repo's existing untested templates. The keeper is dry-run with no key. Frontend labels: `infra/testnet/TESTNET_UI_PLAN.md`.

## 13. Lock modules (USER; IRREVERSIBLE; only after smoke tests and a soak period)

```bash
$HH run scripts/testnet/lock-modules.js --network arbitrumSepolia                         # dry-run
CONFIRM_LOCK_MODULES=yes $HH run scripts/testnet/lock-modules.js --network arbitrumSepolia
```

## 14. Admin handover to a timelock (USER; optional on testnet, required before any real launch)

```bash
PROPOSERS=0xYourMultisigOrAddress TIMELOCK_MIN_DELAY=3600 GUARDIAN_ADDRESS=0x... $HH run scripts/testnet/transfer-admin.js --network arbitrumSepolia   # dry-run
CONFIRM_TRANSFER_ADMIN=yes PROPOSERS=0x.. TIMELOCK_MIN_DELAY=3600 $HH run scripts/testnet/transfer-admin.js --network arbitrumSepolia
```
Deploys OpenZeppelin `TimelockController`, grants it `DEFAULT_ADMIN_ROLE`, optionally grants GUARDIAN, verifies, and renounces the deployer only with the additional `CONFIRM_RENOUNCE_DEPLOYER=yes`. Rehearse a scheduled operation (e.g. `setFees`) through the timelock before renouncing. Delay under 3600 s is refused; use >= 86400 s on any real network.

## What stays simulated on this testnet

* Liquidity: there are no real market makers. Any depth comes from your own bot (`bots/`) or manual orders; fills and prices are not meaningful market data.
* Collateral is faucet USDC with no value; no bridge or custody flows are exercised.
* Pyth freshness depends on a push: the keeper pusher (opt-in, section 6) or the manual script. The pusher needs a Hermes endpoint that does not answer 401.
* Any market without a Chainlink+Pyth feed would be `manual-oracle-only (testnet demo)` (excluded from the deployment unless run locally). All three current markets have both feeds on-chain.
* The keeper in the compose file is dry-run: liquidations are logged, not sent.

## What the testnet test does NOT prove

Contract security or solvency under adversarial conditions (no audit); behaviour under mainnet price volatility or liquidity; economic soundness of the funding/margin parameters; oracle reliability (testnet Chainlink feeds are noisy/low-activity and Pyth is not pushed unless you enable the keeper pusher or push by hand); real USDC behaviour (blacklisting, upgrades); Arbitrum sequencer outage handling (no sequencer-uptime check exists in `ChainlinkAdapter`); load, MEV, or keeper competition; the withdrawal-run window while bad debt exists; backstop phase 2 (not implemented); legal or compliance fitness.

## Verified facts (read-only, 2026-11-14)

| Item | Value | Source | On-chain check |
|---|---|---|---|
| Chain | Arbitrum Sepolia, id 421614 (0x66eee), RPC `https://sepolia-rollup.arbitrum.io/rpc`, explorer https://sepolia.arbiscan.io | https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info | eth_chainId = 0x66eee |
| USDC (Circle) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | https://developers.circle.com/stablecoins/usdc-contract-addresses | code present, decimals 6, symbol USDC, name "USD Coin" |
| Pyth Core | `0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF` | https://docs.pyth.network/price-feeds/core/contract-addresses/evm | `getPriceUnsafe` works for BTC/ETH/SOL ids; the other two listed contracts (Core Compatible `0x0B73...f42B`, Pro `0xACeA...F481`) reverted for at least BTC and SOL, so were not used |
| Pyth feed ids BTC/ETH/SOL | `0xe62df6c8...5b43`, `0xff61491a...0ace`, `0xef0d8b6f...b56d` (full values in config) | https://hermes.pyth.network/v2/price_feeds | each returned a (stale, ~6.8 days) price |
| Chainlink BTC/USD | `0x56a43EB56Da12C0dc1D972ACb089c06a5dEF8e69` (8 dec, heartbeat 120 s) | https://reference-data-directory.vercel.app/feeds-ethereum-testnet-sepolia-arbitrum-1.json (Chainlink's feed directory; the docs.chain.link addresses page itself was not retrievable) | description "BTC / USD", fresh |
| Chainlink ETH/USD | `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` | same | description "ETH / USD", fresh |
| Chainlink SOL/USD | `0x32377717BC9F9bA8Db45A244bCE77e7c0Cc5A775` (heartbeat 86400 s) | same | description "SOL / USD", updated ~12 min earlier |

Chainlink on L2: Chainlink docs say L2 consumers should also check the Sequencer Uptime Feed; `ChainlinkAdapter` does not. Not addressed here.


## 15. Oracle mode decision rule (ORACLE_MODE)

`ORACLE_MODE=median|chainlink` (env overrides `oracle.mode` in `infra/testnet/testnet.config.json`; default `chainlink`).
* `median`: Chainlink + Pyth through MedianOracle, BOTH must be fresh. Use it ONLY if `verify-addresses.js` prints `ORACLE MODE RECOMMENDATION: median` (every Pyth feed age <= `pythFreshSecs` = 600 s) AND the keeper Pyth pusher is running (section 6).
* `chainlink`: ChainlinkAdapter is the exchange oracle directly; Pyth is not used. Observed 2026-11-14: Pyth feeds were 590,481 s old and nothing was pushing, so the recommendation is `chainlink` (that is the config default).
* Per-market `maxAge` comes from measured Chainlink round gaps (read-only, last 25 rounds): BTC p95 150 s -> maxAge 600; ETH p95 60 s -> 600; SOL p95 8,100 s, max 10,591 s -> 14,400. The numbers and rule are in `oracle.chainlinkGapMeasurement`. A long SOL maxAge weakens staleness protection; testnet only.
* DEMO-USD never uses either: it reads a ManualOracle that only the deployer can move (a "demo market, admin-set price, not a real feed"), routed by RoutingOracle because the exchange oracle is exchange-wide.

## 16. The backstop demo: exact ordered USER command list ("see it on testnet")

Everything below is run BY YOU with your own testnet key in `contracts/.env` (nothing here was or will be broadcast by an agent). `HH="npx hardhat --config hardhat.testnet.config.js"`, run from `contracts/`. Every broadcasting script is dry-run unless its confirm variable is set, refuses any chain other than 421614, and never prints a key.

| # | Command | Broadcasts? | Expected |
|---|---|---|---|
| 1 | `$HH run scripts/testnet/check-env.js --network arbitrumSepolia` | no | `chainId OK 421614`, your address = expected deployer, ETH and USDC balances, `RESULT: PASS` |
| 2 | `$HH run scripts/testnet/verify-addresses.js --network arbitrumSepolia` | no | `9 PASS / 0 FAIL` (DEMO-USD row says admin-set), then `ORACLE MODE RECOMMENDATION: chainlink` unless Pyth is fresh |
| 3 | `$HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia` | no (dry-run) | `MODE: DRY-RUN`, plan with 4 markets, sizes (PerpExchange 22,697 B), no step fails |
| 4 | `CONFIRM_TESTNET_DEPLOY=yes $HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia` | yes, ~22 txs, ~28M gas | `MODE: BROADCAST`, writes `contracts/deployments/arbitrumSepolia.json` |
| 5 | `$HH run scripts/testnet/verify-contracts.js --network arbitrumSepolia` | no (needs `ARBISCAN_API_KEY`) | each contract `Verified` or `ALREADY` |
| 6 | `CONFIRM_TESTNET_SMOKE=yes $HH run scripts/testnet/smoke-testnet.js --network arbitrumSepolia` | yes, about 15 txs | all stages ok; needs >= 5 USDC (`SMOKE_DEPOSIT_USDC`); writes `infra/testnet/smoke-last-run.json` |
| 7 | `CONFIRM_ENABLE_BACKSTOP=yes $HH run scripts/testnet/enable-backstop.js --network arbitrumSepolia` | yes, 2 txs (BTC-USD + DEMO-USD `setBackstopCfg`, gas shown by the dry-run; `BACKSTOP_MARKETS=DEMO-USD` for only the demo) | table of values, `setBackstopCfg ok tx 0x...`; writes `infra/testnet/backstop-enable-last-run.json`. Run it without the variable first: it prints the plan |
| 8 | `CONFIRM_BACKSTOP_DEMO=yes $HH run scripts/testnet/demo-backstop.js --network arbitrumSepolia` | yes, 14 txs (13 with a single key), ~1.73M gas | stages: set price 100, approve, deposit x2, short rests 0.5 @100, long buys it, price 90, liquidate the long, `syncBackstop`, prints state (backstop size 0.5, inventory ~45 USDC vs soft 10, auction price and discount), waits `dwell + 15` s (45 s), `takeBackstop`, `pokeBackstop`, restore price 100, withdraw both. Writes `infra/testnet/backstop-demo-last-run.json` with an Arbiscan link per tx. Set `DEMO_WAIT_SECS=150` to wait out the whole ramp and see the full 150 bps discount |

Without the confirm variable, 7 and 8 are read-only dry-runs (plan, gas estimates, current state). A wrong chain, a missing confirm flag, a missing key, or a non-admin key aborts before any transaction. If the demo aborts midway it tries to restore the DEMO-USD price to 100 and reports which stage failed.

**Cost versus your budget (about 20 test USDC, about 0.019 ETH).** Gas (local, exact): deploy about 28M, enable 2 txs (small), demo 1.73M, smoke about 1M. Arbitrum Sepolia fee read-only on 2026-11-14: gas price 0.0203 gwei, base fee 0.02 gwei. At that price deploy + enable + demo + smoke is about 30M gas = about 0.0006 ETH for L2 execution; the Arbitrum L1 data component is billed inside the same gas figure and for ~25 KB of bytecode normally multiplies the total by a small factor, so budget under 0.005 ETH in all, far below 0.019 ETH. The config file's conservative 3 gwei estimate (0.083 ETH for the deploy alone) would NOT fit, but that is a ceiling, not the observed price: check step 3's dry-run, which prints the current price and the total, and stop if it shows more than about 0.015 ETH. USDC: demo deposits 6 USDC per side (`DEMO_DEPOSIT_USDC`, 12 total with two keys, 6 with one; withdrawn again at the end) plus 5 USDC for the smoke test, about 17 USDC at most, within 20, and nearly all of it returns to your wallet via withdrawals. Reported figures are estimates until you run them.

**Watching it.** UI: build the frontend with `node scripts/sync-deployment.mjs arbitrumSepolia` and the testnet env (`infra/testnet/env.testnet.example`); DEMO-USD shows a "DEMO - admin-set price" tag in the market list and a banner on the ticket. While step 8 runs, open the Status popover -> Backstop: inventory vs threshold, auction active, price and discount; the Activity tab shows `BackstopElevated`, `BackstopTaken`. Arbiscan: `https://sepolia.arbiscan.io/address/<exchange>#events` (topics BackstopElevated, BackstopTaken, Liquidated), and the transcript's per-tx links.

**Restoring afterwards.** The demo restores the demo price itself. Switching the feature off again is not scripted: call `setBackstopCfg(market, 0, 0, 0, 0, 0)` from the admin account (softNotional 0 means off).

## 17. Verification pass after deploy #2: TWAP redeploy, live keeper, liquidation and ADL (USER commands; written 2026-11-15)

Goal: turn "unverified" into "verified on testnet" for four things. Run from `contracts/` with `HH="npx hardhat --config hardhat.testnet.config.js"`. Nothing here has been run by an agent; the deploy dry-run (step 1) passed on 2026-11-15 (22 steps, nothing sent, about 0.001 ETH at 0.04 gwei).

| # | What | Command | Broadcasts? |
|---|---|---|---|
| 1 | Deploy #3 dry-run (TWAP gas guard) | `$HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia` | no |
| 2 | Move funds out of deploy #2 first | `CONFIRM_WITHDRAW=yes $HH run scripts/testnet/withdraw-available.js --network arbitrumSepolia` (deployer sub 0; bot funds and the email wallet are separate, withdraw those in the UI) | yes |
| 3 | Deploy #3 | `CONFIRM_TESTNET_DEPLOY=yes $HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia` | yes, ~22 txs |
| 4 | Smoke, then enable backstop | `CONFIRM_TESTNET_SMOKE=yes $HH run scripts/testnet/smoke-testnet.js ...` then `CONFIRM_ENABLE_BACKSTOP=yes $HH run scripts/testnet/enable-backstop.js ...` | yes |
| 5 | Point services at the new exchange | `node frontend/scripts/sync-deployment.mjs arbitrumSepolia`, then reset the indexer DB (`./run-indexer.sh reset`) and restart indexer, keeper and bot | no |
| 6 | Live keeper | create a NEW testnet-only key, fund about 0.01 ETH, then `export KEEPER_PRIVATE_KEY=0x...` in your shell and `KEEPER_LIVE=yes infra/testnet/run-keeper.sh start` (never the deployer key; gas budgets in `keeper.testnet.toml`) | yes (keeper txs) |
| 7 | TWAP check | place a small TWAP in the UI and watch slices execute; a slice that cannot be estimated should be counted as failed, not stall | yes |
| 8 | Liquidation on a real feed (BTC-USD) | open a tiny position at maximum leverage from a spare account, then wait for a real move larger than its margin buffer; the live keeper should liquidate it. The price cannot be forced, so this can take hours | yes |
| 9 | ADL | needs bad debt larger than the insurance fund. A real feed rarely produces that; use the DEMO-USD flow in section 16 (`demo-backstop.js`) to exercise the ADL path with an admin-set price, and record that it was NOT a real feed | yes |

What each step proves, and what it does not:
* 3 and 7 prove the TWAP fix on a public chain. 6 proves keeper liquidation, ADL and TWAP jobs send real transactions (they have only been simulated or run against local chains).
* 8 proves liquidation against a Chainlink price on a public chain. It does not prove behaviour in a large price gap or sequencer outage.
* 9 on DEMO-USD is a controlled test, not a real-feed test.
* Funding: run `poke-funding.js` with `CONFIRM_POKE_FUNDING=yes` twice, at least 3600 s apart, while a position is open (see the script header).
