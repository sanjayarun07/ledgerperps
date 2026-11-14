# infra/nitro-local: Perps on a local Arbitrum Nitro testnode

Run date 2026-11-13 (redeployed and re-measured the same day after the stress-campaign contract fixes; see "Redeploy after the fixes" below), macOS arm64, Docker Desktop (7.65 GiB, 16 CPUs). LOCAL ONLY, UNAUDITED. Every number below was measured on one local run
(single samples, no variance statistics). A local testnode is not a public network: see "What this can and cannot show".

## Stack (started by the user, not by these scripts)
- `infra/nitro-local/nitro-testnode`: clone of `https://github.com/OffchainLabs/nitro-testnode`, default branch, commit `72ac4bb1f07fadc108448ad5fae01ea2e044fe69` (2026-09-22). Not edited.
- Started with `./test-node.bash --init-force --detach --no-l2-traffic` (simple mode: ONE nitro process = sequencer + batch poster + staker; L1 = geth `--dev --dev.period=1`, chain id 1337).
- L2: chain id 412346, RPC `http://127.0.0.1:8547`, ArbOS version reported by ArbSys 95 (raw value; chain config `InitialArbOSVersion` 40, so it was upgraded after genesis: not investigated). L1 RPC `http://127.0.0.1:8545`.
- Images (`docker images`): `offchainlabs/nitro-node:v3.11.3-beb2108` 4.88GB (id 903c51a67cb9, retagged `nitro-node-dev-testnode`), `ethereum/client-go:v1.16.4` 79.7MB,
  locally built `nitro-testnode-rollupcreator` 2.54GB (builds nitro-contracts v3.1.0, foundry 1.0.0 via foundryup) and `nitro-testnode-scripts` 994MB.
- Public dev key: hard-coded in `test-node.bash` (`devprivkey`), address `0x3f1eae7d46d88f08fc2f8ed27fcb2ab183eb2d0e`, funded on L1 and L2. Used ONLY in `contracts/hardhat.nitro.config.js`. Never use it elsewhere.
  The scripts also derive throwaway wallets from fixed labels (`keccak("nitro-local-throwaway:<label>")`): test only.
- I did not start/stop/re-init the node. Nothing in this directory runs `test-node.bash` or `docker compose`; scripts only use JSON-RPC and read `docker logs` / `docker exec cat /config/...`.

## Redeploy after the fixes (2026-11-13)
Contracts redeployed with the fixed bytecode (WASH-1, ADL-1, FUND-1, LIQ-1/2 + `writeOff`, SETTLE-1, LEDGER-1, OI-1) using `hardhat.nitro.config.js` and the unmodified `scripts/deploy.js`; the node was NOT restarted or re-initialised.
`deployments/nitroLocal.json` now holds the new addresses (exchange `0x4612dbA8fD5da6dc1561F10d6cB090eaB8ed1481`, usdc `0x2505...f54d`, oracle `0xB687...7447`); the old file is `nitroLocal.previous.json`, the old smoke output `smoke-last-run.previous.json`.
`code-size.js` on the live chain, byte-for-byte equal to the artifacts: **PerpExchange 19,864; PerpTrading 17,352; PerpExtras 18,276; PerpLiquidation 12,218; PerpTwap 10,246; PerpAdl 11,664** (limit 24,576; largest = PerpExchange, 4,712 B headroom; `replaceOrder`/`backstopPlace` moved from PerpTrading to PerpExtras). The max-code-size probe again: 24,576 deploys, 24,577 and larger revert.
`smoke.js` re-run (exit 0): same scenario, gas per op below. The sizes in section 1 and the gas table in section 2 are the PRE-fix measurements and are kept as the comparison baseline.

| Op | Nitro before fixes | Nitro after fixes | Delta |
|---|---:|---:|---:|
| Resting order, new level | 311,213 | 310,716 | -0.2% |
| Resting order, existing level | 242,317 | 241,868 | -0.2% |
| Cancel | 72,345 | 72,363 | +0.0% |
| Fill (first position, 0.1 BTC) | 304,815 | 308,403 | +1.2% |
| Second fill (0.9 BTC) | 224,363 | 227,912 | +1.6% |
| Liquidate (partial) | 186,236 | 189,310 | +1.7% |
| pokeFunding | 105,039 | 105,039 | 0.0% |
The extra oracle read per fill (price-band check) costs about 3.5k gas per fill on Nitro. Not re-run: `finality.js`, `delayed.js`, `svc-setup.js` and the keeper/indexer-against-Nitro scenario (section 5), so the new `writeOff` keeper sweep and the PriceBand decoding were NOT exercised on Nitro.

## Redeploy after backstop Phase 1 (2026-11-14)
Fresh deploy (the storage layout changed, so no upgrade in place) with `hardhat.nitro.config.js` and the unmodified `scripts/deploy.js`; JSON-RPC only, the node was NOT restarted or re-initialised.
`deployments/nitroLocal.json` now holds: exchange `0x6d660Ee236561d3dbF3dDF7503771DB0E58F5012`, usdc `0xD988fB60bF8d06F9C4Fc8832dbB9DB407e25d6A5`, oracle `0x0Cd7B5A682c29056e01074496CBFBE512cf7B60b`. The previous (round-1) file is `nitroLocal.previous2.json`; the older ones are `nitroLocal.previous.json` (first deploy kept earlier). Old smoke output: `smoke-last-run.previous2.json`.
`code-size.js` on the live chain, byte-for-byte equal to the artifacts: **PerpExchange 22,425; PerpTrading 17,573; PerpExtras 18,495; PerpLiquidation 13,835; PerpTwap 10,465; PerpAdl 13,557** (limit 24,576; largest = PerpExchange, 2,151 B headroom). The probe still shows a 24,576-byte contract deploys and 24,577 reverts.
`smoke.js` re-run (exit 0). Gas per op and deltas versus the previous Nitro run are in `docs/BENCHMARKS.md` ("Nitro local"): fills/rests/cancels +0.1 to +0.2%, liquidate +4.9% (backstop sync), deposit +22k and withdraw +41k (new `principal` write, sync and gate check), `syncBackstop()` no-op 43,247 gas.

## Files
| File | Purpose |
|---|---|
| `contracts/hardhat.nitro.config.js` | NEW config, network `nitroLocal` (`NITRO_L2_RPC` overrides the URL). `hardhat.config.js` untouched |
| `contracts/deployments/nitroLocal.json` | output of the unmodified `scripts/deploy.js` on Nitro |
| `code-size.js`, `chain-info.js`, `smoke.js`, `finality.js`, `delayed.js`, `svc-setup.js` | measurement scripts (below) |
| `smoke-last-run.json`, `finality-last-run.txt`, `svc/*.log` | raw outputs of this run |

All scripts: `cd contracts && npx hardhat --config hardhat.nitro.config.js run <script> --network nitroLocal`.

## 1. Deploy (task 2)
`npx hardhat --config hardhat.nitro.config.js run scripts/deploy.js --network nitroLocal` -> `deployments/nitroLocal.json` (pre-fix run: exchange `0xA6E41fFD769491a42A6e5Ce453259b93983a22EF`, usdc `0x11B5...de49`, oracle `0x1294...2574`). Took ~5.7 s wall including compile check. All txs succeeded.

Code size, PRE-fix (`code-size.js`, `eth_getCode` on the live chain, matches the artifacts byte for byte): PerpExchange 19,760; PerpTrading 24,047; PerpExtras 16,694; PerpLiquidation 11,318; PerpTwap 10,246; PerpAdl 11,183. **All 6 deployed.**
(The numbers in `infra/nitro/README.md` and `README.md` are stale: PerpTrading is 24,047 now, 529 bytes under the limit.)

Max code size, verified by probing, not assumed: `l2_chain_config.json` has no `MaxCodeSize`, so the default applies. Raw deployments of a contract returning N zero bytes: 24,576 B succeeded (gas 4,971,740);
24,577, 32,768, 49,152, 65,536 and 98,304 B all reverted. **Effective limit = 24,576 (EIP-170)** on this testnode. `MaxCodeSize` cannot be raised after chain creation per the Arbitrum docs, so PerpTrading's 529 B of headroom matters for a real chain.

## 2. Gas, block time, pricing (tasks 2, 3)
`chain-info.js`: L2 base fee / `eth_gasPrice` = 0.1 gwei (= minimum gas price 100,000,000 wei); gas speed limit 7,000,000/s; block gas limit field 1,125,899,906,842,624 (nominal); gas backlog 0.
L1 base fee estimate in ArbOS = **100 wei**, price per L1 data unit 1,600 wei. So `gasUsedForL1` is **0 in every receipt** (the poster cost is rounded away at 0.1 gwei L2 price).
**Consequence: this local node cannot show the L1 data cost component.** L2 gas == total gas here. The only L1-cost evidence I have is calldata size per tx (in `smoke-last-run.json`: 324 B for placeOrder, 36 B cancelOrder, 100 B deposit, 68 B liquidate/withdraw).
Real L1-component cost on a public chain: NOT measured.

Block time: Nitro produces a block per tx (or per ~250 ms batching window). Receipt latency after `sendTransaction` was 233-270 ms for ordinary txs (17 ms in some cases). Block timestamps have 1 s granularity.

### Gas per op vs `docs/BENCHMARKS.md` (hardhat, fresh-account scenarios)
Same logic; scenario state is similar but not identical (my accounts, 2 markets deployed, no `evm_snapshot` fixture). All txs `gasUsedForL1 = 0`.

| Op | Hardhat | Nitro (total = L2) | Delta |
|---|---:|---:|---:|
| Resting order, new level | 303,300 | 311,213 | +2.6% |
| Resting order, existing level | 234,404 | 242,317 | +3.4% |
| Cancel | 80,720 | 72,345 | -10.4% |
| Single fill (taker opens first position, 0.1 BTC, partial fill of a 1 BTC maker) | 291,275 | 304,815 | +4.6% |
| Liquidate (partial, to backstop) | 215,453 | 186,236 (smoke) / 230,634 (keeper run, different state) | -13.6% / +7.0% |
| pokeFunding (one interval, empty) | 104,900 | 105,039 | +0.1% |
| deposit (new acct) / deposit (existing) | n/a | 134,349 / 100,161 | |
| withdraw | n/a | 91,687 | |
| second fill (0.9 BTC) | n/a | 224,363 | |
Not measured on Nitro: N-fill takers (5/10/20/40), TWAP, conditionals, ADL, isolated. Differences come from ArbOS gas accounting/storage pricing; I did not decompose them.

### Findings from running on Nitro
1. **`eth_estimateGas` under-estimated `ManualOracle.set`**: a same-price refresh in the same second got estimate 26,942 gas and ran out of gas in the real block (the stored timestamp differs there, so SSTORE costs more). Any client/keeper/bot that relies on estimates for oracle refreshes should pad gas. `smoke.js` and `svc-setup.js` pass explicit `gasLimit`. (The tx in question: block 79; trace shows gasUsed == gas limit.) Cause is my inference from the numbers; not otherwise verified.
2. Cannot time-travel: funding interval/staleness tests need real waiting. `smoke.js` uses a second market with a 20 s funding interval and waits 22 s. pokeFunding with open interest on a 3600 s market was NOT measured.
3. The keeper's startup poke of funding costs 95,944 gas/market.

## 3. Timestamps and ManualOracle (task 2)
`ManualOracle.set` stores `block.timestamp`; `PerpBase` treats a price as unusable if `t > block.timestamp` or `block.timestamp - t > maxAge`.
Measured (`chain-info.js`, 20 self-sends with idle gaps): block timestamp minus wall clock at receipt was between -0.89 s and -0.03 s (L2 timestamps were never ahead of wall clock); timestamps were non-decreasing across all 20 blocks and equal for several consecutive blocks within a second. L2 ts <= L1 ts at the end of the run (L2 1794574099 vs L1 1794574106).
Implications (only the measured parts are verified):
- Same-chain oracle writes cannot trip the `t > block.timestamp` rule (verified implicitly: all refresh+trade sequences worked).
- Lag of up to ~1 s between wall clock and block time is irrelevant for `maxAge` 60 or 3600, but would matter for very small `maxAge` (>= 5 s allowed by `setMarketParams`).
- External feeds (Chainlink/Pyth publish times) can be later than an L2 block timestamp if the L2 block is old: untested here (adapters not deployed). After an idle period the latest block's timestamp is old; a view call/eth_call executed against the latest block would then see a staler `block.timestamp` than the next real tx will. I did not test this; treat as a risk for keepers' `eth_call` simulations.
- Block timestamps are sequencer-chosen within bounds (maxTimeVariation, below); a malicious/faulty sequencer can skew them within those bounds. Not tested.

## 4. Smoke scenario (task 3)
`smoke.js`: fresh deployment (own mock USDC/oracle/exchange, 2 markets), throwaway wallets alice/bob/keeper. Deposit; bob rests 2 sells (new + existing level) plus a third that is cancelled; alice IOC buys 0.1 BTC (partial fill of bob's order, 1 Fill event) then 0.9 (1 BTC long on 6,000 collateral); funding poke after a real 22 s wait; oracle to 45,500; keeper liquidates (Liquidated event: size 0.5 BTC, price 45,500, fee 113.75 USDC, bad debt 0); keeper withdraws 500 USDC (balance delta 500,000,000). Exit code 0. Raw rows in `smoke-last-run.json`.

## 5. Keeper and indexer against Nitro (task 4)
Their stock `tests/e2e.sh` scripts depend on hardhat-only RPCs (`evm_snapshot`/`evm_revert`, `evm_increaseTime`, `hardhat_setCode` for Multicall3) and spawn their own hardhat node, so they **cannot run unmodified against Nitro and I did not run them**. Instead I ran the existing debug binaries (no code changes) against the node
with `svc-setup.js` creating the scenario: keeper `--state-file infra/nitro-local/svc/keeper-state.json --metrics-addr 127.0.0.1:19300`, indexer DB `perps_nitro_local` (local PostgreSQL, created and left in place) on port 18090.
- Keeper: started fresh at block 0 (checkpoint-less), auto-detected NO Multicall3 on Nitro and used the parallel eth_call fallback (as designed); poked funding once per market (3 pokes, 95.9k gas each, mined in 0.07-0.3 s); after the oracle crash (block 220) it detected the underwater account and sent the liquidation, mined in block 221 (profitability check passed, 230,634 gas, ~$0.07 at its assumed native price of $3000 which is meaningless here); metrics: liquidations_sent 1, oracle_waits 0, reorgs 0; clean SIGTERM shutdown with checkpoint saved. Chain truth agrees: Liquidated event keeper == keeper address, position 1.0 -> 0.5 BTC.
- Indexer: caught up with lag 0 (`/readyz` ready); `/v1/liquidations`, `/v1/accounts/{acct}/positions` (size 50,000,000 = 0.5 BTC) and `/v1/markets/0/trades` match on-chain events/state. No warnings except the intentional `--wipe`. `/v1/status` reports `parent_chain_finality: unknown` ("does not read batch posting or finality data") and `canonical_execution` from `latest`: i.e. the indexer has **no notion of Nitro safe/finalized or batch posting**.
- Not exercised on Nitro: stale-oracle wait, dry-run/profitability skip, conditional/TWAP/ADL execution, reorg handling, indexer restart/re-index/hardening checks (all part of the stock e2e). No Nitro-specific failure was observed in what was run, but that is a small subset.

## 6. Finality stages (task 5) (`finality.js`, one sample, output in `finality-last-run.txt`)
Tx sent at t0 (self-transfer):
| Stage | Time after send |
|---|---|
| Submit acknowledged by sequencer RPC / receipt available (sequencer-accepted) | 15 ms / 17 ms |
| Batch containing the block posted to L1 (`BatchPoster: batch sent ... from=193 to=202`, docker log) | 20.7 s (batch poster `max-delay` is 30 s in sequencer_config) |
| L2 `safe` tag >= tx block | 21.9 s |
| L2 `finalized` tag >= tx block | 40.0 s |
Tags at the start: L2 latest 200 / safe 192 / finalized 150; at the end latest 202 / safe 201 / finalized 201. So on this node `safe` trails `latest` by seconds and `finalized` by dozens of blocks while idle; both are far behind `latest` for fresh txs. Parent chain (geth --dev) tags at the end were all equal (704).
Caveats: single sample; batch timing depends on poster scheduling (not constant); L1 here is a 1 s-block dev chain with no real finality or reorgs; the `finalized` delay reflects this setup, not mainnet/Sepolia (where finalization is minutes). Rollup assertion confirmation (the ~challenge-period withdrawal delay) was NOT measured; the node log shows the staker waiting for more batches.

## 7. Delayed inbox / forced inclusion (task 5) (`delayed.js`)
- `SequencerInbox.maxTimeVariation` read from L1: delayBlocks 5760, futureBlocks 12, delaySeconds 86400, futureSeconds 3600. Forced inclusion (`SequencerInbox.forceInclusion`) is only possible after that delay (~1 day) if the sequencer ignores a delayed message.
- Tested: L1 `Inbox.depositEth` from a throwaway L1 wallet; L2 balance appeared 4.2 s after submission (the node's own delayed-sequencer sequenced it; logs show `DelayedSequencer: Sequenced`).
- Tried: `Inbox.sendUnsignedTransaction` calling `pokeFunding(1)` on the exchange. The L1 tx mined, but after 120 s neither the sender nor its L1->L2 alias had an L2 nonce > 0, so inclusion/execution of this tx is **not demonstrated** (cause not investigated; possibly sequenced but invalid, e.g. nonce/alias handling).
- NOT tested: `forceInclusion` itself (would need the sequencer stopped/censoring and the 86,400 s delay or a changed config), what happens to an exchange user's order via the delayed path under a censoring sequencer, and any ordering guarantees. Documented as untested.

## What the local node can and cannot demonstrate
Can: the contracts deploy and run under Nitro's 24,576-byte limit; ArbOS gas accounting for the exchange ops (within about -14%..+5% of hardhat for the ops measured); sequencer receipt latency; timestamp monotonicity; keeper/indexer wire compatibility (eth_getLogs, calls, raw txs); the three tag levels move at different speeds; a delayed deposit gets sequenced.
Cannot: L1 data cost (L1 price ~0 here), real L1 reorg/finality behaviour, mainnet-like batch cadence or sequencer faults/censorship, throughput or latency under load (single user, one node, no feed consumers), BoLD challenges/withdrawals, real oracles, `forceInclusion`. Single sequencer: the sequencer trust assumptions in `docs/THREAT_MODEL.md` are untouched by this run.

## Reproduce
1. User starts the node: `cd infra/nitro-local/nitro-testnode && ./test-node.bash --init-force --detach --no-l2-traffic` (builds rollupcreator/scripts images; needs internet).
2. `cd contracts && npx hardhat --config hardhat.nitro.config.js run scripts/deploy.js --network nitroLocal`, then each script above.
3. Keeper/indexer: see section 5 (`createdb perps_nitro_local`; `SVC_PHASE=fund|trade|crash|truth`).
Teardown is the user's: `cd infra/nitro-local/nitro-testnode && docker compose down` (images stay). The node was left RUNNING by me.

## Redeploy after backstop Phase 2 (2026-11-14)
Fresh deploy (storage appended, so no upgrade in place) with `hardhat.nitro.config.js` and the unmodified `scripts/deploy.js`; JSON-RPC only, the node was NOT restarted or re-initialised.
`deployments/nitroLocal.json` now holds: exchange `0x21fA4fF19424fA1d1A4990134f04c5462A3BeF0b`, usdc `0xCACd7Ed912C4c02B6A0a3F5600993F9f66d5dF1D`, oracle `0xDdb3705371A90953e232dfa643F7194E56019eA2`. The Phase 1 file is `nitroLocal.previous3.json`, the old smoke output `smoke-last-run.previous3.json` (the older backups are unchanged).
`code-size.js` on the live chain, byte-for-byte equal to the artifacts: **PerpExchange 22,697; PerpTrading 17,815; PerpExtras 19,034; PerpLiquidation 18,306; PerpTwap 10,701; PerpAdl 15,112** (limit 24,576; PerpExchange headroom 1,879 B). The probe: 24,576 deploys, 24,577 and larger revert.
`smoke.js` now has a backstop Phase 2 block (setBackstopCfg, pokeBackstop twice, backstopAuction view, a 62 s real-time wait, takeBackstop, unwindBackstop, cfg off; exit 0). Gas per op and deltas versus the previous Nitro run are in `docs/BENCHMARKS.md` ("Nitro local"): fills +0.7 to +1.0%, rests/cancels +0.04 to +0.1%, liquidate +3.4%, pokeFunding unchanged; `pokeBackstop` no-op 56,445, `takeBackstop` partial 212,812, `unwindBackstop` (1 target) 131,935.
