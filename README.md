# Perps — on-chain perpetual futures exchange (prototype)

**Status: local prototype. UNAUDITED. Verified on a local Hardhat node (plus Foundry tests) and, as deploy/gas smoke only, a LOCAL Arbitrum Nitro testnode. Not run on any
public testnet. Not production-ready. Do not put real funds near it.**

Canonical state (order book, positions, margin, funding, liquidations) lives in Solidity contracts. Off-chain services
(keeper, indexer/API, frontend, bots) are derived infrastructure with no authority over balances.

## Layout
| Path | What | Notes |
|---|---|---|
| `contracts/` | Router `PerpExchange` + modules `PerpTrading`, `PerpExtras`, `PerpLiquidation`, `PerpTwap`, `PerpAdl` (shared storage in `PerpBase`, delegatecall), oracle adapters, mocks | all 6 deployed contracts < 24,576 bytes (PerpExchange 22,697; PerpExtras 19,034; PerpTrading 17,815; PerpLiquidation 18,306; PerpAdl 15,112; PerpTwap 10,701; RoutingOracle 739) |
| `contracts/test/` | Hardhat tests incl. `fuzz.test.js` (fast-check) | 94 passing, 0 pending |
| `contracts/foundry-test/` | Foundry unit, fuzz and invariant tests | 26 passing |
| `services/keeper/` | Rust keeper: funding, liquidation, conditional/TWAP triggers, ADL, permissionless `writeOff` sweep, `syncBackstop` | see its README |
| `services/indexer/` | Rust indexer + REST/WS API on PostgreSQL | OpenAPI in `docs/openapi.yaml` there |
| `frontend/` | Next.js trading UI ("Ledgerline") | guided flow, plain-language errors |
| `sdk/ts`, `sdk/python` | SDKs | Python lacks conditional/TWAP/isolated/ADL wrappers |
| `bots/` | Simulated-liquidity market makers + oracle driver | local only, labelled SIMULATED |
| `infra/` | docker-compose, Prometheus/Grafana, Nitro/Terraform/Helm templates, gas bench | templates unverified |
| `docs/` | SPEC, ARCHITECTURE, GAPS, THREAT_MODEL, RUNBOOKS, DEPENDENCIES, PRODUCTION_READINESS, MARKET_LAUNCH, BENCHMARKS | |

## What the contracts implement
Price-time-priority CLOB with bounded matching; GTC/IOC/FOK/PostOnly/reduce-only/market-as-IOC; cross **and isolated** margin;
tiered IM/MM; funding index with lazy settlement; permissionless liquidation to a backstop account; insurance fund;
**ADL** (keeper-ranked candidate list) and `recapitalize`; stop/TP/bracket conditional orders; **TWAP** (keeper-executed schedule);
EIP-712 / EIP-1271 relayed orders and **signed cancels**; trading-only agent keys with optional **market/notional scopes**;
market states incl. **delisting + final settlement**; bounded per-market parameter updates; OpenZeppelin `TimelockController` compiled in.
Units and formulas: `docs/SPEC.md`. Gaps and known weaknesses: `docs/GAPS.md`.

## Run
```bash
cd contracts && pnpm install
npx hardhat test                  # 94 passing (includes fuzz and stress suites, ~4 min)
forge test                        # 26 Foundry tests (needs Foundry)
npx hardhat node                  # terminal 1
npx hardhat run scripts/deploy.js --network localhost   # terminal 2 -> deployments/localhost.json (mock USDC + manual oracle)
npx hardhat run scripts/export-abi.js                    # merged ABI -> abi/PerpExchange.merged.json
```
Everything else has its own README (`services/keeper`, `services/indexer`, `frontend`, `sdk/*`, `bots`). `make up` (see `Makefile`,
`infra/`) starts chain + Postgres + Redis + Prometheus + Grafana in Docker and seeds accounts; the keeper/indexer/frontend/bots images
in `infra/docker` were **not** built or verified. There is no verified single command that starts the whole stack yet.

## Changes vs the original brief (recorded)
- Hardhat primary, Foundry added later for tests only.
- One contract was split into a router + 5 delegatecall modules to fit EIP-170. The selector table is admin-controlled until `lockModules()`; treat module registration as an upgrade power.
- Collateral is mock USDC and the oracle is `ManualOracle` locally. Chainlink/Pyth adapters are **unverified** and no addresses are listed.
