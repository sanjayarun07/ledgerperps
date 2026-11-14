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

### Results (gas), Hardhat, current contracts (after backstop Phase 1, 2026-11-14)
Previous column = the previous round of this harness (after the first fixes). The new deltas come from the backstop sync that now runs inside `liquidate` and the extra storage reads on the fill path.
| Operation | Gas now | Previous | Delta | Notes |
|---|---:|---:|---:|---|
| Resting order, new price level | 303,708 | 303,466 | +0.08% | GTC sell into empty book |
| Resting order, existing price level | 234,860 | 234,618 | +0.10% | second order at same level |
| Cancel (single resting order) | 81,089 | 80,931 | +0.2% | `cancelOrder` |
| Single fill (taker opens first position) | 296,353 | 295,891 | +0.2% | IOC buy 0.1 vs one 1.0 BTC maker |
| Taker, N=1 fill | 285,831 | 285,369 | +0.2% | 1 maker order consumed |
| Taker, N=5 fills | 616,407 | 615,333 | +0.2% | ~123.3k gas/fill |
| Taker, N=10 fills | 888,679 | 886,725 | +0.2% | ~88.9k gas/fill |
| Taker, N=20 fills | 1,431,474 | 1,427,760 | +0.3% | ~71.6k gas/fill |
| Taker, N=40 fills | 2,520,574 | 2,513,340 | +0.3% | ~63.0k gas/fill; N=40 equals `MAX_TOUCHES_PER_TX` |
| Liquidate (partial, to backstop) | 226,178 | 219,207 | +3.2% | 1 BTC long, 6,000 collateral, mark moved to 45,500; includes the backstop sync |
| `pokeFunding` (one interval elapsed) | 105,049 | 105,027 | +0.02% | no positions, empty book |
| `syncBackstop()` no-op (backstop flat) | 43,247 | n/a | new | in-process node, live UI chain sample |
| `syncBackstop()` already synced (call right after a liquidation that synced) | 69,613 | n/a | new | single sample; the deficit itself was recorded inside `liquidate` (266,417 gas for that liquidation to an empty book) |
| `syncBackstop()` repays (refund insurance + repay debt) | 97,559 | n/a | new | one `BackstopSynced` event, single sample on the UI hardhat node |

Caveats: N-fill makers are 4 distinct accounts with several small orders each at one price level (32 open-order cap/account); all makers/takers are fresh accounts with no prior position
(first-position state writes are included, which is the expensive case). Liquidation measures one specific scenario; liquidations with many positions/orders, isolated margin, bad-debt/insurance paths and ADL were **not** benchmarked. Funding was measured without open interest. Cross-check: `contracts/test/exchange.test.js` and `fuzz.test.js` print comparable values (the 40-fill taker figure printed there is now ~2.5M) - consistent with this table where they overlap. Not benchmarked after the fixes: `writeOff`, the in-fill write-off path (flat negative account), the PriceBand cancel path.

## Nitro local (single samples, `infra/nitro-local/smoke.js`, 2026-11-14)
Local nitro-testnode (L2 chain id 412346), the contracts redeployed after backstop Phase 1 (fresh deploy, storage layout changed). Gas = receipt `gasUsed`; `gasUsedForL1` is 0 on this node (L1 price ~100 wei), so
**L2 gas == total gas here and this says nothing about real L1 data cost**. Previous = the Nitro run after the first fixes (`infra/nitro-local/smoke-last-run.previous2.json`). Single samples, state not identical between runs.
| Operation | Nitro now | Nitro previous | Delta | Hardhat now |
|---|---:|---:|---:|---:|
| Resting order, new level | 310,958 | 310,716 | +0.1% | 303,708 |
| Resting order, existing level | 242,110 | 241,868 | +0.1% | 234,860 |
| Cancel | 72,521 | 72,363 | +0.2% | 81,089 |
| Fill (taker opens first position, 0.1 BTC) | 308,865 | 308,403 | +0.1% | 296,353 |
| Second fill (0.9 BTC) | 228,374 | 227,912 | +0.2% | n/a |
| Liquidate (partial) | 198,633 | 189,310 | +4.9% | 226,178 |
| pokeFunding | 105,061 | 105,039 | +0.0% | 105,049 |
| deposit (new / existing / existing) | 156,739 / 122,539 / 122,527 | 134,361 / 100,161 / 100,149 | +16-22% | n/a |
| withdraw | 133,264 | 91,687 | +45% | n/a |
| `syncBackstop()` no-op (padded limit) | 43,247 | n/a | new | 43,247 |
The deposit and withdraw deltas are consistent with the contract changes (attributed from the change list, not profiled): the new `principal` mapping adds a storage write on deposit, and `withdraw` now runs the backstop sync and the withdrawal-gate check), not noise.
Gas limits in `smoke.js` are padded explicitly (`eth_estimateGas` under-estimates oracle refreshes on Nitro). On Nitro only the no-op `syncBackstop` was measured; the deficit and repay paths were measured on a Hardhat node only. N-fill takers, `writeOff`, ADL, TWAP and isolated margin were not measured on Nitro.

## Test-suite status at time of writing
2026-11-13 after the fixes: `npx hardhat test` **82 passing, 0 pending** (re-run 2026-11-14 after BACKSTOP-1 phase 1; Foundry 26 passing). Foundry: see `docs/GAPS.md` / README for the current count.

## Harness plan (not built, beyond gas-bench.js)
1. **Gas regression**: keep `gas-bench.js`; add to CI with a committed baseline and a tolerance (e.g. +3%); add cases: liquidation with N positions, isolated liquidate, ADL with 8 targets, TWAP slice, conditional trigger, signed order (ecrecover + nonce write), deepest-insertion (64-level walk), cancelAll(32).
2. **Target-chain gas**: partly done on a local nitro-testnode (above; L1 component ~0 there). Still to do: N-fill takers and the other scenarios, on a chain with realistic L1 pricing.
3. **Latency (p50/p95/p99)**: open-loop load generator (fixed arrival rate, not closed-loop) against RPC + indexer API on production-like hardware; record order submit -> receipt, receipt -> indexer visibility, -> WebSocket delivery; report HDR histograms, coordinated-omission-safe; at least 3 rates, 10 min each, with warmup; publish raw data.
4. **WebSocket fan-out**: N subscribers (1k, 10k, 50k) on book/trade channels; measure server-side send time, client-observed lag percentiles, dropped messages, memory; slow-consumer handling.
5. **Indexer throughput**: replay a recorded chain segment; measure events/s, DB write latency, catch-up time; reorg recovery.
6. **Keeper**: time-to-liquidate after an account becomes liquidatable under load; failure rate under RPC faults.
7. **Soak**: 24h mixed flow with bots (bots/ workstream), fault injection (RPC drop, oracle stall, keeper restart).
Report template: hardware, versions, commit hash, command line, raw output committed alongside every table.
