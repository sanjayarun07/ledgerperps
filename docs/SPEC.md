# Units, math and rounding (as implemented)

| Quantity | Scale | Type |
|---|---|---|
| price | 1e6 USDC per 1 base unit | uint64 |
| size | 1e8 per base unit (1e8 = 1 BTC) | int256 signed (+long / −short) |
| collateral, fees, pnl | 1e6 (USDC, 6 decimals; asserted at construction) | int256 |
| basis | Σ signed size×price, exact integer; ÷1e8 → 1e6 USDC | int256 |
| funding rate / premium | 1e12 = 100% | int256 |
| funding index | rate×indexPrice/1e6 ; payment = size×ΔIdx / 1e14 | int256 |
| fees, margin | bps (1e4) | |

## Formulas
- notional(size,px) = size·px / 1e8 (floor for fees/fills, ceil for margin).
- Unrealized PnL = floor((size·mark − basis)/1e8) — rounded against the user.
- Realized PnL on reduce: remB = basis·closed/|old|; pnl = floor((±closed·px − remB)/1e8); the sub-unit remainder goes to protocol `dustBasis`.
- Flip: close |old|, remainder opens at fill price (basis = ±remainder·px).
- Equity = collateral + Σ unrealized − Σ unsettled funding. IM/MM = Σ ceil(notional(|size|,mark)·bps) with the tier chosen by whole-position notional.
- Withdrawable = max(0, min(collateral, equity) − IM − reservedOrderMargin). Unrealized profit is not withdrawable.
- Order reservation = ceil(notional(remaining, limit)·IM_bps) unless reduce-only (0). Opposing orders reserve in full (conservative; not netted).
- Mark = book mid clamped to index ± bandBps if book is two-sided, uncrossed and spread ≤ maxSpreadBps; else index. Last trade is never used.
- Fill price band: an ordinary fill (including reduce-only) executes only if the resting order's price is within index ± bandBps (inclusive) of the CURRENT index; otherwise the resting order is cancelled (`PriceBand`) and matching continues. Liquidation, ADL, backstop takeover and delist settlement are not ordinary fills (mark / settle price).
- Liquidation risk of a cross account: the liquidated market needs a valid mark. Any other held cross market with a stale/invalid feed is valued at `lastIndexPrice` (else its entry price) moved 20% (`STALE_FAV_BPS`) in the account's favour for PnL, margin requirement at the unmoved price. Isolated positions only ever price their own market.
- Funding: premium = (mark−index)/index sampled as a step function on each `pokeFunding`; rate = clamp(time-weighted avg / premiumDivisor, ±cap).
  Missed intervals are applied in one step at the sampled average. Positive rate ⇒ longs pay shorts. Pays round up, receipts round toward zero; residual stays in `fundingPool`. Paused markets and oracle outages are not sampled (zero sampled time ⇒ rate 0).
- Taker fee = ceil(notional·bps); maker fee may be a rebate (floor). Default schedule in the current source: taker 5 bps, maker −1 bp (rebate), so the protocol keeps 4 bps of each fill. `setFees` requires `|maker| <= taker`, so a single fill can never pay out more rebate than the taker paid in.

## Worked examples (each is an assertion in `test/exchange.test.js`)
- Partial fill: ask 1 BTC@50k, taker buys 0.4 → notional 20,000; taker fee 5 bps = 10.00; maker rebate 1 bp = +2.00; 0.6 BTC rests; maker reserves 3,000.
- Weighted entry/reversal: long 1@50k + 1@51k → basis 101,000; sell 3@52k → realized +3,000 (2·52,000 − 101,000), new short 1@52k.
- Liquidation: 1 BTC long, 6,000 collateral @50k; mark 45.5k → equity 1,475 < MM 2,275 → 50% (close factor) moved to backstop at mark; fee 0.5% split keeper/insurance.
- Funding: premium +1%/8 = 0.125% clamped to 0.04%/interval ⇒ 20 USDC per BTC per interval; short receives exactly what long pays.

## Ledger identity (checked in tests when all accounts are settled)
Σcollateral + insurance + feePool + fundingPool − unresolvedBadDebt + ⌊dustBasis/1e8⌋ = deposits − withdrawals.
Isolated margin is part of the identity: `ledgerTotals(accts)` sums `collateral` plus every `isoMargin` of the listed accounts. With open positions the exact form is
1e8·(Σcollateral + Σ isoMargin + insurance + feePool + fundingPool − unresolvedBadDebt − (deposits − withdrawals)) + dustBasis − Σbasis = −(ADL rounding retained by the vault).
A flat NEGATIVE bucket is never left standing: it is written off (insurance first, then `unresolvedBadDebt` and `adlDebt[market]`) by liquidation, by the fill that created it, by `settleDelisted`, or by the permissionless `writeOff`.

## Backstop accounting and physical solvency (BACKSTOP-1 phase 1, implemented 2026-11-13)
- Backstop equity `E_B = collateral[BACKSTOP] + Σ unrealised PnL - unsettled funding` over every market it holds. Marks: `_markFrom` on a valid feed, the frozen settle price when Delisted, and for a STALE feed the last good index moved 20% (`STALE_FAV_BPS`) AGAINST the backstop (cross accounts get the favourable direction; the backstop the adverse one, so an outage over-records, never hides).
- `syncBackstop()` (permissionless, idempotent, not blocked by pauses; also run at the end of `liquidate`, `settleDelisted`, each `adl()` call and before any `withdraw`): if `E_B < 0` the deficit `d` is credited to `collateral[BACKSTOP]` (bucket back to equity 0), charged to `insurance` first (tracked in `bsInsDrawn`), the rest added to `unresolvedBadDebt`, `adlDebt[market with the largest unrealised loss]` and `bsDebt`. If `E_B > 0` and draws are outstanding, the backstop repays them from its own equity: insurance first (`bsInsDrawn`), then `bsDebt` (and the per-market records, ascending). Every move is bucket-to-bucket, so the ledger identity is unchanged. Invariant: `bsDebt <= unresolvedBadDebt`, and `unresolvedBadDebt == Σ adlDebt`.
- **P3 (accounting form) at flat and settled: `balance >= Σ positive buckets - unresolvedBadDebt`, i.e. no bucket is negative, including `collateral[BACKSTOP]`, after a sync.** This is NOT `balance >= claims`: until recorded debt is cleared by ADL or `recapitalize`, claims exceed USDC by `unresolvedBadDebt`.
- ADL: works on the global pool (`D = unresolvedBadDebt`); premium ceiling `adlHardPremBps` (default 10000) while `bsDebt > 0`, else `adlMaxPremBps` (default 2500); the target's break-even binds; the concession `x` must also satisfy `x <= equity - maintenance - 1` over ALL of the target's cross markets (isolated: its isolated bucket), otherwise the target is skipped (`AdlSkipped`). `x` clears `adlDebt[market]` first, then other markets in ascending order. `adlScore` is 0 when equity <= 0.
- Withdrawal limiter: `principal[a]` = deposited collateral not yet withdrawn (deposit adds; withdraw subtracts, floor 0; `transferInternal` moves principal with the funds; trading profit and keeper fees do not add to it). While `unresolvedBadDebt > wdGateThreshold` (default 100 USDC) `withdraw(amount)` reverts `WithdrawGated` if `amount > principal[a]`; the ordinary margin check still applies. Deposits, closes, cancels, liquidations and ADL are never gated. This is a heuristic damper, not a proof of solvency: it does not prove that the funds left in the vault cover `Σ positive buckets - unresolvedBadDebt` at every instant.

## Backstop inventory management (BACKSTOP-1 phase 2, implemented 2026-11-14; off by default)
- Per market `BackstopCfg{softNotional, maxDiscBps, dwell, ramp, maxAge, elevatedSince}`. `softNotional == 0` disables everything below. Elevated = `|backstop size| x mark > softNotional`; `elevatedSince` is the time that state began (lazy; refreshed by liquidate/adl/take/unwind/`pokeBackstop`).
- `takeBackstop`: price = `index x (1 + d)` (backstop short, taker sells) or `index x (1 - d)` (backstop long, taker buys), `d = 0` for `dwell` seconds after `elevatedSince`, then linear to `maxDiscBps` over `ramp`. Rounded in the backstop's favour. `maxDiscBps <= min(300, bandBps)`. Taker fee `backstopTakeFeeBps` (0..10) goes to insurance. Taker must satisfy initial margin if its exposure grows. Needs a fresh mark; blocked while paused/degraded/delisted.
- `unwindBackstop`: after `maxAge` of elevation, `|inventory| - softNotional/mark` (rounded up to a lot) is closed at MARK against ranked profitable opposite positions, no concession.
- `backstopPlace` cannot grow inventory past the threshold; the whole function is closed when `backstopPlaceOpen == false`.
- Governance: admin sets all values within bounds; guardian may only tighten (`setBackstopCfg` on an enabled market with every field <= current; `setBackstopTakeFee` lower; `setBackstopPlaceOpen(false)`).
- Liquidation is never blocked by any of this. The threshold is SOFT: a liquidation can overshoot it.

