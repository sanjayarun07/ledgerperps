# Launch checklist: testnet to a hypothetical mainnet

STATUS TODAY: **NO-GO.** Nothing in this repository is audited, none of it has run against real market conditions, and several mechanisms the design itself calls necessary are not built. This list defines what would have to be true, who must sign it off, and what evidence proves it. It is an engineering checklist, not legal or financial advice.

Owners: **U** = user (project owner), **ENG** = engineering, **AUD** = external auditor, **OPS** = operations/on-call, **COUNSEL** = qualified legal counsel.
Every item needs: status (PASS / FAIL / N-A), date, owner initials, link to evidence. An item with no evidence is FAIL.

## 1. Contracts and audit

| # | Criterion | Owner | Pass criteria | Evidence | Today |
|---|---|---|---|---|---|
| 1.1 | Independent audit of router + 5 modules + oracle adapters (+ timelock config) | AUD | Report delivered, all Critical/High fixed and re-reviewed, Medium fixed or accepted in writing | Signed report, fix commit hashes | FAIL: none |
| 1.2 | Code freeze: deployed bytecode equals audited commit | ENG | Verified source on Arbiscan matches audited git tag; compiler settings identical (0.8.24, viaIR, 200 runs, cancun) | `verify-contracts.js` output, tag | FAIL |
| 1.3 | Size and gas limits | ENG | Every contract < 24,576 B with margin (PerpExchange is 22,425 B today) | build output | PASS (testnet build) |
| 1.4 | Test suites green incl. invariants/fuzz; Foundry suites actually run | ENG | CI log; BACKSTOP_DESIGN 8.3 lists `forge` as never run | CI links | FAIL |
| 1.5 | Bug bounty live before mainnet value | U/ENG | Program published, scope = deployed addresses | URL | FAIL |
| 1.6 | Module table lock decision | U/ENG/AUD | Locked only after audit and testnet soak, or documented decision to stay upgradable behind the timelock | lock tx or governance doc | FAIL |

## 2. Oracle

| # | Criterion | Owner | Pass criteria | Evidence |
|---|---|---|---|---|
| 2.1 | Mainnet Chainlink and Pyth addresses and feed ids verified | ENG | Addresses copied from official docs, each checked on-chain (code, decimals, description, freshness) by a script, reviewed by a second person | `verify-addresses.js` run against mainnet config |
| 2.2 | Sequencer-uptime handling | ENG/AUD | `ChainlinkAdapter` has no L2 sequencer check today; add or justify | code + test |
| 2.3 | Pyth pusher in production | ENG/OPS | Keeper (or separate) pusher with monitoring and funded wallet; age alert < 30 min; tested outage | metrics, drill 8.3 |
| 2.4 | Deviation/staleness parameters chosen from data | ENG | `medianMaxDevBps`, `medianMaxAgeSecs`, `maxConfBps` justified by 30+ days of observed feed divergence; testnet divergence is NOT evidence | analysis doc |
| 2.5 | Manipulation analysis | AUD | Thin-book mark, band, funding interplay reviewed | audit section |

## 3. Collateral and bridge

| # | Criterion | Owner | Pass criteria | Evidence |
|---|---|---|---|---|
| 3.1 | Collateral asset decision (native Arbitrum USDC vs bridged) | U/ENG | Exact mainnet token address from Circle docs, checked on-chain | decision doc |
| 3.2 | USDC risk review (issuer blacklist, pause, upgrade) and effect on the exchange ledger | ENG/AUD | Documented behaviour when the exchange address or a user is blacklisted | threat model update |
| 3.3 | Bridge / on-ramp UX and custody | U/COUNSEL | If any bridge is offered: provider, limits, failure handling, legal review | doc |
| 3.4 | Deposit caps | ENG | Per-account and global caps via `maxOI` and `maxOrderSize` set small for the first phase | config + chain state |

## 4. Liquidity and market makers

| # | Criterion | Owner | Pass criteria | Evidence |
|---|---|---|---|---|
| 4.1 | Real market makers contracted | U | At least 2 independent makers, written spread/size commitments per market | agreements |
| 4.2 | Maker fee/rebate economics tested | ENG | Simulated and testnet-observed net PnL for makers is non-negative under planned fees | report |
| 4.3 | Backstop sizing | ENG/AUD | Insurance + backstop capital funded and sized to stress moves (BACKSTOP_DESIGN) | on-chain balances |
| 4.4 | Own bots are not counted as liquidity | U | Disclosed in UX | screenshot |

## 5. Keepers and indexer operations

| # | Criterion | Owner | Pass criteria | Evidence |
|---|---|---|---|---|
| 5.1 | At least 2 independent keeper instances, separate keys/RPCs, funded | OPS | Failover drill: kill one, liquidations continue | drill log |
| 5.2 | Indexer is derived data only | ENG | Reconcile job compares indexer to chain `accountState`/`ledgerTotals` daily | job + report |
| 5.3 | RPC providers | OPS | 2+ providers, rate limits known, secrets in a secret manager | runbook |
| 5.4 | Backup/restore of indexer DB and keeper state | OPS | Restore drill passes | log |

## 6. Governance, timelock, guardian, pause, upgrade policy

| # | Criterion | Owner | Pass criteria | Evidence |
|---|---|---|---|---|
| 6.1 | Admin = TimelockController, delay >= 24 h (`transfer-admin.js`) | U/ENG | Deployer EOA holds no role; `hasRole` checks on Arbiscan | tx hashes |
| 6.2 | Proposers/executors = multisig (>= 3 of 5, hardware wallets) | U | Signers named, key ceremony documented | doc |
| 6.3 | Guardian | U | Separate address, pause-only (cannot unpause) | role check |
| 6.4 | Upgrade policy written | U/ENG | What can change (parameters via timelock), what cannot (locked modules), emergency path | doc |
| 6.5 | Rehearsal: schedule, wait, execute one parameter change on testnet through the timelock | ENG | Executed | tx hashes |

## 7. Monitoring and incident response

| # | Criterion | Owner | Pass criteria | Evidence |
|---|---|---|---|---|
| 7.1 | Alerts: oracle age, keeper lag, unresolvedBadDebt > 0, insurance below target, backstop inventory, funding anomalies, paused state | OPS | Each alert fired in a drill | alert log |
| 7.2 | On-call rota and escalation | OPS | Named people, 24/7 or explicitly limited hours disclosed | doc |
| 7.3 | Incident playbooks (docs/RUNBOOKS.md updated for mainnet) | OPS/ENG | Pause, reduce-only, delist, recapitalise, communicate | doc + drill |
| 7.4 | Post-mortem template and disclosure policy | U | Exists | doc |

## 8. Testnet exit criteria (all required)

| # | Criterion | Owner | Pass criteria |
|---|---|---|---|
| 8.1 | Stability | OPS | At least 14 consecutive days with the deployed set unchanged, keepers up > 99%, no unexplained revert class |
| 8.2 | Liquidation drills | ENG | Forced price moves (via a controlled test deployment, since real feeds cannot be moved) liquidate under- and over-collateralised accounts; bad-debt, insurance and ADL paths each executed and reconciled to `ledgerTotals` |
| 8.3 | Oracle failure drills | ENG/OPS | Stop the Pyth pusher: reads revert safely, funding does not corrupt, alert fires, recovery works; stale Chainlink; sources disagree; sequencer-down scenario reasoned or simulated |
| 8.4 | Withdrawal-run drill | ENG | With `unresolvedBadDebt > 0`, mass withdrawal attempt behaves as designed (withdraw gate) and the loss distribution is documented |
| 8.5 | Keeper failover and key rotation | OPS | Done |
| 8.6 | Admin handover and (if chosen) module lock rehearsed | ENG | Done on testnet |
| 8.7 | Smoke suite green on the final candidate | ENG | `smoke-last-run.json` with 0 failures, committed with the release record |
| 8.8 | External testers | U | Invite-only period with structured feedback, no critical defects open |

## 9. Legal, compliance, jurisdiction (REQUIRES COUNSEL)

No legal advice is given here. Items to put in front of qualified counsel: whether offering leveraged derivatives is permitted/licensable in each target jurisdiction; geographic restrictions and how they are enforced (frontend geoblocking is not a legal conclusion); sanctions screening; KYC/AML expectations; consumer-protection and marketing rules for leveraged products; entity structure, terms of service, privacy policy; tax reporting; treatment of the protocol operator vs. the contracts. Owner: COUNSEL with U. Pass = written opinion on file. Today: FAIL (not started).

## 10. Frontend, UX, disclosures

| # | Criterion | Owner | Pass criteria |
|---|---|---|---|
| 10.1 | No "demo/testnet" strings on mainnet and vice versa | ENG | Banner and chain checks per `infra/testnet/TESTNET_UI_PLAN.md`, tests for both |
| 10.2 | Risk disclosures (leverage, liquidation, ADL, bad-debt socialisation, oracle risk, unaudited or audited status stated truthfully) | U/COUNSEL | Approved copy shown before first trade |
| 10.3 | Error messages and oracle-stale states are understandable | ENG | UX review |
| 10.4 | Accessibility and wallet compatibility | ENG | Checked with 3+ wallets |
| 10.5 | Ownership of domains/keys for the frontend | U | Documented |

## 11. Explicit NO-GO items remaining today

1. **No audit** of any contract (1.1). Everything is an unaudited prototype.
2. **Real oracle path never verified under load**: adapters have only been exercised read-only against testnet feeds; Pyth is stale/unpushed by default and no pusher exists; mainnet feed addresses not verified; no L2 sequencer check (section 2).
3. **No bridge / collateral story** and no real USDC handling analysis (section 3).
4. **No real market makers**; all depth is simulated (section 4).
5. **Backstop Phase 2 not implemented** (soft cap, auction, forced unwind): backstop inventory size and duration are unbounded; gap risk beyond insurance + ADL capacity remains (docs/BACKSTOP_DESIGN.md).
6. **Withdrawal-run window** while `unresolvedBadDebt > 0` remains a documented gap.
7. No on-call, monitoring drills, legal opinion, or bug bounty.
8. Foundry suites and several verification paths listed as "not run" in BACKSTOP_DESIGN 8.3.

Go decision requires every item in sections 1-10 to be PASS with evidence, and an explicit signed decision by U. Items 11.1-11.8 must each be closed or formally accepted in writing by U with counsel/auditor input.
