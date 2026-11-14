# Benchmarks

Only **gas per operation** (in-process Hardhat EVM, plus single samples on a local Nitro testnode) has been measured. Everything else below is a plan.

## NOT measured (explicitly)
- **No p50 / p95 / p99 latency of any kind** (order-to-ack, order-to-fill, RPC, indexer, API) was measured.
- **No WebSocket fan-out** (messages/s, connections, subscriber lag) was measured.
- No throughput (orders/s), no real-network or reorg behaviour, no multi-node or load testing.
- Hardhat gas numbers come from the in-process simulator (evm cancun). A second set (single samples) was measured on a LOCAL Nitro testnode (see "Nitro local"); its L1 data-cost component is ~0 on that node, so real L1 posting cost on a public chain is **not measured**.
- Single runs from a clean snapshot, deterministic gas, so no variance statistics were computed.

## What was measured
Script: `infra/bench/gas-bench.js` (run: `make bench` or `cd contracts && npx hardhat run ../infra/bench/gas-bench.js`). Raw output: `infra/bench/last-run.json`.
Run date: 2026-11-13, re-run after the stress-campaign contract fixes (WASH-1 band check, ADL-1, FUND-1, LIQ-1/2, SETTLE-1, LEDGER-1, OI-1). The previous run is kept in `infra/bench/last-run.previous.json`.
Each scenario starts from an `evm_snapshot` of a fresh deployment (the same `deploy()` fixture the tests use: BTC market, 3 margin tiers, MockUSDC, ManualOracle),
accounts funded with 100,000 tUSDC. Gas is `receipt.gasUsed`.

### Environment
| Item | Value |
|---|---|
| Machine | Apple M3 Max, 16 logical CPUs, 64 GiB RAM (`sysctl machdep.cpu.brand_string hw.ncpu hw.memsize`) |
| OS | macOS 27.0.1 (build 26A434), Darwin 27.0.0 arm64 (`uname -a`) |
| Runtime | node v22.22.1, hardhat 2.22.17, solc 0.8.24 (optimizer 200 runs, viaIR, evm cancun) |
| Chain | Hardhat in-process network, `allowUnlimitedContractSize: false` |

### Results (gas), Hardhat, current contracts (after backstop Phase 2, 2026-11-14)
Previous column = the run after backstop Phase 1 (`infra/bench/last-run.previous3.json`). The deltas are not profiled; the fill-path increase is plausibly the Phase 2 storage read and `liquidate` the elevation check (attributed from the change list, not measured per line).
| Operation | Gas now | Previous | Delta | Notes |
|---|---:|---:|---:|---|
| Resting order, new price level | 303,840 | 303,708 | +0.04% | GTC sell into empty book |
| Resting order, existing price level | 234,992 | 234,860 | +0.06% | second order at same level |
| Cancel (single resting order) | 81,177 | 81,089 | +0.1% | `cancelOrder` |
| Single fill (taker opens first position) | 298,601 | 296,353 | +0.8% | IOC buy 0.1 vs one 1.0 BTC maker |
| Taker, N=1 fill | 288,079 | 285,831 | +0.8% | 1 maker order consumed |
| Taker, N=5 fills | 618,576 | 616,407 | +0.4% | ~123.7k gas/fill |
| Taker, N=10 fills | 891,312 | 888,679 | +0.3% | ~89.1k gas/fill |
| Taker, N=20 fills | 1,435,036 | 1,431,474 | +0.2% | ~71.8k gas/fill |
| Taker, N=40 fills | 2,525,992 | 2,520,574 | +0.2% | ~63.2k gas/fill; N=40 equals `MAX_TOUCHES_PER_TX` |
| Liquidate (partial, to backstop) | 233,003 | 226,178 | +3.0% | 1 BTC long, 6,000 collateral, mark moved to 45,500; includes the backstop sync and the elevation check (feature OFF) |
| `pokeFunding` (one interval elapsed) | 105,049 | 105,049 | 0.0% | no positions, empty book |
| `syncBackstop()` no-op (backstop flat) | 43,247 | n/a | Phase 1 | in-process node, live UI chain sample |
| `syncBackstop()` already synced | 69,613 | n/a | Phase 1 | single sample |
| `syncBackstop()` repays | 97,559 | n/a | Phase 1 | one `BackstopSynced` event, single sample |
| `setBackstopCfg` | 63,766 (first, cold) / 46,666 (re-set) / 46,606 (off) | n/a | new | UI hardhat node, 1 sample each |
| `setBackstopTakeFee` | 38,015 | n/a | new | UI hardhat node |
| `pokeBackstop` no-op (feature off or clock agrees) | 56,434 / 56,445 | n/a | new | UI hardhat node; `eth_estimateGas` 56,874 |
| `backstopAuction` (view, `estimateGas`) | 46,904 | n/a | new | UI hardhat node (no tx cost when called with `eth_call`) |
| `liquidate` with elevation start (partial 0.5 BTC to backstop, feature ON) | 236,905 / 237,732 | n/a | new | UI hardhat node, 2 samples; ~+4k over the OFF path |
| `takeBackstop` partial (0.2 of 0.5 BTC, still elevated) | 187,242 | n/a | new | UI hardhat node, 1 sample, 3 logs |
| `takeBackstop` full clear (0.5 BTC, relaxes the clock) | 241,606 | n/a | new | UI hardhat node, 1 sample, 4 logs |
| `unwindBackstop` (1 target) | 203,036 | n/a | new | UI hardhat node, 1 sample, 2 logs |

Caveats: N-fill makers are 4 distinct accounts with several small orders each at one price level (32 open-order cap/account); all makers/takers are fresh accounts with no prior position
(first-position state writes are included, which is the expensive case). Liquidation measures one specific scenario; liquidations with many positions/orders, isolated margin, bad-debt/insurance paths and ADL were **not** benchmarked. Funding was measured without open interest. Cross-check: `contracts/test/exchange.test.js` and `fuzz.test.js` print comparable values (the 40-fill taker figure printed there is now ~2.5M) - consistent with this table where they overlap. Not benchmarked after the fixes: `writeOff`, the in-fill write-off path (flat negative account), the PriceBand cancel path.

## Nitro local (single samples, `infra/nitro-local/smoke.js`, 2026-11-14, after backstop Phase 2)
Local nitro-testnode (L2 chain id 412346), contracts redeployed after backstop Phase 2 (fresh deploy, storage appended; exchange `0x21fA4fF19424fA1d1A4990134f04c5462A3BeF0b`). Gas = receipt `gasUsed`; `gasUsedForL1` is 0 on this node (L1 price ~100 wei), so
**L2 gas == total gas here and this says nothing about real L1 data cost**. Previous = the Nitro run after Phase 1 (`infra/nitro-local/smoke-last-run.previous3.json` holds the file that was on disk before this round). Single samples, state not identical between runs.
| Operation | Nitro now | Nitro previous | Delta | Hardhat now |
|---|---:|---:|---:|---:|
| Resting order, new level | 311,090 | 310,958 | +0.04% | 303,840 |
| Resting order, existing level | 242,242 | 242,110 | +0.05% | 234,992 |
| Cancel | 72,609 | 72,521 | +0.1% | 81,177 |
| Fill (taker opens first position, 0.1 BTC) | 311,113 | 308,865 | +0.7% | 298,601 |
| Second fill (0.9 BTC) | 230,622 | 228,374 | +1.0% | n/a |
| Liquidate (partial) | 205,458 | 198,633 | +3.4% | 233,003 |
| pokeFunding | 105,061 | 105,061 | 0.0% | 105,049 |
| deposit (new / existing / existing) | 156,805 / 122,605 / 122,593 | 156,739 / 122,539 / 122,527 | +0.04% | n/a |
| withdraw | 133,286 | 133,264 | +0.02% | n/a |
| `setBackstopCfg` | 63,766 | n/a | new | 63,766 (hardhat, first set) |
| `pokeBackstop` starts the clock | 77,917 | n/a | new | n/a |
| `pokeBackstop` no-op | 56,445 | n/a | new | 56,434 |
| `backstopAuction` view (`estimateGas`) | 57,066 | n/a | new | 46,904 |
| `takeBackstop` (partial 0.01 BTC) | 212,812 | n/a | new | 187,242 (0.2 BTC, hardhat) |
| `unwindBackstop` (1 target) | 131,935 | n/a | new | 203,036 |
| `setBackstopCfg` off | 46,606 | n/a | new | 46,606 |
Code sizes on the live chain, byte-for-byte equal to the artifacts (`code-size.js`): PerpExchange 22,697; PerpTrading 17,815; PerpExtras 19,034; PerpLiquidation 18,306; PerpTwap 10,701; PerpAdl 15,112 (limit 24,576; PerpExchange headroom 1,879 B). The 24,576-byte probe still deploys and 24,577 reverts.
The Phase 2 rows come from a block added to `smoke.js` that waits 62 s of real time (Nitro cannot time-travel) with dwell 0, ramp 60, maxAge 60. Different states and single samples make the differences between hardhat and Nitro in `unwindBackstop` (state-dependent: rank, 1 target, one position closed) and `setBackstopCfg` (first cold write) not meaningful.
Gas limits in `smoke.js` are padded explicitly (`eth_estimateGas` under-estimates oracle refreshes on Nitro). N-fill takers, `writeOff`, ADL, TWAP and isolated margin were not measured on Nitro.

## Test-suite status at time of writing
2026-11-14 after backstop Phase 2: `npx hardhat test` **94 passing, 0 failing**; `forge test` **26 passing, 0 failing**. Earlier: 82 passing on 2026-11-13 and after Phase 1.

## Harness plan (not built, beyond gas-bench.js)
1. **Gas regression**: keep `gas-bench.js`; add to CI with a committed baseline and a tolerance (e.g. +3%); add cases: liquidation with N positions, isolated liquidate, ADL with 8 targets, TWAP slice, conditional trigger, signed order (ecrecover + nonce write), deepest-insertion (64-level walk), cancelAll(32).
2. **Target-chain gas**: partly done on a local nitro-testnode (above; L1 component ~0 there). Still to do: N-fill takers and the other scenarios, on a chain with realistic L1 pricing.
3. **Latency (p50/p95/p99)**: open-loop load generator (fixed arrival rate, not closed-loop) against RPC + indexer API on production-like hardware; record order submit -> receipt, receipt -> indexer visibility, -> WebSocket delivery; report HDR histograms, coordinated-omission-safe; at least 3 rates, 10 min each, with warmup; publish raw data.
4. **WebSocket fan-out**: N subscribers (1k, 10k, 50k) on book/trade channels; measure server-side send time, client-observed lag percentiles, dropped messages, memory; slow-consumer handling.
5. **Indexer throughput**: replay a recorded chain segment; measure events/s, DB write latency, catch-up time; reorg recovery.
6. **Keeper**: time-to-liquidate after an account becomes liquidatable under load; failure rate under RPC faults.
7. **Soak**: 24h mixed flow with bots (bots/ workstream), fault injection (RPC drop, oracle stall, keeper restart).
Report template: hardware, versions, commit hash, command line, raw output committed alongside every table.
