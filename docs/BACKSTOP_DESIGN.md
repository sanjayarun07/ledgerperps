# BACKSTOP-1 / ADL-2 / bad-debt attribution: design (DRAFT, not implemented)

Status: design document only. Authored 2026-11-13 against the current `contracts/src` (sizes: PerpExchange 19,864; PerpExtras 18,276;
PerpTrading 17,352; PerpLiquidation 12,218; PerpAdl 11,664; PerpTwap 10,246; limit 24,576). Nothing under `contracts/src`, `test`,
`foundry-test`, frontend, services, sdk or infra was changed. Nothing here is audited; "prototype" below means a throw-away patch on a
scratch COPY of `contracts/`, run with the repo's own hardhat suites (section 8). It validates one invariant, not the design.

> **IMPLEMENTATION STATUS (2026-11-13): PHASE 1 IS IMPLEMENTED** (design (b) + ADL-2 slack check + global-pool ADL + a governed ADL ceiling + a withdrawal limiter).
> Phase 2 (soft cap + auction, design (a)) and designs (c)/(d) are NOT implemented. The text below is the design as proposed; section 10 lists
> the ACTUAL deviations and the verification results. Still unaudited.

## 0. Executive summary

**Root cause.** The backstop (`BACKSTOP` account) is a normal account with no margin requirement. Liquidation/ADL/delisting hand it
positions at mark. After that its realised PnL goes into `collateral[BACKSTOP]` and its unrealised PnL is simply not looked at.
The counterparties of that inventory are real accounts whose gains are real and withdrawable (they can close against a new trader,
then `withdraw`). So the vault pays the winners but nobody is charged the loser's side: a negative `collateral[BACKSTOP]` is an
unfunded liability that no code path records. Reproduced: 1 BTC short taken over at 60k gives backstop equity -40k / -90k / -190k /
-440k at 100k / 150k / 250k / 500k with `insurance` 0 and `unresolvedBadDebt` (ubd) frozen at 3,655. Baseline fuzz group C with
`STRESS_KNOWN_GAPS=1` fails with "physical shortfall 929,491,198 micro-USDC ... backstop collateral -929,491,200".

**Two separable problems.**
1. *Accounting hole* (unrecorded loss). Fixable cheaply and completely in the sense of P3: treat the backstop like a margin account
   with a credit line: whenever its marked-to-market equity is negative, charge the deficit to `insurance`, then to
   `unresolvedBadDebt`/`adlDebt` (same sinks as any other bad debt), and repay when it recovers.
2. *Unbounded exposure and weak clearing*. Recording debt does not make it clearable. ADL can only haircut winners by at most
   `adlMaxPremBps` (25% of mark) per unit of backstop inventory and only while the backstop still holds inventory in that market.
   In the repro, after recording 443,655 of debt one ADL clears 125,000 and the backstop is then flat, so 318,655 can only be
   recapitalised. Exposure must be bounded in time (unwind) and the clearing power must be sized to it.

**Recommendation (one design, phased).**
- **Phase 1 (MVP, close BACKSTOP-1 accounting + ADL-2 + attribution): design (b) "backstop mark-to-market credit line"**, plus the
  ADL-2 slack check, plus global-pool ADL with own-market-first rule, plus a governed ADL premium ceiling decision (Q1). Prototyped
  (section 8): BACKSTOP-1 deterministic repro and ADL-2 deterministic repro pass, fuzz group C passes with `STRESS_KNOWN_GAPS=1` (baseline fails).
  Cost on the scratch copy: PerpTrading +1.9 KB, PerpLiquidation +1.6 KB, PerpAdl +1.9 KB, PerpExchange +90 B; all stay < 24,576.
- **Phase 2: design (a)-lite**: soft inventory threshold per market, permissionless Dutch-auction unwind (`takeBackstop`) at mark +/- a time-ramped discount
  (bounded by min(bandBps, 300 bps)), and an inventory-triggered forced unwind through ADL at mark when the hard threshold is exceeded.
  This bounds exposure *duration*, not exposure *size* (liquidations must keep working, so size cannot be hard-capped; see 2.1).
- **Not now**: (c) no-inventory liquidation (book IOC / ADL-first) and (d) LP backstop vault. Documented as alternatives (2.3, 2.4).

**What is NOT solved even after phases 1-2** (stays a documented gap): (i) between recording and clearing, positive claims exceed vault
USDC by `ubd`; withdrawals by winners in that window are a run on the vault (P3 is an accounting property, see 1.3); (ii) ADL
completeness is still keeper-trusted; (iii) oracle/gap risk: a move larger than insurance + ADL capacity leaves residual debt for `recapitalize`;
(iv) governance/oracle trust assumptions are unchanged.

## 1. Problem statement, definitions, invariants

### 1.1 Mechanism
`liquidate`, `_adlOne` and `settleDelisted` do `_applyFill(victim, -q, px); _applyFill(BACKSTOP, +q, px)`. Position accounting is
zero-sum across all accounts incl. BACKSTOP (P1: net position 0). Consider long L (opened at 50k, +10k at 60k) and short S liquidated at 60k:
S's loss is limited to its collateral; the rest is bad debt D0 recorded (3,655 in the repro). Backstop now holds S's short. If price
rises further, L's unrealised profit grows by exactly the backstop's unrealised loss. When L closes against anyone, L's profit is
credited to `collateral[L]` (a claim on the vault). The backstop's loss only materialises as a negative number in `collateral[BACKSTOP]`
when the backstop closes, and until then it is invisible. Result: Σ positive claims > USDC held; the ledger identity (below) still
holds because the negative backstop bucket is included in Σcollateral, which is exactly why no existing invariant caught it.

### 1.2 Definitions (all in 1e6 USDC; positions marked with `_markFrom`, funding accrued)
- `E_B` (backstop equity) = `collateral[B] + Σ_m upnl_B(m) - Σ_m fundingOwed_B(m)`, over all markets where `positions[B][m].size != 0`
  (no isolated margin is ever used by the backstop). Same formula as `_risk` but never reverting on a stale market (see 2.2 for the stale rule).
- `V` = USDC balance of the vault. `ubd` = `unresolvedBadDebt`. `ins` = `insurance`.
- `Claims` = ins + Σ_k max(collateral[k],0) + Σ_k Σ_m max(isoMargin[k][m],0) + max(feePool,0) + max(fundingPool,0)  (positive buckets only, as in the P3 check in `stress.test.js`).
- Existing ledger identity (flat, settled): Σcollateral + Σiso + ins + feePool + fundingPool - ubd + floor(dust/1e8) = deposits - withdrawals. Unchanged by this design (every
  move below is a transfer between buckets that the identity already sums).

### 1.3 Target properties
- **P3 (physical solvency, accounting form)**, at flat and settled: `V >= Claims - ubd`. Equivalent, given the identity, to *no negative bucket remains*, **including `collateral[BACKSTOP] >= 0`**.
  P3 says the unfunded part is exactly the recorded `ubd`; it does NOT say `V >= Claims`. Real solvency also requires `ubd -> 0` through ADL or `recapitalize`. State this wherever P3 is quoted.
- **P3a**: `ubd == Σ_m adlDebt[m]` (kept; also after every new debt/repay path).
- **P9**: `ubd == Σ(bad debt recorded: liquidation, fills, settleDelisted, writeOff, backstop sync) - Σ(ADL cleared) - Σ(recapitalised) - Σ(backstop repay)`. The harness must learn the new `BackstopSynced` event (it currently only knows `Liquidated.badDebt`, `BadDebtUnresolved`, `AdlExecuted`, `Recapitalized`).
- **P11 (new, backstop recognition)**: after any transaction that changes a mark-relevant backstop input (liquidate, adl, settleDelisted, a fill involving BACKSTOP, `syncBackstop`, and `withdraw` if hooked), `E_B >= 0` (up to 2 micro-USDC rounding). Off-chain moves of the oracle between transactions are covered by the permissionless `syncBackstop()`; the invariant is therefore stated "after sync".
- **P12 (new, bounded recognised loss per unit of time)**: `max(0, -E_B_before_sync) <= Δ` where Δ is the loss from the last sync mark to the current mark. Trivially true; useful as a *monitoring* property (alert if the keeper lets sync lag).
- **P13 (new, ADL-2)**: after any `_adlOne`, a CROSS target satisfies `equity >= maintenance` over ALL its cross markets (using `_riskLiq`), or is unchanged. An isolated target satisfies it on its isolated bucket.
- **P14 (new, ADL capacity)**: *informational*: `ubd_backstop_recorded <= Σ_{opposite-side profitable positions} unrealised profit`. True by zero-sum if all debt originated from price moves, but ADL can only realise it up to the premium ceiling; therefore residual debt after ADL is a reported metric, not an invariant.
- Retained: P1 (net position incl. BACKSTOP is 0), P2 (ledger identity), P6 (no flat negative bucket, now includes BACKSTOP), P8 (insurance never negative), funding conservation.

### 1.4 Who bears backstop losses, by ordering of events
Loss L = decrease of `E_B`. Proposed waterfall (first loser first): (1) backstop's own funded collateral (`collateral[B]`, only non-zero after governed
`rebalanceBackstop`); (2) `insurance` (automatic draw, refundable); (3) winners via ADL concession on the opposite side of the inventory, bounded by break-even and the premium ceiling; (4) residual `ubd`,
payable by `recapitalize` (anyone/governance) and implicitly by every positive-balance holder if it is never cleared.

| Ordering | Today | Proposed |
|---|---|---|
| Takeover, price keeps moving against inventory, nobody closes | unbounded unrecorded; winners withdraw real USDC | each `sync` charges ins then debt; winners can still withdraw in the window (gap (i)) |
| Takeover, then price reverts | loss/gain invisible until closed | debt and insurance draw repaid from recovered equity (insurance first). Verified in prototype |
| Backstop closes inventory via `backstopPlace` at a loss | negative `collateral[B]`, unrecorded | fill hook (or next sync) credits the deficit and records it |
| ADL clears debt D by concession x | x removed from ubd and targets' profit; backstop equity unchanged (fill at mark) | same; plus ADL-2 slack check; ADL can use any market's debt (4.2) |
| Inventory fully consumed by ADL while debt remains (repro: 318,655) | n/a | residual `ubd`: only `recapitalize` (ADL needs inventory). Phase 2 reduces this by earlier unwinds |
| Delisting | `settleDelisted` nets backstop to flat; loss vs settle price unrecorded | `_syncBackstop` at the frozen settle price after each settlement (exact) |
| Oracle stale while backstop holds inventory | nothing | backstop valued ADVERSELY by `STALE_FAV_BPS` (20%); repaid when feed returns (reversible) |
| Funding | settled via `_settleMarket(BACKSTOP)` on takeover | sync settles all backstop funding first (included in `E_B`) |

## 2. Candidate designs

Common prerequisite for all of (a)-(d): backstop accounting must be recognised (b). (a) and (c) reduce how often the credit line is used; (d) replaces who funds it.

### 2.1 Design (a): inventory threshold + forced/auctioned unwind

*Idea.* Make the unrealised loss short-lived by getting inventory off the backstop quickly, at a bounded cost.

*Why a hard size cap is rejected.* Refusing to take over beyond a cap means liquidations stop working exactly when the market is falling; the victim stays
open and its loss grows (more bad debt, WASH-style griefing: a trader could stay underwater without consequences). Auto-switching the market to ReduceOnly on cap breach is a
cheap DoS (an attacker pays liquidation fees to freeze a market). So the cap is a *trigger for faster unwind*, not a limit on takeover.

*State machine (per market m, evaluated lazily when anyone calls `takeBackstop`, `adl`, `liquidate`, `syncBackstop`)*:
`Idle` (|inv| notional <= soft) -> `Elevated` (> soft; `elevatedSince` stored; auction discount = 0 for `dwell` seconds, then ramps linearly to `maxDiscBps` over `rampSeconds`)
-> `Forced` (> hard OR `E_B + ins` below `floorBps` of backstop notional): ADL-style forced closure at mark of the best-ranked profitable opposite accounts (no price concession, so no value is taken; the winner keeps all profit; the backstop merely stops being the counterparty).
Back to `Idle` when notional <= soft. No state is entered automatically that restricts trading.

*Storage (appended to PerpBase; fresh deploy, see 7.5)*:
```
struct BackstopCfg { uint128 softNotional; uint128 hardNotional;     // slot 1 (1e6 USDC)
                     uint16 maxDiscBps; uint32 dwell; uint32 ramp; uint32 floorBps; uint64 elevatedSince; } // slot 2
mapping(uint8 => BackstopCfg) public backstopCfg;
```
Phase-1 variables (design (b)): `uint256 bsCredit; uint256 bsInsDrawn;` (2 slots).

*New / changed functions*:
- `takeBackstop(uint8 sub, uint8 market, uint128 size, uint64 limitPx)` (permissionless, any funded account): requires `Elevated`/`Forced`, fresh valid mark, `size <= |inv|`, lot-aligned.
  Price `p = mk * (1 -/+ d(t))` (d>0 means the taker buys inventory cheaper / sells to a short backstop above mark; direction always favours the taker), `|p - index| <= bandBps`, `p` honours `limitPx`. Fill via `_applyFill` on taker and BACKSTOP, `_marginOK(taker)` after, no taker fee (or the normal fee: open question), then `_syncBackstop()` and `_writeOffIfFlat(taker)`. Reduce-only for takers who hold the opposite position is allowed.
- `adl` relaxed: when market is `Forced` it may run with `adlDebt == 0`, premium 0, size <= min(excess over soft, target size). Reuses `_adlOne`.
- `setBackstopCfg(m, ...)` admin (bounds below). Guardian may only lower soft/hard or `maxDiscBps`.
*Events*: `BackstopAuction(market, taker, size, price, discBps)`, `BackstopElevated(market, notional)`, `BackstopForcedUnwind(market, target, size)`.
*Size/gas*: ~+2.0-2.5 KB; host in PerpLiquidation (13.8 KB with phase 1 -> ~16 KB). `adl` change in PerpAdl +0.4 KB. Per call: one position loop + mark + fill ~= 150-250k gas (estimate from existing fill and liquidate gas; unmeasured).
*Attack surface*:
- **Self-liquidation round trip** (A gets liquidated, buys the inventory back cheaper): profit only if `d(t)` exceeds liquidation fee + their slippage; with `dwell` > 0 and a linear ramp from 0 it is a delayed, time-risked trade rather than free money, and `liqFeeBps` (50 bps) is paid. Require `maxDiscBps` of at most 100 bps by default.
- **Mark manipulation** (book mid within the band): mark = book mid clamped to index +/- bandBps. An attacker pushes the mark to the edge of the band to sell inventory to the backstop at an inflated price (or buy cheap). Bounded by `bandBps` x size and by the auction price check `|p - index| <= bandBps`. Mitigation: auction priced from the *index* (not the book mid), discount applied to the index. Recommended; makes Phase 2 immune to book games at the cost of a possible mismatch with liquidation mark.
- **Wash against the backstop**: backstop is a counterparty for any funded account; sizes are bounded by inventory, discount by `maxDiscBps`; worst loss per unit of inventory = `maxDiscBps`; charged to insurance via sync. Griefing by repeatedly taking tiny slices: `minNotional` applies.
- **Oracle staleness**: auction requires a valid fresh index (same as `markPrice`); on a stale feed the auction is unavailable while `sync` values the inventory adversely (STALE_FAV_BPS = 20%). Consequence: a stale feed can over-record debt (reversible) but cannot under-record it. No interplay with `STALE_FAV_BPS` for the taker: the taker's margin uses the normal `_marginOK` (all markets must have valid marks), so a taker with a stale unrelated market cannot take inventory.
- **Forced unwind fairness**: ranks by `adlScore`, completeness is keeper-trusted (as today).
*Off-chain*: keepers need an auction bot (`takeBackstop` is profitable for any arbitrageur); indexer: new events, per-market `elevatedSince`, current discount (view `backstopAuctionPrice(m)`); frontend: ops panel shows backstop inventory/E_B/debt, and a banner when a market is `Elevated`.
*Tests*: deterministic: threshold crossing/dwell/ramp; discount bound; taker margin; stale feed; direction both sides; forced unwind leaves winner profit intact; fuzz: add `takeBackstop` and `forcedUnwind` to the keeper action set in `stress.test.js` (group A/C), property "inventory notional is non-increasing after Forced unwind"; Foundry: invariant `|inv| * mark <= hard * (1+slack)` is NOT claimed (cannot be).
*Migration/ABI*: new functions/events/errors, no change to existing signatures. Storage append => fresh deploy only.

### 2.2 Design (b): backstop mark-to-market credit line (RECOMMENDED CORE; prototyped)

*Idea.* The backstop is an account whose equity must never be negative at a recorded sync point. A negative `E_B` is a deficit
that is covered exactly like any other bucket deficit (`_writeOffIfFlat`): insurance first, remainder to `ubd`/`adlDebt[m]`, deficit
credited to `collateral[B]` so the bucket is non-negative and the identity is unchanged. When equity recovers, the credit is repaid in
reverse order (insurance draw first, then debt).

*State machine*: `Solvent (E_B >= 0)` <-> `Credited (bsCredit > 0)`. Transition on every `_syncBackstop()`:
```
settle all backstop funding; E_B = collateral[B] + Σ upnl (stale market: adverse by STALE_FAV_BPS; Delisted: settlePrice)
if E_B < 0:  d = -E_B; cover = min(d, insurance); insurance -= cover; bsInsDrawn += cover
             collateral[B] += d; bsCredit += d
             bad = d - cover; if bad>0 { ubd += bad; adlDebt[worstMarket] += bad; emit BadDebtUnresolved(BACKSTOP, bad) }
elif E_B > 0 and bsCredit > 0:  room = min(E_B, bsCredit); refund insurance first (<= bsInsDrawn), rest reduces ubd and adlDebt[] (ascending);
             collateral[B] -= repaid; bsCredit -= repaid
```
Rounding: all integer; `_fdiv` floors upnl, which values the backstop's unrealised PnL slightly against it (conservative).
Hooks: end of `liquidate`, `settleDelisted`, each `adl` call (ONCE per call, not per target: the prototype did it per target, costing +650k gas at 16 markets), `_executeFill` when maker/taker is BACKSTOP
(+1.9 KB in PerpTrading; alternative: skip the fill hook and rely on the `withdraw` hook below + permissionless `syncBackstop()`), `withdraw` (router; recommended so a winner's exit sees
the debt first; it does not block it), and the permissionless `syncBackstop()`.

*Storage*: `bsCredit`, `bsInsDrawn` (2 slots). Optionally `lastSyncBlock` to emit a lag metric.
*Functions*: `_syncBackstop()` in PerpBase (internal, ~45 lines); `syncBackstop()` external in PerpLiquidation. Event `BackstopSynced(equityBefore, fromInsurance, toDebt, market, repaid)`.
*Size/gas (measured on scratch copy)*: PerpTrading 17,352 -> 19,214; PerpLiquidation 12,218 -> 13,768; PerpAdl 11,664 -> 13,113 (13,597 with the ADL-2 check); PerpExchange +90. Gas: liquidate +14k (3 markets) / +68k (16 markets, backstop holding all 16); adl(8 targets) +122k / +650k (per-target sync; fix to once per call).
*Attack surface*:
- **Insurance drain by a transient move**: insurance is drawn on a spike and refunded on reversion (prototype: repaid in full at 80k and 50k). A manipulated oracle spike therefore transiently moves insurance into the credit; permanent loss only if inventory is closed (realised) at the spike. Not new: the same oracle trust as liquidation.
- **Debt-ratchet**: repayment is limited by `bsCredit`; rebalanced funds (`rebalanceBackstop`) are never swept.
- **Oracle staleness**: adverse valuation (20%) can over-record debt while a feed is down; reverses afterwards. During `Delisted`, exact at settlePrice.
- **Price band**: unaffected (no ordinary fill added). Backstop fills via `backstopPlace` already respect the band.
- **Sync gas griefing**: loops over <= 16 markets with <= 16 oracle reads; same order as `_risk`. Permissionless sync is idempotent (second call no-op).
- **Hook failure**: if the oracle reverts (catch inside `_index`) the market is valued stale-adverse; sync itself never reverts on price.
*Known limitations (do not hide)*: (1) recording does not move USDC; winners can withdraw realised profit in the window; (2) `bsCredit` is a coarse single counter (not per market); after ADL clears part of `ubd`, later repayments are bounded by `min(E_B, bsCredit, ubd)` and may repay another account's bad debt (harmless economically, but not attributable); (3) attribution of new debt is to the market with the largest unrealised loss, an approximation (4.2 replaces its consequences);
(4) `bsCredit` is not reset when the backstop goes flat (stale but bounded by ubd).
*Off-chain*: a keeper must call `syncBackstop()` every N seconds/each oracle update while the backstop holds inventory (gas tiny when flat: early return). Indexer: `BackstopSynced`; backstop panel shows `E_B`, `bsCredit`, `bsInsDrawn`. Frontend: insurance now moves with prices, not only at liquidation.
*Tests*: see section 7 (flip BACKSTOP-1 and rewrite its predicate; new P11/P9 harness bookkeeping; group A P3a delta check must include sync debt).
*Migration/ABI*: new external `syncBackstop`, new event, 2 public getters; no signature change. Storage append in PerpBase => redeploy.

### 2.3 Design (c): backstop never holds inventory (ADL-first or book-IOC)

- **(c1) ADL-first (dYdX/Binance style)**: `liquidate` closes the victim directly against ranked profitable opposite accounts at mark (price = victim's bankruptcy price for the part beyond collateral). Needs a keeper-supplied target list inside liquidation, so liquidation liveness would depend on a ranked list and the existence of profitable opposite positions (not guaranteed, e.g. everyone opposite is underwater or isolated). Every liquidation forcibly closes profitable traders (not only on bad debt). All of PerpLiquidation/PerpAdl semantics and all stress properties change. Rejected for MVP.
- **(c2) Book-IOC (Hyperliquid style)**: `liquidate` self-calls `placeFor(victim, IOC reduce-only, limit mark -/+ bandBps)`. Fill price is the book price (not mark), taker fee applies, up to 40 touches (~2.4M gas per BENCHMARKS); unfilled remainder still needs a fallback (backstop or ADL), so the backstop does not disappear. PerpLiquidation would need matching code reachable only through PerpTrading (self-call); the victim's loss now depends on book depth and quote games within the band. Rejected for MVP.
*Storage/ABI*: none for (c2); (c1) changes `liquidate` signature (targets array). *Size*: (c2) ~+1.5 KB in PerpLiquidation, but much more test surface; (c1) ~+2-3 KB.
*Attack surface*: book manipulation, quote-stuffing to make the IOC revert on gas, completeness of target list. *Verdict*: not recommended now; revisit once a real book exists and depth data is available.

### 2.4 Design (d): protocol-owned backstop vault funded by LP deposits (brief)
Separate share-price accounting (`deposit/withdraw` shares, NAV = collateral[B] + upnl), LP lock-ups, withdrawal queue, and loss waterfall: LP capital first, then insurance, then ADL. New
storage (shares, NAV snapshot, queue), new module (size: ~+4-6 KB, a 7th contract or Extras overflow), new threats (share-price manipulation via inventory marks, LP run on drawdown, first-depositor inflation). Needs product decisions (who are LPs, fees, caps). Not recommended for a prototype; (b) is its prerequisite anyway (NAV must be defined).

## 3. Comparison and recommendation

| Criterion | (a) cap + auction/forced unwind | (b) MTM credit line | (c) no inventory | (d) LP vault |
|---|---|---|---|---|
| Closes unrecorded-loss hole (P3) | No (only shortens exposure) | **Yes (proved by prototype on deterministic + fuzz C)** | Yes (no inventory) | Partly (needs (b)) |
| Bounds exposure size | No (cannot hard-cap, 2.1) | No | Yes (zero) | By LP capital |
| Bounds exposure duration | Yes | No | n/a | No |
| Preserves current liquidation semantics | Yes | Yes | **No** (rewrites it) | Yes |
| Contract size (worst module after) | Liquidation ~16 KB | Trading 19.2 KB | Adl/Liquidation +2-3 KB | new module |
| New attack surface | auction games within band | oracle spike moves insurance (reversible) | book games, list completeness | share-price / LP run |
| Keeper/ops burden | auction bot | `syncBackstop` cron | ADL lists on every liquidation | LP ops |
| Test churn | moderate (new actions) | small (P9/P3a bookkeeping, 1 predicate) | very large | large |
| ABI break | additive | additive | `liquidate` changes (c1) | additive |
| Maturity for a prototype | medium | **high** | low | low |

**Recommendation: (b) now, (a)-lite next, (c)/(d) deferred.** Rationale: (b) is the only candidate that makes the ledger tell the
truth with a small, additive, testable change; every other candidate needs (b) to be correct anyway. (a) is then an *operational*
improvement that shrinks the amount of time and money flowing through the credit line. (c) trades the backstop risk for liquidity,
oracle/book and liveness risk that this prototype cannot yet characterise.

**Minimal viable subset (ship first, in this order of value/risk):**
1. `_syncBackstop` + `syncBackstop()` + hooks in `liquidate`, `settleDelisted`, `adl` (once per call), `withdraw`; harness bookkeeping for the new event.
2. ADL-2 slack check (4.1).
3. Global-pool ADL with own-market-first (4.2).
4. Decision Q1 on the ADL premium ceiling (without it, recorded debt is often un-clearable; see 8.3).
5. `_executeFill` hook only if measurement shows the `withdraw` hook + keeper cron leave a gap that the invariants find.
**Stays a documented gap after MVP:** inventory size/duration (until Phase 2), withdrawal run window while `ubd > 0`, ADL candidate completeness, in-band wash bounded by `bandBps` x notional, ADL rounding leak.

## 4. ADL-2 and bad-debt attribution

### 4.1 ADL-2: cross-margined target pushed underwater
Observed: ADL's break-even test is per closed slice (`prem <= mk - entry` of the closed market); the target's other cross markets are ignored. Repro: target equity 12,772.6 / mm 5,660 before, **-907.4** after.
*Design.* Concession `x = sz*prem/1e8` reduces the target's equity by exactly `x` (+<= 1 micro from floor rounding) and reduces its maintenance requirement or leaves it unchanged. So a sufficient condition is
`x <= equity_before - mm_before - 1`, evaluated with `_riskLiq` (all cross markets; stale ones valued in the target's favour per the existing rule; isolated target: `_isoRisk`). Implementation: before the fills, compute `slack`; if `slack == 0` skip the target; else `sz = min(sz, slack*1e8/prem)`.
- Conservative: it ignores the margin freed by the closed slice, so it may clear less debt than an exact post-state check. Exact variant: apply fills, recompute `_riskLiq`, revert if `equity < mm` (costs a second risk pass, ~+60-120k gas at 3-16 markets, unmeasured); the keeper then must choose smaller targets by trial. Recommendation: conservative first.
- **Skip, don't revert.** In the prototype the check reverts (`target at maintenance`) which aborts the whole keeper batch; production should `continue`. This also means `adlScore` should return 0 (not `max`) for `equity <= mm` targets: today `eq <= 0 -> max score` ranks an underwater account FIRST, but such an account must be liquidated, not ADL'd. This is a behaviour change for rankings and for the Foundry ADL checker (`StressAdl.sol`).
- Prototype result: after ADL, t1 equity 5,660.37 vs old mm 5,660 (new mm 3,840): passes the ADL-2 predicate. Cost: +484 B in PerpAdl (13,113 -> 13,597); `PerpAdl.adlSlack` was made an external self-call because inlining `_riskLiq` twice hit "stack too deep" under viaIR (a real constraint for the implementer).
- Side effect (honest): less debt cleared per ADL, more residual `ubd` for `recapitalize`. This is the intended trade-off: do not push a winner into liquidation to pay for someone else.

### 4.2 Bad-debt market attribution
Problem: `_writeOffIfFlat(a, m)` books `adlDebt[m]` to the market of the *last cross position closed*, and `_adlOne` requires `adlDebt[market] > 0` and backstop inventory in `market`, so debt booked on ETH cannot be cleared by ADL on BTC where the backstop's inventory actually is.
Options:
- **(i) Attribute at origin.** Record the loss where it arose. A cross account's deficit comes from several markets' PnL; the account is flat only after the last close, so the contract would need per-account, per-market realised-loss ledgers (extra storage on every fill, +gas on the hot path). Rejected.
- **(ii) Global pool with explicit rules (recommended).** `ubd` is already the global debt; keep `adlDebt[m]` as the *attribution/priority* record (P3a keeps `ubd == Σ adlDebt`), and allow `adl(targets, m)` when `ubd > 0`: size premium on `D = adlDebt[m] > 0 ? adlDebt[m] : ubd`. Clearing `x` reduces `adlDebt[m]` first, then other markets in ascending id (<= 16 iterations, ~+0.5 KB). Rules: (1) own-market debt is always consumed first; (2) spill-over only when the backstop holds opposite inventory in `m`; (3) same premium ceiling, break-even and ADL-2 slack; (4) `recapitalize(market, amount)` unchanged (any market; add `recapitalizeAny(amount)` as convenience optional).
- Fairness note: winners in market B subsidise debt that arose in market A. This is a deliberate socialisation choice (open question Q3); the alternative is to leave the debt uncleared and rely on recapitalisation.
- Backstop-sync debt (2.2) is attributed to the market with the largest unrealised loss (approximation); rule (ii) makes this attribution harmless.

## 5. Parameters and governance

| Parameter | Scope | Proposed default | Bound / who can change |
|---|---|---|---|
| `adlMaxPremBps` | global (existing) | Q1: keep 2500 for routine ADL; add `adlHardPremBps` = 10000 usable only for backstop-originated debt (still never below target's break-even and ADL-2 slack) | admin via timelock; <= 10000; guardian can only lower |
| `softNotional` (phase 2) | per market | `min(0.10 x maxOI x mark, (ins + collateral[B]) / stressMove)`, stressMove = 25% (e.g. ins 1M -> 4M notional) | admin via timelock; guardian can only lower |
| `hardNotional` | per market | 2 x soft | same |
| `maxDiscBps` | per market | 100 | <= min(bandBps, 300); guardian lower-only |
| `dwell` / `ramp` | per market | 60 s / 600 s | admin; ramp >= 60 s |
| `floorBps` (`E_B + ins` vs backstop notional) | per market | 200 | admin |
| sync lag alert | ops | 1 oracle update or 60 s | monitoring, not on-chain |
| `STALE_FAV_BPS` | constant | 2000 (also used adversely for the backstop) | stays a constant (as documented); consider governable later |
Governance reality: today admin actions are immediate (no timelock in repo besides the governance test with an OZ `TimelockController`); the bounds above are only meaningful if the admin is the timelock. Anything that raises risk (caps up, discount up, premium ceiling up) is admin-only; anything that lowers it may be guardian.
Per-market configurable: soft/hard thresholds, auction discount/dwell/ramp, floor. Global: premium ceilings, sync hooks (not toggleable; avoid a switch that can disable recognition).

## 6. Implementation plan (ordered tasks, file-level)

Do NOT start until the current deployment/compile work from `contracts/src` is finished and the user has answered Q1-Q4.
1. `PerpBase.sol`: add `bsCredit`, `bsInsDrawn` (appended after `dustBasis`), `event BackstopSynced`, `_syncBackstop()` (valuation helper reuses `_index/_markFrom`, adverse stale rule, `Delisted` -> settlePrice). Keep it `internal`; guard against `marketCount == 0`. Reset `bsCredit`/`bsInsDrawn` when the backstop is flat AND `E_B >= 0` (decision for item 2 of risks).
2. `PerpLiquidation.sol`: call `_syncBackstop()` at the end of `liquidate` (after `_writeOffIfFlat`), `settleDelisted`; add `syncBackstop()` (permissionless, `nonReentrant`).
3. `PerpAdl.sol`: once-per-call sync at the end of `adl()`; add `adlHealth` (public view) and `adlSlack` (external view; self-call because of stack depth); skip-not-revert on slack 0 inside `adl()`; `adlScore` returns 0 for `equity <= mm` cross targets; global-pool premium sizing and spill-over loop (4.2); optional `adlHardPremBps` branch.
4. `PerpExchange.sol` (router): `withdraw` calls sync through the same module delegate path (or `_syncBackstop` inline: +~1.5 KB; router has ~4.7 KB headroom). `setAdlHardPremBps` setter if Q1=yes. Bounds-check, emit event.
5. `PerpTrading.sol`: only if needed, the `_executeFill` hook (+1.9 KB). Leave out first.
6. Tests (section 7), docs: `GAPS.md`, `SPEC.md` ledger section (P3 wording, new event), `THREAT_MODEL.md` rows 8, `RUNBOOKS.md` (sync cron, auction bot), `ARCHITECTURE.md` module list unchanged.
7. Off-chain: keeper `syncBackstop` loop (cron + on every oracle update when backstop non-flat); indexer: add `BackstopSynced` (also derive `E_B`); frontend ops/admin page: backstop equity, credit, insurance draw.
8. ABI regeneration (`contracts/abi`, SDK types), deploy scripts: new selectors are picked up automatically by `registerModule` flow (selector set comes from artifacts); fresh deploy required.
9. Phase 2 (separate PR): `BackstopCfg`, `takeBackstop`, forced-unwind mode of `adl`, `setBackstopCfg`, view `backstopAuctionPrice`; keeper bot.

## 7. Verification plan

7.1 Deterministic (hardhat, `test/stress.test.js` + `isolated_adl.test.js`)
- BACKSTOP-1: flip to `it`. **Rewrite its predicate.** `insurance + backstopEquity - unresolvedBadDebt >= 0` fails even at 60k on the baseline (ins 0, ubd 3,655 from the victim's own bad debt, E_B = 0), i.e. it conflates pre-existing recorded debt with the new hole. Use: after `syncBackstop()` at each price, `backstopEquity >= -2` and `collateral[B] >= 0`, and `ubd == ubd0 + max(0, -E_B_unsynced - ins_drawn)` (exactly the recorded delta), plus reversion test (price returns, `ubd` returns to `ubd0`, insurance refunded). The repro with the exact numbers: 100k/150k/250k/500k -> ubd 43,655 / 93,655 / 193,655 / 443,655.
- ADL clearing after recording: at 500k, with the ceiling Q1 undecided, assert and print how much of 443,655 a single ADL clears (prototype: 125,000; residual 318,655). With `adlHardPremBps` = 10000 expect the target's full 440k to be available (not run, see 8.3).
- ADL-2: flip to `it`; additional cases: isolated target, three-market target, target exactly at slack 0 (skipped, no revert in `adl()`), equity <= mm (not ranked first).
- Attribution: debt booked on ETH cleared by ADL on BTC where the backstop sits; P3a holds; own-market-first order; spill-over order.
- Sync edge cases: no positions (no-op); stale feed (adverse valuation), feed returns (repay); Delisted; repeated sync idempotent; `rebalanceBackstop` funds not swept; sync inside `withdraw` does not revert withdraws of other accounts.

7.2 Fuzz (`stress.test.js` groups; seeds as in the existing runner)
- Group A: the P3a delta check at `doLiquidate` (line ~350) must count `BackstopSynced.toDebt` emitted in the same tx, otherwise it reports a false violation (observed in the prototype run: `adlDebt[1] delta 712,085,829 != badDebt 280,143,885`).
- Group C: remove the KNOWN_GAPS tolerance for the backstop bucket (`bsNeg`) at the end of `finalizeAndCheck`; require `collateral[B] >= 0` and `V >= Claims - ubd`. Add a keeper action `sync` and make the end-of-scenario sequence `sync; recapitalize*; sync`.
- Group E: P9 formula gains `+ syncBad - syncRepaid` from events.
- New property P11 evaluated after every action (`E_B >= 0` after sync). New property P13 inside `P7` ADL checks (target health after ADL).
- Foundry: `StressChecks.sol` `backstopEquity()` + the "P3: physical shortfall" check (`ins + E_B - ubd >= -2`, same flawed predicate as the JS one) must be redefined to `E_B >= -2 after sync`; add `syncBackstop` to `StressKeeper` and `StressHandler`; `StressAdl.sol` must tolerate skipped targets. Keep 256 fuzz / 128x250 invariants, then `FOUNDRY_PROFILE=ci`.
7.3 Regression: `exchange`, `isolated_adl`, `governance`, `twap`, `fuzz` suites unchanged; contract-size gate in CI (< 24,576, report headroom); gas deltas appended to `docs/BENCHMARKS.md`.
7.4 Exit criteria: all stress groups green WITHOUT `STRESS_KNOWN_GAPS` for BACKSTOP-1 and ADL-2 at the default seeds and at 5 additional seeds (`STRESS_SEED`), 200 runs per group, Foundry CI profile green, sizes below the limit.
7.5 Migration: not upgradeable and storage appended in the shared base => new deployment; existing local chains keep the old bytecode (as GAPS.md already notes for earlier fixes). No data migration needed beyond re-pointing keepers/indexer.

## 8. What I actually ran (prototype evidence)

Scratch copy: `/private/tmp/claude-501/-Users-arunmozhi--claude-spares-spare-TnGUqF/75df05e0-66b5-42d6-b3b8-10a2dc43a635/scratchpad/c` (copy of `contracts/` without node_modules; `node_modules` symlinked, read-only use). Unmodified copy for baseline: `.../scratchpad/c0`. Diff of the prototype: `.../scratchpad/prototype_backstop.diff` (157 lines, includes ADL-2). Modified test: `.../scratchpad/stress_proto.test.js.txt`. No node was started; hardhat in-process network only; hardhat was never run in `contracts/` itself.

8.1 Baseline reproduction (`STRESS_KNOWN_GAPS=1 npx hardhat test test/stress.test.js --grep "BACKSTOP-1|ADL-2"`, unmodified sources): both fail. Backstop equity table 0 / -40,000 / -90,000 / -190,000 / -440,000 at 60k..500k, ins 0, ubd 3,655. ADL-2: t1 equity 12,772.6 -> -907.4 (mm 2,160).
Baseline fuzz group C with gaps on: `STRESS_KNOWN_GAPS=1 STRESS_GROUPS=C npx hardhat test test/stress.test.js --grep "group C"` -> 0 passing, 1 failing: "(finalize) [P3] final: physical shortfall 929491198 micro-USDC ... backstop collateral -929491200".

8.2 Prototype (design (b) + ADL-2 check; hooks in liquidate/settleDelisted/adl(per target)/_executeFill + permissionless `syncBackstop`):
- BACKSTOP-1 with `syncBackstop()` after each price move (predicate changed to `E_B >= -2 && ins + E_B >= 0`): passes. Table (price | E_B | ins | ubd | collateral[B]): 60k 0|0|3,655|0; 100k 0|0|43,655|40,000; 150k 0|0|93,655|90,000; 250k 0|0|193,655|190,000; 500k 0|0|443,655|440,000.
- Reversion before ADL: 100k ubd 43,655; 80k ubd 23,655; 50k ubd 3,655 (credit fully repaid; backstop equity +10,000 kept). The insurance-refund branch was NOT exercised (insurance was 0 in every scenario).
- ADL at 500k after recording: clears 125,000 only (ubd 443,655 -> 318,655), backstop then flat; remaining 318,655 cannot be ADL'd (no inventory).
- ADL-2 repro with the slack check: t1 equity 5,660.37 >= old mm 5,660 (BTC left 0.4801, ETH short unchanged): passes.
- Fuzz group C with `STRESS_KNOWN_GAPS=1` (seed 20261113, runs 40, len 22): **passes** on the prototype (baseline fails). Re-run once after adding the ADL-2 check: passes.
- Full `test/stress.test.js` in default mode on the prototype (before the ADL-2 check): 18 passing, 1 failing: group A, P3a "adlDebt[1] delta ... != badDebt ..." at counterexample step 9 -- an expected harness mismatch (the harness does not know sync-recorded debt), not evidence of a contract bug, but also not proven to be only that (the counterexample was not analysed further). `exchange`, `isolated_adl`, `governance`, `twap`: 48 passing before the ADL-2 patch; `exchange` + `isolated_adl`: 30 passing after.
- Sizes (deployed bytes): PerpExchange 19,954; PerpExtras 18,356; PerpTrading 19,214; PerpLiquidation 13,768; PerpAdl 13,597; PerpTwap 10,326 (Extras/Twap changed only through shared base). Gas (stress gas tests, per-target sync): liquidate 1,339,062 -> 1,353,104 (3 mkts), 1,706,791 -> 1,775,057 (16 mkts); adl(8) 690,915 -> 812,605 and 2,551,425 -> 3,200,798 (before ADL-2 check; ADL-2 adds its own risk pass).

8.3 NOT run / not verified: Foundry suites (`forge` never run); the insurance-draw path with non-zero insurance; adverse stale valuation path; `Delisted` sync; ADL with a raised ceiling (so the claim that a 100% ceiling clears the 440k is only an argument from the zero-sum: concession per target <= its unrealised profit, and Σ profits of the opposite side >= backstop loss; the actual `_adlOne` rounding and ranking were not exercised); phase 2 (no code, gas figures are estimates); `withdraw` hook; hook in `_executeFill` only exercised by the existing suites (no new test targeted it); multi-seed fuzz; long-run keeper behaviour; any behaviour on a real oracle/sequencer.

## 9. Risks, open questions, caveats

Risks
- **R1 Run window (not fixed by this design).** Recorded `ubd` means claims exceed USDC. Profitable accounts can still withdraw realised profit. A withdrawal gate (e.g. block `withdraw` of amounts above `collateral` not backed by funded buckets while `ubd > insurance`, or pro-rata haircut) fixes the run but introduces liveness/griefing (anyone able to create bad debt can freeze withdrawals). Left to the user (Q2).
- **R2 Insurance becomes volatile**: it now moves with unrealised backstop PnL; frontends/analytics that treat it as monotone will mislead. Refund path only exercised for debt.
- **R3 Keeper dependence** for `syncBackstop` and ADL; stale sync is bounded by hooks in liquidate/adl/withdraw but not by time.
- **R4 Adverse stale valuation** can over-record debt when a feed is down for a long time, depleting insurance temporarily; a prolonged outage could cause irreversible effects if ADL runs on over-recorded debt (ADL requires a valid mark for the market it acts on, so the affected market is excluded, but other markets can consume the spill-over). Mitigation: disable spill-over from sync-originated debt while any backstop market is stale (not prototyped).
- **R5 Stack-too-deep under viaIR** forced external self-calls in PerpAdl; real implementation may need small refactors. Under 24,576 B everywhere, but PerpTrading (19.2 KB) loses most of its headroom if the fill hook is kept.
- **R6 Global-pool ADL** socialises across markets; legal/product implications for "your profit was haircut for another market's loss".
- **R7 Gas of sync** at 16 held backstop markets: ~+68k per liquidation, +650k for an 8-target ADL if per-target; must be once per call.
- **R8 The existing test predicate and Foundry check for BACKSTOP-1 are themselves wrong** (counted pre-existing recorded debt as a new deficit); fixing the predicate is part of the work, and any claim of "test flipped to required" must state that the predicate changed.
- **R9 Phase 2 cannot hard-cap exposure** (2.1). Gap risk (move > insurance + ADL capacity inside one oracle update) remains.
- Not audited; interaction with `globalPaused` (blocks ADL and `takeBackstop`, not liquidation) means debt can grow during a pause; consider allowing `syncBackstop` during pause (yes in the design: it is not gated).

Open questions for the user
- **Q1** ADL premium ceiling: keep 25% of mark (debt above that is only `recapitalize`-able, as in the 318,655 residual) or allow up to 100% of the target's profit (never below break-even) for backstop-originated debt? Affects how much of the loss winners bear.
- **Q2** Withdrawal behaviour while `ubd > 0`: allow (today), pause above a threshold, or haircut?
- **Q3** Accept global-pool (cross-market) ADL socialisation (4.2 ii), or keep debt strictly per market and require recapitalisation?
- **Q4** Is `insurance` allowed to be drawn automatically by backstop MTM (credit line), or must it stay governed (`rebalanceBackstop` only) with sync recording everything to `ubd` instead? (The latter is safer for oracle spikes, worse for ADL churn.)
- **Q5** Who operates the backstop (`BACKSTOP_ROLE`) after phase 1: should discretionary `backstopPlace` remain once an auction exists?
- **Q6** Taker fee on `takeBackstop`, and whether auction prices use the index (recommended) or the clamped mark.
- **Q7** Should `liquidate` be blocked (or its size reduced) when the backstop is `Forced`? Not recommended (2.1), but it is a product decision.

Caveats
- Gas and size numbers other than section 8 are estimates.
- The design assumes the single-oracle-per-market model in this repo; a median/multi-source oracle changes the stale rule inputs.
- The prototype was never reviewed beyond the tests above; do not copy it as production code (e.g. `bsCredit` is not reset when flat, repay loops are unoptimised, sync is called per ADL target).

## 10. Phase 1 as implemented: deviations from the design and results (2026-11-13)

Decisions taken from the user: Q1 hard ADL ceiling for backstop-originated debt (governed, default 100% of mark, never below the target's break-even); Q2 governed withdrawal limiter; Q3 global-pool ADL; Q4 automatic insurance draw, insurance refunded first.

Deviations from sections 2.2 / 4 / 6 (and why):
1. **`bsCredit` was dropped.** Repayment is bounded by two counters, `bsInsDrawn` (insurance charged, not refunded) and `bsDebt` (backstop-originated part of `unresolvedBadDebt`). ADL and `recapitalize` also reduce `bsDebt`, which keeps `bsDebt <= unresolvedBadDebt` and removes the "stale credit repays an unrelated debt" limitation (2.2 limitation 2 and 4).
2. **Hooks**: sync runs in `liquidate`, `settleDelisted`, once per `adl()` call (design flagged per-target as too costly), the router's `withdraw` (before the margin check and the limiter) and the permissionless `syncBackstop()`. There is NO hook in `_executeFill` (PerpTrading stays 17,573 B). A backstop realisation through `backstopPlace` is therefore recorded at the next hooked transaction or keeper sync, not at the fill.
3. **No `_settleAll(BACKSTOP)` inside sync**: unsettled backstop funding is subtracted in the equity formula instead, so `backstopEquity()` is a pure view and sync does not change funding indices.
4. **ADL**: debt sizing uses the global pool `unresolvedBadDebt` (not `adlDebt[market]`); ceiling is `adlHardPremBps` while `bsDebt > 0`, else `adlMaxPremBps`; clearing order own market first then ascending. The ADL-2 slack check is conservative (`equity - maintenance - 1`), SKIPS (event `AdlSkipped(target, market, slack)`) instead of reverting, and uses a single risk-evaluation site, `adlHealth` (public view, also used by `adlScore`). **No external self-call is needed**: the stack-too-deep of the prototype came from inlining `_riskLiq` at two call sites; routing both through one function fixed it. `adlScore` returns 0 for `equity <= 0`. A target with `sc == 0` in the keeper's list still reverts `not in profit` (unchanged behaviour); only slack failures skip.
5. **Withdrawal limiter (not in the original design, answer to R1/Q2)**: `principal[a]` (deposited, not-yet-withdrawn collateral; follows `transferInternal`), `wdGateThreshold` (default 100 USDC); while `unresolvedBadDebt > threshold`, `withdraw(amount)` needs `amount <= principal[a]` (`WithdrawGated`). Profit realised by trading is locked while debt is uncleared; a loser can still take out whatever it has left up to its principal. It is a heuristic: it does not prove `balance >= Σ positive buckets - ubd` at every instant. Router grew by ~2.5 KB.
6. **Governance**: `setAdlHardPremBps(bps)`: `adlMaxPremBps <= bps <= 10000`; admin any value in bounds, guardian may only lower. `setAdlMaxPremBps` now also requires `<= adlHardPremBps`. `setWithdrawGate(threshold)`: admin any value (`max uint` disables), guardian may only lower. No timelock is deployed by default (unchanged).
7. **Extra views**: `backstopEquity()`, `adlHealth(bytes32,uint8)`, `bsInsDrawn()`, `bsDebt()`, `adlHardPremBps()`, `wdGateThreshold()`, `principal(bytes32)`.
8. **Sizes** (hardhat, deployed bytes): PerpExchange 22,425 (+2,561); PerpExtras 18,495 (+219, shared base); PerpTrading 17,573 (+221); PerpLiquidation 13,835 (+1,617); PerpAdl 13,557 (+1,893); PerpTwap 10,465 (+219). All < 24,576. **Gas** (stress gas tests, before -> after): liquidate 3 markets 1,339,062 -> 1,348,404; 16 markets 1,706,791 -> 1,740,604; `adl` with 8 targets 3 markets 690,915 -> 886,650 (+28%), 16 markets 2,551,425 -> 3,553,154 (+39%; the per-target `adlHealth` risk pass dominates at 16 markets).

Test/harness changes (section 7 plan carried out): BACKSTOP-1 and ADL-2 tests are `it` (no `STRESS_KNOWN_GAPS` gating); the BACKSTOP-1 predicate is rewritten as described in 7.1; group C has no backstop tolerance and requires `collateral[BACKSTOP] >= 0` after a final sync (P11); group A makes P7x and P11 fatal; new harness bookkeeping for `BackstopSynced` (P9 formula, P8 insurance, per-market P3a delta); new `sync` step with an idempotence check. The group A P3a mismatch seen in the prototype was a HARNESS gap (the model attributed all debt created in a `liquidate` tx to the liquidated market; the sync attributes backstop debt to the market of its largest unrealised loss and may refund/repay), not a contract bug: the exact per-market delta is now `victim bad debt + sync debt attributed to that market`, with the sum identity checked by P3a/P9. Foundry: `checkProtocolBuffers` now evaluates the invariant on a snapshot after a hypothetical `syncBackstop()`; keeper/ADL handlers parse `BackstopSynced`; `syncBackstop`, `deposit`, `withdraw`, `rebalance` handler actions live in `StressAdl` (StressKeeper hit the 24,576 B limit enforced by foundry.toml).
New deterministic tests (test/stress.test.js): BACKSTOP-1 (repro + reversion + physical check), BACKSTOP-1b insurance draw/refund ordering, 1c stale-feed adverse valuation, 1d delisted sync, 1e permissionless/idempotent/paused/flat, 1f withdraw hook + limiter + principal tracking, 1g parameter bounds and guardian rules, 1h ADL ceiling, ADL-2, ADL-2b skip and score 0, ADL-3 cross-market debt clearing. Foundry: three deterministic tests in `StressFindingsTest`.
Mutation check: disabling `_syncBackstop` in a scratch copy makes the BACKSTOP-1 test and fuzz group C fail ("physical shortfall 182747673 ... backstop collateral -182747673"), so the harness does detect the original bug.

Observed behaviour worth knowing: with the default 100% ceiling, one ADL of the winner clears the whole 443,655 of the 500k repro; with the ceiling lowered to 2,500 it clears only 125,000 (tested).

Still NOT done / residual (do not read this phase as "solvency solved"): phase 2 (soft cap, `takeBackstop` auction, forced unwind); inventory size and duration are unbounded; the run window while debt is uncleared (limiter only damps it); sync recording needs a keeper or a hooked transaction; ADL candidate completeness is keeper-trusted; ADL cost grows with markets held (+39% at 16 markets); the Foundry P3/P11 invariant is evaluated after a hypothetical sync, so it proves recognition, not that every code path syncs (the JS group C final-flat check and the mutation test cover that); Foundry coverage of the stale/delisted/limiter paths is limited to the JS deterministic tests. Unverified: behaviour on a real chain, real oracles, indexer/keeper/frontend integration (not touched).

Verification results (all run on the real `contracts/`, 2026-11-13):
- `npx hardhat test` (all files): **82 passing, 0 failing**.
- `forge test`: **26 passed, 0 failed** (fuzz 256 runs; `InvariantTest` 128 runs x depth 250; `StressInvariantTest` 256 x 250, 13 invariants incl. P3/P11 after a hypothetical sync).
- Deeper Foundry run: `StressInvariantTest` at **640 runs x depth 500 (320,000 calls), `FOUNDRY_FUZZ_SEED=0xabc123`: passed** (inline `forge-config` comments pin the default 256x250, so the env vars FOUNDRY_INVARIANT_RUNS/DEPTH do NOT change the stress suite; the deep run temporarily edited the inline values and restored them). `InvariantTest` was run at 512 x 500 (256,000 calls): passed.
- JS stress, 5 groups (A, D, B, C, E), seeds with 40-60 runs, len<=22: seed 20261113 (40 runs) passed; seeds 777 and 424242 (60 runs) passed; seed 1 and seed 99 (60 runs): initially each exposed a HARNESS gap (not a contract defect): seed 1 group A: P8 "insurance decreased without liquidation" on `settleDelisted` (its write-off legitimately draws insurance; harness allow-list was missing `DelistedSettled`/`Fill`); seed 99 group E: `TypeError` from a cached state with a null mark in `doAdl` (state predated a feed refresh). Both fixed in `test/stress.test.js`; seed 1 then passed all 5 groups, seed 99 passed groups A, D, B, C and, after the fix, group E (re-run on group E only). Seed 20261113 was not re-run after the two harness fixes (the full `npx hardhat test` run did re-execute it: passed).
- Mutation check (scratch copy): `_syncBackstop` disabled -> deterministic BACKSTOP-1 test fails and fuzz group C fails with a physical shortfall.

## 11. Phase 2 as implemented: design (a)-lite (2026-11-14)

**What was built.** Per-market soft inventory threshold; permissionless Dutch auction at INDEX with a time-ramped discount; forced unwind at mark once above-threshold inventory persists past a maximum age; `backstopPlace` can no longer grow inventory past the threshold and is governance-gated. Everything is OFF by default (`softNotional == 0`), so deployments that do not configure it behave exactly as after phase 1.

| Piece | Where | Behaviour |
|---|---|---|
| `BackstopCfg` per market (`softNotional`, `maxDiscBps`, `dwell`, `ramp`, `maxAge`, `elevatedSince`) | `PerpBase` (appended storage) | `setBackstopCfg` (PerpLiquidation): admin bounds `maxDiscBps <= min(300, bandBps)`, `ramp >= 60 s`, `maxAge >= dwell + ramp`; guardian may only TIGHTEN an already enabled market (every field <= current, `softNotional > 0`), cannot enable or disable |
| Elevation clock `elevatedSince` | `PerpBase._refreshElev` | Lazy: started when notional (`\|size\| x mark`) first exceeds `softNotional`, cleared when it is at or below. Refreshed by `liquidate`, `adl`, `takeBackstop`, `unwindBackstop` and the permissionless `pokeBackstop(m)` |
| `takeBackstop(owner, sub, market, size, limitPx)` | PerpLiquidation | Taker trades against the backstop at `index x (1 + disc)` when the backstop is short (taker sells) or `index x (1 - disc)` when long (taker buys); rounded in the backstop's favour; `disc` is 0 during `dwell`, then linear over `ramp` up to `maxDiscBps`. Taker must pass the initial-margin check if its exposure grows (`Unhealthy`), pays `backstopTakeFeeBps` (0..10, default 0, governed, guardian may only lower) into `insurance`, and may take any lot-aligned part of the inventory. Blocked on `globalPaused`, Paused/OracleDegraded/Delisted markets and any stale feed (it uses `markPrice`, which reverts) |
| `unwindBackstop(targets, market)` | PerpAdl | Once `now >= elevatedSince + maxAge`: closes `\|inventory\| - softNotional/mark` (rounded UP to a lot, so the remainder ends at or below the threshold) against ranked profitable opposite positions at MARK with NO concession (same ranking, eligibility and ordering rules as `adl`; the target realises its ordinary PnL, no premium) |
| `backstopPlace` | PerpExtras | Reverts `BackstopCap` if `backstopPlaceOpen` is false (admin opens, guardian may only close), or if the call grew \|inventory\| and its notional exceeds the threshold |
| `liquidate` | unchanged | Stays enabled in every state of the above. There is deliberately NO hard size cap |

**Deviations from the design text.**
1. The auction runs on the INDEX, not on the book mark, as designed; but `takeBackstop` also requires a valid mark (stale feeds revert) so it can never trade against a stale oracle. Consequence: during an oracle outage the auction is dead and only phase-1 recognition (20% adverse valuation) works.
2. Unwind rounding goes UP to a lot (first implementation rounded down and left the market permanently 1 lot above the threshold, so the clock never cleared; found by the deterministic test).
3. `backstopPlace` growth check is a post-hoc revert after `placeFor` (cheaper than pre-simulating the fill). A side effect, seen in the tests: while the backstop is under-capitalised the margin check (`Unhealthy`) fires first, so the cap is the binding rule only once the backstop has equity.
4. The taker fee is a flat bps of notional, paid by the taker on top of the price (not folded into the price), and goes entirely to `insurance`. No keeper reward exists for `pokeBackstop` / `unwindBackstop` (see Risks).
5. The auction price is not clamped to the book mark: if mark and index diverge (within `bandBps`) a taker can gain at most `disc` + the mark/index basis. Bounded by `maxDiscBps <= min(300, bandBps)` plus the fee.

**Honest limits (read these).**
- **The cap is soft.** A single large liquidation can push inventory arbitrarily far above the threshold; the guarantee is only that, with live feeds and a working keeper, above-threshold inventory is offered at a bounded discount after `dwell`, and force-reduced at mark after `maxAge`. P3 in its strong form ("inventory <= threshold + auction lag") is NOT guaranteed on-chain: it depends on (i) a taker or keeper acting, (ii) enough profitable opposite positions existing for the unwind, (iii) the candidate list being complete (keeper-trusted, same as ADL), (iv) fresh feeds.
- The elevation clock can be reset by anybody who moves the backstop's inventory to exactly the threshold (e.g. a tiny take) and then lets the liquidation flow refill it. This extends `maxAge` by up to one dwell+ramp window per reset; it costs the resetter the discount they pay in margin/fee.
- Forced unwind at mark is a haircut-free close of PROFITABLE winners: it removes upside (they lose the position, not their PnL). Governance should treat `maxAge` as a user-facing risk parameter.
- The run window while recorded debt is uncleared is unchanged from phase 1: the auction transfers inventory loss to insurance/debt; it does not create USDC.
- Wash/griefing: a taker that buys at a discount and sells back on the book within the band gains at most the discount minus fees and the book spread; it cannot print more because the price is capped by `maxDiscBps <= bandBps`. Unverified against a real order flow; only the fuzz and deterministic tests cover it.

**Verification (see GAPS for numbers).** Deterministic hardhat tests `P2-*` (governance bounds, ramp, partial take, margin, fee-to-insurance exactness, long/short sides, unwind rounding and ranking, `backstopPlace`, pause, no external calls), JS fuzz steps `bscfg`/`bstake`/`bsforce` (price within `maxDisc` of the quote, exact inventory movement, fee = ceil(notional x bps), unwind price == mark, inventory never grows, ledger identity), Foundry handler actions `p2cfg`/`take`/`force` and invariant `P2`. Mutation checks on a scratch copy: discount cap, margin check, `maxAge` gate, fee crediting, `backstopPlace` gate, guardian-tighten-only each make at least one test fail.

## 12. Debt-attribution fix (2026-11-14)
**Flaw (live demo).** After `takeBackstop` on DEMO-USD (market id 3) cleared the backstop at a discount, the remaining loss was booked on `adlDebt[0]` instead of `adlDebt[3]`. `_backstopEquity()` returned the market with the largest unrealised loss and defaulted to 0 when the backstop was flat, and `_syncBackstop` booked the new debt there. A flat backstop is exactly the state after a take/unwind/liquidation that closes inventory at a realised loss, so the bug hit the main phase-2 path. It did not break `ubd == sum(adlDebt)` or solvency (ADL clears the global pool), only attribution, and it misled monitoring and `adl`'s own-market-first clearing.

**Fix.** `_syncBackstopAt(uint8 hint)` (PerpBase): the hint market gets the new debt. Hints: `liquidate` -> liquidated market; `settleDelisted` -> its market; `adl()` and `unwindBackstop` -> their market; `takeBackstop` -> its market (the sync already runs inside the same transaction, after the fills, so the discount the take realises is recorded at the take's market in that transaction). Without context (`syncBackstop()`, `withdraw`) the old worst-loss rule applies while the backstop holds inventory with an unrealised loss; otherwise the market last named by a context sync (`lastBsMarket`, appended internal storage). `_backstopEquity` now returns 255 when no inventory has an unrealised loss, so the default is no longer silently 0. No ABI change; PerpExchange +87 B, PerpLiquidation +1,003 B, PerpAdl +104 B.

**Deviation / limit.** A context sync attributes the whole deficit it recognises to the acting market. If the deficit actually came from mark-to-market on inventory in a different market that nobody synced earlier, it is booked on the acting market. This is deliberate (cheap, explainable) and harmless to solvency because debt is a global pool; it only affects which market's record clears first.

**Tests.** Hardhat `ATTR-1` (demo: market id 2, long liquidated at mark with price held, elevated, taken at 200 bps after dwell, insurance smaller than the loss; asserts `adlDebt[2] > 0`, others 0, `ubd == sum`, `bsDebt <= ubd`, stable after a later sync), `ATTR-2` (liquidate that buys back a backstop short at a realised loss), `ATTR-3` (`unwindBackstop`), `ATTR-4` (`settleDelisted`). Fuzz property P12 (JS `attrCheck` in liquidate/take/unwind/adl; Foundry `invariant_P12_debtAttribution`): any `BackstopSynced` with `toDebt > 0` inside a call that acts on market m names m. Mutation: restoring the default-0 attribution fails all four ATTR tests and the JS fuzz (P12).

