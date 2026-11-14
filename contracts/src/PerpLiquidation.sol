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

/// @notice Permissionless liquidation. Executed ONLY via delegatecall from PerpExchange.
contract PerpLiquidation is PerpBase {
    using EnumerableSet for EnumerableSet.UintSet;
    // ================================================================== liquidation
    /// @notice Permissionless. Valid prices required for EVERY position of the account (else revert).
    ///         Cancels open orders, transfers a bounded fraction of `market` position to the backstop at mark,
    ///         charges the liquidation fee, covers bad debt from insurance, otherwise records unresolved bad debt.
    function liquidate(bytes32 a, uint8 market) external nonReentrant {
        require(a != BACKSTOP, "backstop");
        // NOTE: globalPaused does NOT block liquidation (pause stops new risk, not risk reduction)
        Market storage M = markets[market];
        if (M.state == State.Paused || M.state == State.OracleDegraded) revert MarketRestricted();
        _settleAll(a);
        bool iso = positions[a][market].isolated;
        // cross: the liquidated market needs a valid mark; other stale markets are valued in the account's favour (_riskLiq);
        // isolated: only this market's position matters
        (int256 eq,, uint256 mm) = iso ? _isoRisk(a, market) : _riskLiq(a, market);
        if (eq >= int256(mm)) revert NotLiquidatable();

        _cancelAllFor(a, CancelReason.Liquidation);
        Position storage s = positions[a][market];
        int256 pos = s.size;
        if (pos == 0) revert BadParam("no position");

        uint256 px = markPrice(market);
        uint256 abs_ = _abs(pos);
        uint256 closeSz = _notionalFloor(abs_, px) <= fullCloseNotional ? abs_ : abs_ * closeFactorBps / BPS;
        closeSz = (closeSz / M.lot) * M.lot;
        if (closeSz == 0 || closeSz > abs_) closeSz = abs_;

        int256 sq = int256(closeSz);
        _settleMarket(BACKSTOP, market); // sync the backstop's funding index before it takes inventory
        _applyFill(a, market, pos > 0 ? -sq : sq, px);
        _applyFill(BACKSTOP, market, pos > 0 ? sq : -sq, px);
        if (M.oi > M.maxOI) { /* backstop takeover may exceed cap by design; flagged by monitoring */ }

        uint256 fee = _ceilBps(_notionalFloor(closeSz, px), liqFeeBps);
        uint256 keeperCut = fee * keeperShareBps / BPS;
        _credit(a, market, -int256(fee));
        insurance += fee - keeperCut;
        collateral[_register(msg.sender, 0)] += int256(keeperCut);

        uint256 bad = _writeOffIfFlat(a, market);
        _syncBackstop(); // recognise the backstop's mark-to-market deficit (BACKSTOP-1)
        _refreshElev(market, px); // phase 2: start the elevation clock if the backstop is above its soft threshold
        emit Liquidated(a, market, msg.sender, uint128(closeSz), uint64(px), fee, bad);
    }



    /// @notice Final settlement of a Delisted market: closes the account's position at the frozen settle price against the
    ///         backstop (which nets to flat once every account has settled). Permissionless. Accounts that are insolvent at the
    ///         settle price produce bad debt exactly as in liquidation - governance must liquidate/reduce first (ReduceOnly phase).
    function settleDelisted(bytes32 a, uint8 market) external nonReentrant {
        require(a != BACKSTOP, "backstop");
        Market storage M = markets[market];
        if (M.state != State.Delisted) revert MarketRestricted();
        _settleMarket(a, market);
        uint256[] memory ids = openOrders[a].values();
        for (uint256 i; i < ids.length; i++) if (orders[uint64(ids[i])].market == market) _remove(uint64(ids[i]), CancelReason.Liquidation);
        int256 pos = positions[a][market].size;
        if (pos == 0) revert BadParam("no position");
        _settleMarket(BACKSTOP, market);
        _applyFill(a, market, -pos, M.settlePrice);
        _applyFill(BACKSTOP, market, pos, M.settlePrice);
        _writeOffIfFlat(a, market); // insolvent at the settle price: record the loss exactly as liquidation does
        _syncBackstop();
        emit DelistedSettled(a, market, pos, M.settlePrice);
    }

    /// @notice Permissionless. Records the loss of an account whose bucket (isolated margin of `market`, or cross collateral when
    ///         it holds no cross position) is FLAT and NEGATIVE: insurance first, remainder to unresolvedBadDebt/adlDebt[market].
    ///         Cannot touch a healthy or non-negative bucket (reverts), so it cannot be used to hurt anyone.
    function writeOff(bytes32 a, uint8 market) external nonReentrant {
        require(a != BACKSTOP, "backstop");
        if (!markets[market].exists) revert BadParam("market");
        _settleAll(a);
        Position storage s = positions[a][market];
        int256 before_ = s.isolated ? s.isoMargin : collateral[a];
        _writeOffIfFlat(a, market);
        if ((s.isolated ? s.isoMargin : collateral[a]) == before_) revert BadParam("nothing to write off");
    }

    /// @notice Permissionless and idempotent. Marks the backstop to market and records any deficit (insurance first, then
    ///         unresolvedBadDebt/adlDebt) or repays earlier draws when its equity recovered. Not blocked by pauses.
    function syncBackstop() external nonReentrant { _syncBackstop(); }

    /// @notice Backstop equity at current marks (stale feeds valued adversely) and the unrecognised deficit, if any.
    function backstopEquity() external view returns (int256 equity) { (equity,) = _backstopEquity(); }

    // ================================================================== phase 2: backstop inventory management
    event BackstopCfgSet(uint8 indexed market, uint128 softNotional, uint16 maxDiscBps, uint32 dwell, uint32 ramp, uint32 maxAge);
    event BackstopTakeFeeSet(uint32 bps);
    event BackstopPlaceOpenSet(bool open);

    /// @notice Per-market backstop inventory parameters. softNotional == 0 disables the market's phase-2 logic.
    ///         Admin (timelock): any value within bounds (maxDiscBps <= min(bandBps, 300), ramp >= 60, maxAge >= dwell + ramp).
    ///         Guardian: may only TIGHTEN an enabled market: every field <= its current value and softNotional > 0.
    function setBackstopCfg(uint8 m, uint128 soft, uint16 maxDisc, uint32 dwell, uint32 ramp, uint32 maxAge) external {
        Market storage M = markets[m];
        if (!M.exists) revert BadParam("market");
        BackstopCfg storage c = backstopCfg[m];
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender) || c.softNotional == 0 || soft == 0 || soft > c.softNotional
                || maxDisc > c.maxDiscBps || dwell > c.dwell || ramp > c.ramp || maxAge > c.maxAge) revert NotAuthorized();
        }
        if (maxDisc > 300 || maxDisc > M.bandBps || ramp < 60 || uint256(maxAge) < uint256(dwell) + ramp) revert BadParam("backstop cfg");
        c.softNotional = soft; c.maxDiscBps = maxDisc; c.dwell = dwell; c.ramp = ramp; c.maxAge = maxAge;
        c.elevatedSince = 0; // re-evaluated by the next poke / liquidation
        emit BackstopCfgSet(m, soft, maxDisc, dwell, ramp, maxAge);
    }

    /// @notice Taker fee (bps of notional, paid into insurance) on takeBackstop. Admin: 0..10; guardian: may only lower.
    function setBackstopTakeFee(uint32 bps) external {
        if (bps > 10) revert BadParam("fee");
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && (!hasRole(GUARDIAN_ROLE, msg.sender) || bps >= backstopTakeFeeBps)) revert NotAuthorized();
        backstopTakeFeeBps = bps;
        emit BackstopTakeFeeSet(bps);
    }

    /// @notice Discretionary `backstopPlace` switch. Guardian may only close it; only admin may reopen.
    function setBackstopPlaceOpen(bool open) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && (!hasRole(GUARDIAN_ROLE, msg.sender) || open)) revert NotAuthorized();
        backstopPlaceOpen = open;
        emit BackstopPlaceOpenSet(open);
    }

    /// @notice Permissionless: refresh the elevation clock of `market` with the current mark.
    function pokeBackstop(uint8 market) external {
        _refreshElev(market, markPrice(market));
    }

    /// @dev Discount (bps) of the Dutch auction at `since`: 0 during `dwell`, then linear to maxDiscBps over `ramp`.
    function _discBps(BackstopCfg storage c) internal view returns (uint256) {
        uint256 el = block.timestamp - c.elevatedSince;
        if (el <= c.dwell) return 0;
        uint256 r = el - c.dwell;
        return r >= c.ramp ? c.maxDiscBps : uint256(c.maxDiscBps) * r / c.ramp;
    }

    /// @notice Current auction quote. `takerSells`: the backstop is SHORT, the taker sells to it at index x (1 + disc); else the taker
    ///         buys from the long backstop at index x (1 - disc). Rounded in the backstop's favour. `active` is false when not elevated.
    function backstopAuction(uint8 market) external view returns (bool active, bool takerSells, uint256 price, uint256 discBps, uint256 size) {
        BackstopCfg storage c = backstopCfg[market];
        int256 bs = positions[BACKSTOP][market].size;
        (uint256 idx, bool ok) = _index(market);
        if (!ok || bs == 0 || c.softNotional == 0) return (false, false, 0, 0, 0);
        uint256 n = _notionalFloor(_abs(bs), _markFrom(market, idx));
        // elevated if the stored clock is running, or inventory is above the threshold and the clock has not been started yet (price = index)
        if (c.elevatedSince == 0 && n <= c.softNotional) return (false, false, 0, 0, 0);
        discBps = c.elevatedSince == 0 ? 0 : _discBps(c);
        takerSells = bs < 0;
        price = takerSells ? idx * (BPS + discBps) / BPS : (idx * (BPS - discBps) + BPS - 1) / BPS;
        return (true, takerSells, price, discBps, _abs(bs));
    }

    /// @notice Permissionless Dutch auction for backstop inventory in an elevated market. Price = INDEX x (1 +/- disc(t)), never the book
    ///         mark. Taker is `owner/sub` (owner or scoped agent). The taker must pass the initial-margin check if its exposure grows, pays
    ///         `backstopTakeFeeBps` into insurance, and may take any lot-aligned part of the inventory. The backstop's realised loss is
    ///         recognised by the phase-1 sync (insurance first).
    function takeBackstop(address owner, uint8 sub, uint8 market, uint128 size, uint64 limitPx) external nonReentrant {
        bytes32 a = _register(owner, sub);
        _authTradeScoped(a, market, size, limitPx);
        if (globalPaused) revert MarketRestricted();
        Market storage M = markets[market];
        if (!M.exists) revert BadParam("market");
        if (M.state == State.Paused || M.state == State.OracleDegraded || M.state == State.Delisted) revert MarketRestricted();
        uint256 mk = markPrice(market); // reverts OracleDegraded on a stale feed: the auction never runs on stale prices
        _refreshElev(market, mk);
        BackstopCfg storage c = backstopCfg[market];
        if (c.elevatedSince == 0) revert BadParam("not elevated");
        int256 bs = positions[BACKSTOP][market].size;
        if (size == 0 || size > _abs(bs) || size % M.lot != 0) revert BadParam("size");
        _settleAll(a);
        _settleMarket(BACKSTOP, market);
        (uint256 idx,) = _index(market);
        uint256 d = _discBps(c);
        bool takerSells = bs < 0;
        uint256 px = takerSells ? idx * (BPS + d) / BPS : (idx * (BPS - d) + BPS - 1) / BPS;
        if (takerSells ? px < limitPx : px > limitPx) revert BadParam("limit");
        int256 before_ = positions[a][market].size;
        uint128 oi0 = M.oi;
        int256 q = takerSells ? -int256(uint256(size)) : int256(uint256(size));
        _applyFill(a, market, q, px);
        _applyFill(BACKSTOP, market, -q, px);
        if (M.oi > M.maxOI && M.oi > oi0) revert OICap();
        uint256 fee = _ceilBps(_notionalFloor(size, px), backstopTakeFeeBps);
        if (fee > 0) { _credit(a, market, -int256(fee)); insurance += fee; }
        int256 after_ = positions[a][market].size;
        if (after_ != 0 && (before_ == 0 || (before_ > 0) != (after_ > 0) || _abs(after_) > _abs(before_)) && !_marginOK(a, market)) revert Unhealthy();
        _writeOffIfFlat(a, market);
        _syncBackstop();
        _refreshElev(market, mk);
        emit BackstopTaken(market, owner, a, takerSells, size, uint64(px), d, fee);
    }

    event DelistedSettled(bytes32 indexed acct, uint8 indexed market, int256 closedSize, uint64 price);
}
