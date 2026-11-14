# Production readiness checklist

## Status, bluntly
**This system is NOT production-ready. Nothing in this repository has been audited** - not the contracts, not the services, not the infra templates, not this document.
It is an unaudited prototype tested only on a local in-process EVM. It uses a mock USDC and a manually set oracle locally; the real oracle adapters have never run against a real feed.
Do not deposit real funds. Do not describe this as "secure", "audited", "safe" or "decentralized" in any material.

Legend: [ ] not done. (Nothing below is checked, because nothing has been done to a production standard.)

## 1. Smart-contract assurance
- [ ] Independent audit #1 and #2 by firms experienced with perp DEX/clearinghouse logic, with fix-review round. Scope: all of `contracts/src`, delegatecall module router, storage-layout safety, EIP-712/1271 paths, ADL, funding, oracle adapters.
- [ ] All High/Medium findings fixed and re-reviewed; public report.
- [ ] Known open issues resolved or accepted in writing: GAPS.md items (tier cliffs, griefable OI cap, backstop trust, funding catch-up averaging, stale lazy order removal, guardian pause blocks liquidation/ADL).
- [ ] Formal verification / symbolic targets (suggested, none attempted): (a) ledger identity `sum(collateral)+insurance+fees+funding-badDebt = deposits-withdrawals`; (b) no path lets an agent key reduce owner collateral or call withdraw; (c) matching bounds always terminate within MAX_TOUCHES/LEVELS; (d) funding index conservation (payer total == receiver total + pool residual); (e) liquidation never increases account risk-adjusted deficit; (f) module delegatecall cannot alter another module's reserved slots (layout check); (g) role invariants (guardian cannot return a market to Normal).
- [ ] Differential/property testing at scale (invariant testing with Foundry or equivalent; currently 2 hardhat fuzz tests exist and were **failing** at last run, 2026-11-13).
- [ ] Economic simulation: liquidation cascades, oracle gaps, ADL under stress, insurance sizing, funding extremes.
- [ ] Testnet soak with adversarial users (incentivised), >= several weeks.
- [ ] EIP-1271 path tested (currently untested, per GAPS.md).
- [ ] Gas/limits verified on the actual target chain (block gas limit, calldata cost): see BENCHMARKS.md (only in-process measurements exist).

## 2. Governance and key management
- [ ] Timelock contract deployed and wired (none exists); admin = multisig behind timelock; delay chosen and justified.
- [ ] Multisig signer set, hardware wallets, geographic spread, signer-rotation procedure rehearsed (RUNBOOKS 7).
- [ ] Guardian role limited, monitored, with its own key and alerting; guardian pause semantics reviewed (blocks liquidations).
- [ ] `lockModules()` called at launch; module addresses verified on explorer; no upgrade path exists - decide on migration plan.
- [ ] Oracle adapter admin/owner immutables reviewed (ManualOracle must not exist in production).
- [ ] Keeper/relayer keys in KMS/HSM, least-privilege, separate from deployer.

## 3. Oracles and collateral
- [ ] Real feeds verified per docs/DEPENDENCIES.md (none verified now); staleness, confidence, deviation and circuit-breaker policy defined per market.
- [ ] Oracle failure drills (RUNBOOKS 1) executed on testnet.
- [ ] USDC issuer risk accepted (blacklist/pause), depeg policy, bridge limits.

## 4. Chain / infrastructure
- [ ] Nitro chain deployed on testnet using infra/nitro templates (never run); parameters decided and recorded; max code size decided (immutable).
- [ ] Sequencer HA, batch-poster/validator funding alerts, parent-chain RPC redundancy, forced-inclusion path tested.
- [ ] Terraform/Helm applied in a non-prod account (only `tofu validate` and `helm lint/template` ran); network policies tested on a real CNI; secrets via external-secrets verified; backups & restore tested for Postgres.
- [ ] Service images scanned, signed, pinned by digest; SBOM.
- [ ] Capacity plan based on measured throughput (none measured, see BENCHMARKS.md).

## 5. Monitoring and operations
- [ ] Alerts: oracle age, keeper lag, indexer lag, insurance level, unresolved bad debt, ledger drift, role changes, pause events, large withdrawals, sequencer stall, batch-poster balance. (Only a local Grafana dashboard with assumed metric names exists.)
- [ ] On-call rota, severity process, status page, comms templates (RUNBOOKS 0).
- [ ] Runbooks rehearsed as game days.
- [ ] Independent monitoring watching the chain from outside our infra.

## 6. Security program
- [ ] Bug bounty live before mainnet (scope, severity table, payout capacity, safe-harbor language reviewed by counsel).
- [ ] Incident response retainer; disclosure policy; security.txt.
- [ ] Frontend: CSP/SRI, dependency pinning, release signing, domain/DNS hardening, wallet-signature display review.
- [ ] Penetration test of API/WebSocket and infra.

## 7. Performance
- [ ] Load tests with realistic order flow; latency percentiles (p50/p95/p99) and WebSocket fan-out measured **on production-like hardware** - not measured at all so far.
- [ ] Reorg/replay/indexer-recovery tests; indexer determinism vs chain.

## 8. Upgrade path
- [ ] Decide: immutable + migrate (current design: non-upgradeable core, locked module table) vs proxy. Document user migration mechanics, settlement of old market, and communication plan. None exists.

## 9. Regulatory note (not legal advice)
Offering leveraged derivatives trading to the public is regulated in most jurisdictions (derivatives, securities, commodities, AML/KYC, sanctions, consumer-protection regimes). Operating the frontend, relayer or keepers, taking fees, or listing markets may create obligations for the operators even if contracts are "permissionless".
Obtain qualified legal advice per target jurisdiction before any public launch; consider geo-restrictions and terms of service. This repo contains no compliance functionality (no KYC, sanctions screening, or geofencing).
