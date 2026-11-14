// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IOracle} from "./IOracle.sol";
import {PerpBase} from "./PerpBase.sol";

/// @notice Auto-deleveraging and recapitalisation. Executed ONLY via delegatecall from PerpExchange.
///
/// ADL model (see docs/SPEC.md): when liquidation leaves unresolved bad debt D after the insurance fund is exhausted,
/// `adlDebt[market]` records it. The backstop holds the liquidated inventory (size B) at mark. Profitable counterparties
/// (opposite side to the backstop) are force-closed against the backstop at mark +/- prem, prem = D / B (capped by
/// adlMaxPremBps and by the target's break-even). The price concession X = size*prem is NOT paid to anyone: it is
/// removed from unresolvedBadDebt, so claims are restored to match held USDC. Targets keep their remaining profit.
///
/// RANKING LIMITATION: the chain cannot enumerate all accounts. The caller supplies an ordered candidate list; the
/// contract enforces non-increasing score (ties: ascending account key) within that list, eligibility (in profit, opposite
/// to backstop) and bounds, but cannot prove no better-ranked account was omitted. Keepers are therefore trusted for
/// completeness (not for amounts), and a monitoring service must publish the true ranking.
contract PerpAdl is PerpBase {
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;

    uint256 public constant MAX_ADL_TARGETS = 8;

    event AdlExecuted(bytes32 indexed target, uint8 indexed market, uint128 size, uint64 price, uint256 debtCleared);
    event Recapitalized(uint8 indexed market, address indexed from, uint256 amount);

    event AdlSkipped(bytes32 indexed target, uint8 indexed market, uint256 slack);

    /// @notice Equity and maintenance requirement as ADL sees them (cross: all cross markets via `_riskLiq`; isolated: its own bucket).
    ///         Single risk-evaluation site shared by `adlScore` and the target-health check (inlining `_riskLiq` twice overflows the
    ///         viaIR stack, so both callers go through this one function).
    function adlHealth(bytes32 a, uint8 market) public view returns (int256 eq, uint256 mm) {
        if (positions[a][market].isolated) (eq,, mm) = _isoRisk(a, market); else (eq,, mm) = _riskLiq(a, market);
    }

    /// @notice ADL priority score (higher = deleveraged first) = pnl% of entry notional x leverage, both in bps.
    ///         0 if not in profit OR if equity <= 0: an insolvent account must be liquidated, never deleveraged (and never ranked first).
    function adlScore(bytes32 a, uint8 market) public view returns (uint256) {
        Position storage p = positions[a][market];
        if (p.size == 0) return 0;
        uint256 mk = markPrice(market);
        int256 upnl = _fdiv(p.size * int256(mk) - p.basis, int256(BASIS_SCALE));
        if (upnl <= 0) return 0;
        uint256 entryN = _abs(p.basis) / BASIS_SCALE;
        if (entryN == 0) return 0;
        (int256 eq,) = adlHealth(a, market);
        if (eq <= 0) return 0;
        uint256 pnlBps = uint256(upnl) * BPS / entryN;
        uint256 levBps = _notionalFloor(_abs(p.size), mk) * BPS / uint256(eq);
        return pnlBps * levBps / BPS;
    }

    /// @notice Keeper supplies a ranked list. Targets that cannot absorb a concession without dropping below their maintenance
    ///         requirement are SKIPPED (event `AdlSkipped`), they never revert the batch. The backstop is synced once at the end.
    function adl(bytes32[] calldata targets, uint8 market) external nonReentrant {
        Market storage M = markets[market];
        if (M.state == State.Paused || M.state == State.OracleDegraded) revert MarketRestricted();
        if (unresolvedBadDebt == 0) revert BadParam("no adl debt");
        if (targets.length == 0 || targets.length > MAX_ADL_TARGETS) revert BadParam("targets");
        uint256 prevScore = type(uint256).max;
        bytes32 prevKey;
        for (uint256 i; i < targets.length && unresolvedBadDebt > 0; i++) {
            bytes32 t = targets[i];
            uint256 sc = adlScore(t, market);
            if (i > 0 && !(sc < prevScore || (sc == prevScore && t > prevKey))) revert BadParam("not ranked");
            prevScore = sc; prevKey = t;
            _settleAll(t);
            if (sc == 0) revert BadParam("not in profit");
            _adlOne(t, market);
        }
        _syncBackstopAt(market);
        _refreshElev(market, markPrice(market));
    }

    /// @notice Forced unwind (phase 2): once the backstop has been above its soft threshold for `maxAge` seconds, ranked profitable
    ///         opposite-side accounts are closed AT MARK (no concession: they keep all profit) against the backstop until its inventory is
    ///         back at the threshold. Same keeper-supplied ranking rules as `adl`; completeness is keeper-trusted. Never blocks liquidation.
    function unwindBackstop(bytes32[] calldata targets, uint8 market) external nonReentrant {
        Market storage M = markets[market];
        if (M.state == State.Paused || M.state == State.OracleDegraded || M.state == State.Delisted) revert MarketRestricted();
        if (targets.length == 0 || targets.length > MAX_ADL_TARGETS) revert BadParam("targets");
        uint256 mk = markPrice(market);
        _refreshElev(market, mk);
        BackstopCfg storage c = backstopCfg[market];
        if (c.elevatedSince == 0 || block.timestamp < uint256(c.elevatedSince) + c.maxAge) revert BadParam("not due");
        int256 bs = positions[BACKSTOP][market].size;
        uint256 keep = uint256(c.softNotional) * SIZE_SCALE / mk;
        uint256 left = _abs(bs) > keep ? _abs(bs) - keep : 0;
        left = ((left + M.lot - 1) / M.lot) * M.lot; // round UP to a lot so the remainder ends at or below the threshold
        if (left > _abs(bs)) left = (_abs(bs) / M.lot) * M.lot;
        if (left == 0) revert BadParam("nothing to unwind");
        _settleMarket(BACKSTOP, market);
        uint256 prevScore = type(uint256).max;
        bytes32 prevKey;
        for (uint256 i; i < targets.length && left > 0; i++) {
            bytes32 t = targets[i];
            uint256 sc = adlScore(t, market);
            if (i > 0 && !(sc < prevScore || (sc == prevScore && t > prevKey))) revert BadParam("not ranked");
            prevScore = sc; prevKey = t;
            if (sc == 0) revert BadParam("not in profit");
            _settleAll(t);
            Position storage tp = positions[t][market];
            if (t == BACKSTOP || (tp.size > 0) == (bs > 0)) revert BadParam("not opposite to backstop");
            uint256 sz = _abs(tp.size) < left ? _abs(tp.size) : left;
            sz = (sz / M.lot) * M.lot;
            if (sz == 0) continue;
            int256 q = int256(sz);
            bool tl = tp.size > 0;
            _applyFill(t, market, tl ? -q : q, mk);
            _applyFill(BACKSTOP, market, tl ? q : -q, mk);
            left -= sz;
            emit BackstopUnwound(market, t, uint128(sz), uint64(mk));
        }
        _syncBackstopAt(market);
        _refreshElev(market, mk);
    }

    function _adlOne(bytes32 t, uint8 market) internal {
        Position storage tp = positions[t][market];
        int256 bs = positions[BACKSTOP][market].size;
        if (t == BACKSTOP || bs == 0 || (tp.size > 0) == (bs > 0)) revert BadParam("not opposite to backstop");
        uint256 mk = markPrice(market);
        uint256 debt = unresolvedBadDebt; // global pool: own-market records are cleared first, then the rest (see _clearAdlDebt)
        uint256 prem = debt * SIZE_SCALE / _abs(bs);
        {
            // ordinary debt: adlMaxPremBps; while backstop-originated debt is outstanding: adlHardPremBps. Break-even always binds.
            uint256 cap = mk * (bsDebt > 0 ? adlHardPremBps : adlMaxPremBps) / BPS;
            if (prem > cap) prem = cap;
            uint256 entry = _abs(tp.basis) / _abs(tp.size); // break-even price; never push the target below it
            uint256 room = tp.size > 0 ? (mk > entry ? mk - entry : 0) : (entry > mk ? entry - mk : 0);
            if (prem > room) prem = room;
        }
        if (prem == 0) revert BadParam("no room");
        bool tl = tp.size > 0; // target side captured BEFORE the fills: the first fill can zero tp.size
        uint256 sz = (debt * SIZE_SCALE + prem - 1) / prem;
        {
            uint256 mx = _abs(tp.size) < _abs(bs) ? _abs(tp.size) : _abs(bs);
            if (sz > mx) sz = mx;
        }
        // ADL-2: the concession sz*prem must leave the target at or above its CURRENT maintenance over ALL its cross markets
        {
            (int256 e, uint256 mmr) = adlHealth(t, market);
            uint256 slack = e > int256(mmr) + 1 ? uint256(e - int256(mmr)) - 1 : 0;
            if (sz * prem / SIZE_SCALE > slack) sz = slack * SIZE_SCALE / prem;
            sz = (sz / markets[market].lot) * markets[market].lot;
            if (sz == 0) {
                if (slack == 0 || slack * SIZE_SCALE / prem < markets[market].lot) { emit AdlSkipped(t, market, slack); return; }
                revert BadParam("lot");
            }
        }
        _settleMarket(BACKSTOP, market); // sync the backstop's funding index before it takes inventory
        int256 q = int256(sz);
        _applyFill(t, market, tl ? -q : q, tl ? mk - prem : mk + prem); // target's concession is in the unfavourable direction
        _applyFill(BACKSTOP, market, tl ? q : -q, mk);
        uint256 x = sz * prem / SIZE_SCALE;
        if (x > debt) x = debt;
        unresolvedBadDebt -= x;
        _clearAdlDebt(market, x);
        bsDebt -= x < bsDebt ? x : bsDebt;
        emit AdlExecuted(t, market, uint128(sz), uint64(tl ? mk - prem : mk + prem), x);
    }

    /// @notice Anyone may repay unresolved bad debt with USDC (e.g. governance treasury, recapitalisation).
    function recapitalize(uint8 market, uint256 amount) external nonReentrant {
        uint256 d = adlDebt[market];
        if (amount > d) amount = d;
        if (amount == 0) revert BadParam("nothing to repay");
        uint256 b = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - b != amount) revert BadParam("fee-on-transfer unsupported");
        totalDeposited += amount;
        adlDebt[market] = d - amount;
        unresolvedBadDebt -= amount < unresolvedBadDebt ? amount : unresolvedBadDebt;
        bsDebt -= amount < bsDebt ? amount : bsDebt;
        emit Recapitalized(market, msg.sender, amount);
    }
}
