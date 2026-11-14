# Market launch checklist and governance workflows (DRAFT)

UNAUDITED prototype. This describes the intended process and what the **current contracts actually support**. Several steps (timelock, delisting settlement) have no implementation yet.

## What the contracts support today (from `PerpExchange.sol`)
- `createMarket(MarketConfig, Tier[])` - ADMIN only, up to `MAX_MARKETS=16`; params: feed, tick, lot, minNotional, maxOrderSize, maxOI, maxAge, bandBps, maxSpreadBps, fundingInterval, premiumDivisor, fundingCap + up to 4 margin tiers (last tier unbounded). **There is no function to update most of these after creation.** Tier/market parameters are effectively immutable; changing them means a new market.
- `setMarketState(m, Normal|ReduceOnly|OracleDegraded|Paused|Recovery)` - ADMIN any; GUARDIAN only restricting states.
- `setFees` (global, bounded), `setAdlMaxPremBps`, `setOracle` (global, instant), `rebalanceBackstop`.
- **Missing:** delist/close market, final settlement price, per-market fee overrides, parameter update, timelock.

## A. New market launch checklist
1. **Eligibility**: liquid underlying with >=2 independent price sources; reference venues & depth documented; manipulation cost analysis (can the index be moved cheaply?).
2. **Oracle**: feed ID for each source obtained from official source and recorded (see DEPENDENCIES.md - none verified now); freshness `maxAge` chosen against publish cadence; `MedianOracle` deviation bound; staleness/outage behaviour tested on testnet.
3. **Risk parameters** (written rationale + simulation): tick, lot, minNotional; `maxOrderSize`, `maxOI` (sized against insurance + backstop capacity); tiers (IM/MM, mind whole-position tier cliffs); `bandBps`, `maxSpreadBps`; funding interval/divisor/cap; liquidation fee, close factor are global.
4. **Capacity**: matching bounds (16 levels, 40 touches) vs expected book depth; measured gas in docs/BENCHMARKS.md.
5. **Testnet rehearsal**: create the market with the exact final config, run keeper + bots, force oracle outage, force liquidation, bad debt and ADL, then pause/unpause.
6. **Review**: risk owner + security reviewer sign-off; config diff reviewed against the previous market.
7. **Launch in `ReduceOnly`** (state set right after creation) -> seed liquidity -> flip to `Normal` via timelocked/multisig tx. Start with low `maxOI` (can't be changed later - choose a conservative value and plan a replacement market if limits must grow).
8. **Monitoring**: dashboards/alerts for the new market before opening; keeper configured with the market id.
9. **Comms**: announcement with parameters, risks, oracle sources, and the "unaudited" status where applicable.

## B. Governance workflows (target; timelock not implemented)
All ADMIN actions go: proposal -> review -> queue (timelock delay) -> execute -> verify. Emergency restrictive actions go through GUARDIAN with immediate effect and post-hoc report.

| Workflow | Mechanism today | Notes / gaps |
|---|---|---|
| **Listing** | `createMarket` (ADMIN) | Parameters immutable afterwards. Create in `ReduceOnly`. |
| **Parameter change (global)** | `setFees`, `setAdlMaxPremBps`, `setOracle` | Immediate with ADMIN; needs timelock. `setOracle` swaps the oracle for ALL markets - treat as highest-risk. |
| **Parameter change (per market)** | not supported | Launch a v2 market, migrate via ReduceOnly on the old one. |
| **Reduce-only** | `setMarketState(m, ReduceOnly)` (GUARDIAN or ADMIN) | Immediate. Existing resting orders: confirm behaviour in tests (reduce-only flag handling on resting orders is per-order). |
| **Pause** | `setMarketState(m, Paused)` / `setGlobalPause(true)` | Blocks liquidation and withdrawal-with-position on that market; see RUNBOOKS 5. |
| **Closure (orderly wind-down)** | ReduceOnly + keeper/backstop unwinding + user notice | No forced close mechanism; open positions can remain indefinitely. |
| **Delisting / final settlement** | **NOT IMPLEMENTED** | Needed: `settleMarket(m, finalPrice)` after an oracle-based settlement window, deterministic close of all positions at the settlement price (incl. funding up to settlement), blocking new orders, withdraw of settled PnL, and ADL/insurance interplay. Until it exists, do not promise delisting. Design must be audited like any other money-moving code. |

### Delisting plan (design intent, once supported)
1. Announce (>= <N> days; UNDECIDED), move to `ReduceOnly`.
2. Freeze `maxOI` growth (already no growth in ReduceOnly), cancel new-risk orders.
3. At T0 compute settlement price = median/TWAP of the oracle over a fixed window, published on-chain before execution.
4. Settle each position at settlement price + accrued funding, insurance/ADL handles any deficits, remaining collateral returned to free balance.
5. Mark market `Closed` (new state needed); archive indexer data; update frontend.

## C. Post-launch
Weekly review of: OI vs cap, funding vs premium, liquidation count, bad debt, oracle deviations, insurance coverage ratio. Triggers for ReduceOnly: oracle degradation > <X> min, insurance < <Y>% of OI-at-risk, source disagreement events.
