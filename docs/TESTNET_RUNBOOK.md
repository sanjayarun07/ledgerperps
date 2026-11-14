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
node --test scripts/testnet/tests/lib.test.js                                  # 14 guard/config tests (agent)
SMOKE_NO_MAIN=1 $HH run scripts/testnet/tests/local-e2e.js                     # smoke logic on in-process chain (agent)
LOCAL_SIMULATE=1 $HH run scripts/testnet/deploy-testnet.js                     # deploy plan on in-process chain (agent)
```
Expected: 14 pass; "14 ok / 0 failed" for markets 0,1,2; a 19-step table ending `Local sanity: 31 selectors routed correctly; modulesLocked=false; marketCount=3`.
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

### TODO (feature, not implemented): `keeper pyth pusher`
The keeper (`services/keeper`) has no Pyth pusher. Needed interface:
* config: `pyth_address`, `hermes_url` (+ optional auth header env), `pyth_feed_ids[]` (the market feed ids), `pyth_push_interval_secs` (<= 60), `pyth_max_fee_wei`.
* loop: fetch `/v2/updates/price/latest?ids[]=...&encoding=hex`, `getUpdateFee(bytes[])`, simulate `updatePriceFeeds` (eth_call), send with `value=fee`, only if on-chain `publishTime` older than `pyth_min_age_secs` or deviation > threshold (saves gas).
* also push immediately before liquidation/pokeFunding actions when the age exceeds `medianMaxAgeSecs/2`.
* metrics: `keeper_pyth_age_seconds{feed}`, `keeper_pyth_push_total{result}`, `keeper_pyth_fee_wei_total`; alert if age > 1800 s.
* uses `KEEPER_PRIVATE_KEY` (must hold ETH); must respect `dry_run`.
Until it exists, `push-pyth.js` (manual) or `SMOKE_PUSH_PYTH=yes` is the only way to keep the oracle alive.

## 7. Deployment dry-run (agent with key-less read-only, or user)

```bash
$HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia
```
Prints: mode `DRY-RUN`, deployer, the ordered plan (ChainlinkAdapter + 3 `setFeed`, PythAdapter, MedianOracle, PerpExchange, 5 modules each followed by `registerModule`, 3 `createMarket`), predicted addresses, bytecode sizes (largest: PerpExchange 22,425 B < 24,576), gas estimates for steps that do not depend on undeployed contracts (calls show `estimate n/a`). Observed: about 23.5M gas for the deploys; reference gas from the in-process run for the dependent calls: setFeed 44k, registerModule 99k-348k, createMarket 288k each.
Optional env: `GUARDIAN_ADDRESS=0x..`, `USE_MOCK_USDC=yes` (deploys MockUSDC faucet token instead of using Circle USDC; useful if you cannot get faucet USDC).
**Differences from `scripts/deploy.js` (local):** oracle = MedianOracle(Chainlink, Pyth) instead of ManualOracle; collateral = Circle test USDC instead of MockUSDC; `maxOrderSize`/`maxOI` cut about 10,000x (BTC 1 / 10, ETH 20 / 200, SOL 400 / 4000 units) to bound testnet exposure; tick, lot, minNotional, band, spread, funding, margin tiers identical; admin is the deployer EOA (as locally) and the module table is NOT locked.

## 8. Deploy (USER ONLY: broadcasts transactions)

Preconditions: steps 4-7 clean, `chmod 600 .env`, key in `.env`, `verifiedOnChain` fresh, Pyth decision (step 6) made.

```bash
CONFIRM_TESTNET_DEPLOY=yes $HH run scripts/testnet/deploy-testnet.js --network arbitrumSepolia
```
Expected: `MODE: BROADCAST`, 20 transactions (21 with GUARDIAN_ADDRESS) with block numbers, `Wrote contracts/deployments/arbitrumSepolia.json`. The script refuses to overwrite an existing deployment file. **Rollback:** there is none on-chain; testnet contracts are abandoned and redeployed (move the JSON aside first). If it fails midway, nothing is recorded in the JSON; note the addresses from the console and redeploy from scratch.
Why the module table stays unlocked: `lockModules()` is irreversible. During smoke tests you may discover a module bug; with the table unlocked you can deploy a fixed module and `registerModule` it, with it locked you must redeploy everything. Lock after tests pass (step 13).
Why ADMIN stays the deployer EOA: the smoke/rehearsal steps need admin calls. Hand over in step 14.

## 9. Check on Arbiscan (user)

Open `https://sepolia.arbiscan.io/address/<exchange>`: contract created by `0x50C0...6B29`; 20 txs from the deployer in sequence; in Read Contract: `modulesLocked=false`, `marketCount=3`, `oracle` = the MedianOracle address, `usdc` = `0x75fa...AA4d`, `hasRole(DEFAULT_ADMIN_ROLE, deployer)=true`. The JSON also has every tx hash.

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
* Pyth freshness depends on a manual push until the keeper pusher exists.
* Any market without a Chainlink+Pyth feed would be `manual-oracle-only (testnet demo)` (excluded from the deployment unless run locally). All three current markets have both feeds on-chain.
* The keeper in the compose file is dry-run: liquidations are logged, not sent.

## What the testnet test does NOT prove

Contract security or solvency under adversarial conditions (no audit); behaviour under mainnet price volatility or liquidity; economic soundness of the funding/margin parameters; oracle reliability (testnet Chainlink feeds are noisy/low-activity and Pyth is not pushed by default); real USDC behaviour (blacklisting, upgrades); Arbitrum sequencer outage handling (no sequencer-uptime check exists in `ChainlinkAdapter`); load, MEV, or keeper competition; the withdrawal-run window while bad debt exists; backstop phase 2 (not implemented); legal or compliance fitness.

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
