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

    event DelistedSettled(bytes32 indexed acct, uint8 indexed market, int256 closedSize, uint64 price);
}
