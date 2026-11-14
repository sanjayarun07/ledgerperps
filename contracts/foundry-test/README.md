# Foundry tests

Foundry project config: `../foundry.toml` (src=`src`, test=`foundry-test`, solc 0.8.24, via_ir, optimizer, cancun,
`code_size_limit = 24576` enforced, OpenZeppelin remapped to `node_modules/@openzeppelin/contracts`).
Build output goes to `out-forge/` and `cache-forge/` so it does not collide with Hardhat's `artifacts/` and `cache/`.
`forge-std` lives in `lib/forge-std` (installed with `forge install foundry-rs/forge-std --no-git`).
Contracts under `src/` are NOT modified.

## Run
```bash
forge build                                   # compile (lint warnings come from src/, not from the tests)
forge test                                    # everything: 256 fuzz runs, 128 invariant runs x depth 250
forge test --match-contract Unit              # ported unit scenarios
forge test --match-contract FuzzTest          # stateless fuzz properties
forge test --match-contract InvariantTest -vv # stateful invariants (+ per-action coverage log in afterInvariant)
FOUNDRY_PROFILE=ci forge test                 # heavier: 2000 fuzz runs, 256 invariant runs x depth 200
forge test --match-test testFuzz_ --fuzz-runs 10000
```

## Layout
| file | purpose |
|---|---|
| `Deployer.sol` | test base: deploys MockUSDC, ManualOracle, router + 5 modules, registers selectors, `lockModules()`, creates the BTC market (same config as `test/helpers.js`). Selectors come from forge's `methodIdentifiers` in `out-forge/<C>.sol/<C>.json` minus selectors the router defines itself (same rule as `deployExchange` in helpers.js). Contracts are created with `deployCode` so the test bytecode stays under the 24 KB limit. |
| `UnitMatching.t.sol` | partial fill, FIFO/price priority, FOK atomicity, limit price, reduce-only, withdrawal margin check |
| `UnitRisk.t.sol` | liquidation to backstop, isolated-margin loss cap, ADL restoring solvency, recapitalize |
| `Fuzz.t.sol`, `MathHarness.sol` | `testFuzz_` fill/limit bounds, weighted entry + reversal, funding-owed rounding (`owed == ceil(size*dIdx/1e14)`, never favours user), floor-div, notional/fee rounding, withdrawable <= equity-IM-reserved |
| `InvariantHandler.sol`, `Invariant.t.sol` | `StdInvariant` suite, 4 actors; place/take/cancel/replace, oracle moves, time warps (some leave the oracle stale), pokeFunding, deposit/withdraw, liquidate, adl, recapitalize |

## Invariants asserted
net position incl. BACKSTOP == 0; book not crossed, levels strictly sorted, prev links consistent; `level.total` == sum of order sizes,
orders in book == orders in per-account sets; `reserved[a]` == sum of open-order reserves; OI == sum of positive sizes;
USDC balance == totalDeposited - totalWithdrawn; no `Panic(uint256)` reverts.

Panic tracking: the handler never lets protocol reverts escape. `_call` low-level-calls the exchange and counts any revert whose
selector is `0x4e487b71` (`panicCount`, `lastPanicCode`, `lastPanicWhere`), so `fail_on_revert = false` cannot hide them;
`invariant_noPanicReverts` fails if the count is non-zero. Other revert selectors are tallied (`revertsBySelector`) and printed with `-vv`.

## Known limits
- ADL only succeeds rarely inside the invariant run (needs bad debt + a profitable opposite-side target); it is covered by `UnitRisk`.
- Isolated margin, conditionals, TWAP and signed orders are not driven by the handler.
- The ledger identity (`ledgerTotals`) is not an invariant: it only holds when all accounts are funding-settled.


## Note (2026-11-13)
`Stress.t.sol` pins `invariant.runs = 256` and `invariant.depth = 250` with inline `forge-config` comments, which take precedence over the
`FOUNDRY_INVARIANT_RUNS` / `FOUNDRY_INVARIANT_DEPTH` environment variables mentioned above; edit the comments to run the stress suite deeper.
BACKSTOP-1 phase 1: `checkProtocolBuffers` evaluates "backstop collateral >= 0, backstop equity >= 0, second sync is a no-op" on a snapshot after a hypothetical
`syncBackstop()`; `syncBackstop`, `deposit`, `withdraw`, `rebalance` handler actions live in `StressAdl` (StressKeeper was at the 24,576 B limit).
