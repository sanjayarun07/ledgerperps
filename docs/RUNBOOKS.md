# Operational runbooks (DRAFT - never exercised)

None of these procedures has been rehearsed. Contract function names are from `contracts/src`; verify against the deployed ABI before acting.
Every on-chain action below should be signed by the appropriate role holder through a multisig; **no timelock or multisig is deployed by this repo**.
Placeholders in `<angle brackets>` are for the operator to fill. Dashboards referenced live in infra/grafana (metric names for keeper/indexer are assumptions).

Role cheat-sheet: GUARDIAN = `setGlobalPause(true)`, `setMarketState(m, ReduceOnly|OracleDegraded|Paused)`. ADMIN = everything incl. `setGlobalPause(false)`, `setMarketState(m, Normal|Recovery)`.
Note: `globalPaused` blocks trading, **liquidation and ADL** (but not withdrawals - verify), so a long pause lets bad debt grow. Per-market `Paused`/`OracleDegraded` block trading/liquidation and block withdrawals for accounts holding positions in that market.

## 0. Severity and comms
| Sev | Meaning | Response |
|---|---|---|
| S1 | funds at risk / solvency / key compromise | page on-call + guardian signers, pause (section 5) immediately, incident channel, status post within 30 min |
| S2 | trading degraded (oracle stale, keeper down, sequencer down) | follow specific runbook, status post within 60 min |
| S3 | cosmetic / single user | ticket |
Incident roles: commander, chain operator, comms lead, scribe. Keep a timestamped log. Never discuss unpatched vulnerabilities in public channels.
Template for status posts: *what we know / what users should do / what we are doing / next update at <time>*. Do not promise fund safety or timelines you cannot guarantee. Post-mortem within 5 working days, blameless, with on-chain tx hashes.

## 1. Oracle outage / stale or suspicious price
Detect: market state `OracleDegraded`, `OracleDegraded` reverts, Pyth/Chainlink age > `maxAge`, source disagreement from `MedianOracle`, alert on price jump vs reference.
1. Confirm cause: oracle publisher (Pyth push missing?), Chainlink heartbeat, sequencer downtime (section 3), our adapter.
2. If price is **wrong but fresh**: GUARDIAN `setMarketState(m, ReduceOnly)` or `Paused` at once; `setGlobalPause(true)` if multiple markets or if exploitation is ongoing.
3. If stale: the contract already degrades the market; do not "fix" by `setOracle` to an unreviewed oracle. A swap is an ADMIN action - treat as parameter change with review (section 8) except in S1 with two-person sign-off.
4. Push fresh updates (Pyth: someone must submit price update txs - [O]); re-check `markPrice`.
5. Recovery: ADMIN sets `Recovery`/`Normal` only after 2 consecutive fresh prices within tolerance of an independent reference. Verify open interest, funding (`pokeFunding` samples are skipped in outages; missed intervals apply at one averaged step - expect a funding discontinuity), and liquidations queue.
6. Post-incident: list accounts liquidated within +/- 10 min of the bad price; decide on compensation (governance, off-protocol).

## 2. Keeper down
Detect: `perps_keeper_*` metrics (ASSUMED names), no `Liquidated`/`FundingUpdated` events, head-lag alert, unhandled TWAP slices/conditionals.
1. Liquidation, `pokeFunding`, `executeConditional`, `executeTwapSlice`, `adl` are **permissionless**: any party can run a backup keeper. Start a standby keeper (infra/helm values `keeper.replicas`, or another region/host) or run `cast`/scripts manually.
2. Check keeper gas balance and signer key access (secret manager outage?). Rotate if compromised (section 7).
3. Watch accounts near MM in the indexer; if keeper cannot be restored within <target>, consider `ReduceOnly` on the riskiest markets.
4. After restore: process backlog in order of lowest margin ratio; funding catch-up occurs in one averaged step.

## 3. Sequencer down / delayed (Nitro)
Detect: no new L2 blocks, `perps_chain_head_block` flat, RPC errors. Parent-chain batch posting lag (batch poster balance).
1. Confirm via Nitro/status channels (UNVERIFIED: provider status page). If it is our own sequencer: restart per node runbook, check batch-poster ETH balance on parent chain.
2. No on-chain action is possible while the chain is halted. Prepare comms: positions cannot be closed; prices may gap on resume; oracles will be stale on resume -> markets enter `OracleDegraded` until fresh prices arrive (expected).
3. Forced inclusion through the parent-chain delayed inbox exists in Nitro but is **untested for this app**; rehearse on testnet before relying on it. Do not tell users they can force-withdraw.
4. On resume: do NOT unpause markets until oracle freshness is confirmed; expect liquidation bursts; keepers must be running before reopening.

## 4. Bad debt / ADL event
Detect: `BadDebtUnresolved` (emitted by liquidations, ordinary fills that leave a flat account negative, `settleDelisted` and the permissionless `writeOff(account, market)`), `adlDebt[m] > 0`, ledger monitor (`ledgerTotals` drift), insurance < threshold.
0a. **Backstop deficit (BACKSTOP-1 phase 1)**: the backstop's losses on inventory are recorded by `syncBackstop()` (permissionless). The keeper runs it every `sync_backstop_interval_secs` (default 60) and on each oracle update while the backstop holds inventory; manual: `cast send <exchange> "syncBackstop()"`. Check `backstopEquity()` (negative = unrecorded deficit), `bsInsDrawn()`, `bsDebt()`, `unresolvedBadDebt()`; the `BackstopSynced(equityBefore, fromInsurance, toDebt, market, refundedInsurance, repaidDebt)` event shows what was recorded or repaid. Sync records only; it moves no USDC.
0b. **`WithdrawGated()` reports from users**: while `unresolvedBadDebt > wdGateThreshold` (default 100 USDC), a withdrawal above the account's `principal` (deposited amount) reverts. This is expected, not a bug: tell users they can withdraw up to their principal, and that profits above it unlock once ADL / `recapitalize` clears the debt. Do NOT raise the threshold to make complaints go away while debt exists. To confirm: `unresolvedBadDebt()` vs `wdGateThreshold()`, `principal(acct)`. The frontend shows the same message and a bad-debt indicator in the footer.
0c. **Governance parameters** (both ADMIN; the guardian role may only LOWER either value, which for the gate means tighten and for the ADL premium means less ADL capacity): `setAdlHardPremBps(bps)` (default 10000 = 100% of the target's slack; applies only while backstop-originated debt is outstanding; recommended: leave at 10000 during an event so ADL can clear debt, 2500-5000 only in calm periods) and `setWithdrawGate(threshold)` (default 100e6; recommended: 0.1-0.5% of TVL, never above the insurance fund; setting it very high disables the limiter; 0 gates on any debt). Changes emit `AdlHardPremSet` / `WithdrawGateSet`, go through the timelock (section 8) and are indexed at `/v1/backstop/events`. These values are suggestions, not tested optimum.
0. A flat account that is still negative without a `BadDebtUnresolved` event can be recorded by anyone with `writeOff(acct, market)` (the keeper does this automatically; it reverts `nothing to write off` on healthy buckets).
1. Set the affected market `ReduceOnly` (GUARDIAN) to stop new risk.
2. Snapshot state: insurance, `unresolvedBadDebt`, `adlDebt[m]`, backstop inventory and PnL, top profitable counter-positions.
3. Publish the true ADL ranking (the chain cannot enumerate; keepers must supply an ordered list - `PerpAdl.adl(targets, market)`, max 8 targets per tx). Run `adl` with the ranked list. Archive the ranking for audit.
4. Capital options (governance decision): `recapitalize(market, amount)` from treasury; `fundInsurance`; `rebalanceBackstop` (ADMIN, moves insurance<->backstop; use carefully).
5. Backstop inventory: BACKSTOP_ROLE operator unwinds via `backstopPlace` within limits; log every action.
6. Resume `Normal` only when `adlDebt == 0`, insurance above target, and a post-mortem draft exists.
Physical solvency is **not guaranteed** by the contract; communicate losses accurately.

## 5. Pause / unpause
Pause: GUARDIAN `setGlobalPause(true)` (all markets) or `setMarketState(m, Paused|ReduceOnly)`. Prefer `ReduceOnly` unless exploit is active (pause blocks liquidation/ADL and withdraw-with-position on that market).
Steps: (1) signers confirm identity out-of-band; (2) send tx; (3) verify `globalPaused()` / state via two independent RPCs; (4) post status; (5) open incident.
Unpause: ADMIN only (`setGlobalPause(false)`, `setMarketState(m, Normal)`). Pre-conditions checklist: root cause understood, oracle fresh, keepers running, invariants (ledger identity) checked, second reviewer sign-off, comms ready. Reopen order: ReduceOnly -> Normal per market, highest-liquidity last.

## 6. Market listing / reduce-only / delisting
See docs/MARKET_LAUNCH.md. Summary: list = `createMarket` (ADMIN, immutable parameters mostly - there is no `updateMarket`); restrict = `setMarketState(m, ReduceOnly)`. **No delisting or final-settlement function exists** in the contract; closing a market currently means ReduceOnly + keeper/backstop unwinding + eventual manual process. Do not announce delisting dates until a settlement mechanism exists.

## 7. Key rotation
Keys: ADMIN (multisig signers), GUARDIAN, BACKSTOP operator, keeper signer, oracle admin (`ChainlinkAdapter.admin`, `ManualOracle.owner` - immutable!), deployer, batch poster/validator (Nitro), infra (cloud IAM, secret manager).
1. Planned rotation: `grantRole(new)` -> verify new key works on a harmless call -> `revokeRole(old)` (ADMIN). Never revoke the last admin first. `renounceRole` only after verifying a second admin exists.
2. Suspected compromise: S1. Pause first (GUARDIAN), then rotate. Assume attacker can front-run; use private mempool/sequencer endpoint if available. `ChainlinkAdapter.admin` and `ManualOracle.owner` are **immutable** - rotating means deploying a new adapter and calling `setOracle` (parameter-change flow).
3. Keeper key: fund new address, update secret (infra/terraform Secrets Manager entry; external-secrets syncs), restart pods, drain old address.
4. Agent keys (users): `revokeAgent` by owner; the UI should provide a one-click revoke-all.
5. Record every rotation (date, tx, approver).

## 8. Parameter change with timelock
Target process (the timelock itself is **not implemented in this repo**; until it is, treat every change as high-risk):
1. Proposal doc: parameter, old->new, rationale, simulation/backtest evidence, rollback plan.
2. Review: two reviewers incl. risk owner. Check bounds enforced by contract (`setFees` bounds; tiers ordering; `createMarket` checks).
3. Queue via TimelockController (delay <delay, UNDECIDED>); publish calldata hash and decoded call; notify users.
4. Guardian may cancel (requires CANCELLER role on the timelock - design decision).
5. Execute; verify post-state by reading values; update docs/indexer config.
Emergency changes that cannot wait for the timelock must be limited to restrictive actions (Guardian), by design.
