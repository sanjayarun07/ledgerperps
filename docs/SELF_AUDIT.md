# Self-audit (2026-11-16)

**This is NOT an independent audit.** It was done by the same party (an AI assistant) that helped write the code, in one session, and will have blind spots.
It reduces obvious bugs before a paid audit; it does not replace one. Nothing here makes the system mainnet-ready.

## Scope and method
- Contracts: `contracts/src/*.sol` and `src/oracles/*.sol` (about 2,000 lines).
- **Static analysis:** Slither (102 detectors) on the Foundry build: 150 raw results, triaged below.
- **Manual review** of: margin/risk math (`PerpBase._risk`, `_riskLiq`, `_isoRisk`, backstop sync), liquidation, withdraw/deposit/transfer, funding poke, TWAP, relayed EIP-712 orders and session keys, oracle adapters, market creation.
- **Not reviewed in depth:** `PerpTrading` matching loop and book insertion, `PerpAdl` candidate ordering, storage-layout equality across modules, gas-limit/DoS limits under adversarial books, the Rust keeper/indexer, the frontend.
- **Tools not run:** Echidna, Mythril, formal verification, an economic simulation.

## Findings

| ID | Severity | Status | Summary |
|---|---|---|---|
| SA-1 | Low | **Fixed in source** (not yet deployed; needs deploy #3) | `createMarket` skipped the bounds that `setMarketParams` enforces (`maxAge >= 5`, `bandBps <= 2000`, `maxSpreadBps <= 1000`, `fundingCap <= 5e9`). An admin typo could create an unusable market (for example `maxAge = 0` means the index is never fresh). A `bandBps > 10000` would underflow `_markFrom` (by reading only, not executed). Test: `contracts/test/selfaudit.test.js`. |
| SA-2 | Medium | **Mitigated in source** (not yet deployed; needs deploy #4) | **Funding premium sampled at caller-chosen times.** A premium sample used to stand for the whole gap until the next poke. Now one sample counts for at most `MAX_SAMPLE_HOLD` = 300 s; longer gaps are not extrapolated (they are not counted), so a poker who skews the book controls at most 300 s of premium per poke. **Operational requirement:** the keeper must poke funding every 60-120 s (`KEEPER_FUNDING_INTERVAL_SECS=120`), otherwise the funding rate rests on few samples. Residual: an attacker can still time a sample inside the window, at the cost of skewing the book. Test: `contracts/test/selfaudit.test.js` (fails without the cap).
| SA-3 | Medium | Open (design) | **Mark = book mid clamped to index ± band.** Liquidations use the mark, so a thin book can be pushed toward the band edge to trigger liquidations of others. Cost to the attacker is being filled at bad prices, and the spread check (`maxSpreadBps`) falls back to the index when the book is wide. Needs economic simulation on a real thin book before mainnet. |
| SA-4 | High (mainnet) | Open | **Centralisation.** Modules are replaceable by the admin until `lockModules()` is called (deploy #2 is unlocked). `ChainlinkAdapter.setFeed` and the adapter admin are an immutable EOA with no timelock or events: pointing a feed at a malicious aggregator controls every price. The admin and the guardian must be a timelock and a multisig, the module table locked, and the adapter's admin behind the timelock. |
| SA-5 | High (mainnet) | Open | **No L2 sequencer-uptime check.** After a sequencer outage prices can lag; `maxAge` only partly covers this. Chainlink's L2 sequencer uptime feed plus a grace period is the standard fix. |
| SA-6 | Medium (liveness) | Open (by design) | `withdraw` and `_risk` revert when any held market has no valid mark, so users with positions cannot withdraw during an oracle outage in a market they hold. Safety-first, but it is a liveness trade-off to document for users. |
| SA-7 | Medium (mainnet) | Open | **USDC dependency.** If Circle blacklists or pauses the exchange address, all collateral is frozen. Nothing in the contract can mitigate this. |
| SA-8 | Low | **Fixed in source** (not yet deployed; needs deploy #4) | `ChainlinkAdapter` now has optional per-feed min/max bounds (`setBounds`, wide ranges in `infra/testnet/testnet.config.json`, applied by `deploy-testnet.js`) so a feed pinned at a circuit-breaker value is rejected, rejects a stale round (`answeredInRound` set and behind `roundId`; 0 is accepted because the field is deprecated on some feeds, to be confirmed on the live feed after deploy), and emits `FeedSet`/`BoundsSet`. Bounds are unset (no check) until the admin sets them. Tests: `contracts/test/selfaudit.test.js`.
| SA-9 | Info | Open | `deposit(owner, sub, amount)` lets anyone credit any account (and register it). Harmless value-wise; allows dust-spam of account registry. |
| SA-10 | Info | Known | Already open in `docs/GAPS.md`: soft backstop cap, ADL candidate completeness, ADL rounding leak, withdrawal-run window while bad debt is uncleared. |

## Slither triage (150 raw results)

| Detector (count) | Verdict |
|---|---|
| `uninitialized-state` High (9) | False positive. State lives in `PerpBase` and is written by `PerpExchange`; modules run through `delegatecall` so Slither cannot see the writes. |
| `weak-prng` High (1) | False positive. `_fdiv` uses `%` for floor division, not randomness. |
| `divide-before-multiply` (15) | Reviewed in liquidation, ADL, funding and mark code. The orderings are deliberate (floor on amounts that favour the protocol); no unintended precision loss found. |
| `uninitialized-local` (14) | False positives: Solidity zero-initialises locals; they are accumulators. |
| `incorrect-equality` (11) | Benign: comparisons are on integer sizes and states (`== 0`), not balances. |
| `unused-return` (7) | `EnumerableSet.add/remove` returns are intentionally ignored; `tryRecover`'s error is handled through its `err` value. |
| `reentrancy-no-eth` in `executeTwapSlice` | Guarded by `nonReentrant`; the self-call to `placeFor` is restricted to `msg.sender == address(this)`. Threat model already asks an auditor to examine this. |
| `timestamp` (28), `calls-loop` (12) | Needed (staleness, funding intervals) / bounded by `MAX_MARKETS = 16`. |
| Informational and optimization (rest) | Not security-relevant. |

## What was checked and held
- Withdrawals are owner-only (agents cannot withdraw or transfer) and are blocked in paused/degraded markets for position holders.
- `placeSigned` and `cancelSigned`: per-owner nonces, EIP-712 domain with chainId and verifying contract, expired-deadline checks, agent scope enforced.
- `placeFor` is restricted to self-calls, so module entry points cannot be reached directly with forged accounts.
- Insurance/bad-debt bookkeeping moves value between buckets only (ledger identity unchanged), as the existing fuzz and invariant suites assert.

## Next steps (in order)
1. Deploy #4 with SA-1, SA-2, SA-8 and the TWAP fix (deploy #3 has SA-1 and the TWAP fix only), then re-run the suites, and confirm the live Chainlink feeds pass the stale-round check.
2. Run the keeper with `KEEPER_FUNDING_INTERVAL_SECS=120`.
3. For SA-4/SA-5, treat as mainnet blockers in `docs/PRODUCTION_READINESS.md`.
4. Commission the independent audits (see `docs/PRODUCTION_READINESS.md`).
