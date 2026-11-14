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

/// @notice Order entry, matching, cancels, conditional orders. Executed ONLY via delegatecall from PerpExchange.
contract PerpTrading is PerpBase {
    using EnumerableSet for EnumerableSet.UintSet;
    // ================================================================== order entry
    function placeOrder(address owner, uint8 sub, OrderParams calldata p) external nonReentrant returns (uint64 id, uint128 filled) {
        bytes32 a = _register(owner, sub);
        _authTradeScoped(a, p.market, p.size, p.price);
        return _place(a, p);
    }

    /// @dev Internal entry for sibling modules (signed/conditional/TWAP). Reachable only by self-call from the core.
    ///      Deliberately not nonReentrant: the calling module's entry point holds no lock and makes no token transfers.
    function placeFor(bytes32 a, OrderParams calldata p) external returns (uint64 id, uint128 filled) {
        require(msg.sender == address(this), "self only");
        return _place(a, p);
    }

    function _place(bytes32 a, OrderParams memory p) internal returns (uint64 id, uint128 filled) {
        if (globalPaused) revert MarketRestricted();
        Market storage M = markets[p.market];
        if (!M.exists) revert BadParam("market");
        if (M.state == State.Paused || M.state == State.OracleDegraded || M.state == State.Delisted) revert MarketRestricted();
        if (p.price == 0 || p.price % M.tick != 0) revert BadParam("tick");
        if (p.size == 0 || p.size % M.lot != 0 || p.size > M.maxOrderSize) revert BadParam("lot/size");
        if (p.expiry != 0 && p.expiry <= block.timestamp) revert Expired();
        if (p.cloid != 0) {
            if (cloidUsed[a][p.cloid]) revert DuplicateClientId();
            cloidUsed[a][p.cloid] = true;
        }
        markPrice(p.market); // revert on degraded oracle: no risk-taking against untrusted prices
        _settleAll(a);

        int256 before_ = positions[a][p.market].size;
        uint128 size = p.size;
        bool reducing = (p.isBuy && before_ < 0) || (!p.isBuy && before_ > 0);
        bool restricted = M.state == State.ReduceOnly || M.state == State.Recovery;
        if (p.reduceOnly || restricted) {
            if (!reducing) revert ReduceOnlyViolation();
            uint256 pos = _abs(before_);
            if (size > pos) size = uint128(pos);
            p.reduceOnly = true; // keeps resting remainder clipped at fill time too
        }
        if (!p.reduceOnly && _notionalFloor(size, p.price) < M.minNotional) revert BadParam("min notional");

        id = nextOrderId++;
        emit OrderAccepted(id, a, p.market, p.isBuy, p.price, size, p.tif, p.reduceOnly, p.cloid);

        uint64 topOpp = bestPrice[p.market][!p.isBuy];
        if (p.tif == TIF.PostOnly && topOpp != 0 && (p.isBuy ? topOpp <= p.price : topOpp >= p.price)) revert PostOnlyCross();

        uint128 remaining = size;
        bool truncated;
        {
            uint256 touches; uint256 lvls;
            uint64 lp = topOpp;
            while (remaining > 0 && lp != 0 && (p.isBuy ? lp <= p.price : lp >= p.price)) {
                if (lvls == MAX_LEVELS_PER_TX) { truncated = true; break; }
                lvls++;
                uint64 oid = levels[p.market][!p.isBuy][lp].head;
                while (remaining > 0 && oid != 0) {
                    if (touches == MAX_TOUCHES_PER_TX) { truncated = true; break; }
                    touches++;
                    uint64 nxt = orders[oid].next;
                    uint128 q = _tryFill(oid, a, p, remaining);
                    remaining -= q;
                    oid = nxt;
                }
                if (truncated) break;
                lp = bestPrice[p.market][!p.isBuy];
            }
        }
        filled = size - remaining;

        // remainder handling
        if (remaining > 0) {
            if (p.tif == TIF.FOK) revert FokUnfilled();
            if ((p.tif == TIF.GTC || p.tif == TIF.PostOnly) && !truncated) { // PostOnly never crossed (checked above), so it rests
                if (openOrders[a].length() >= MAX_OPEN_ORDERS) revert TooManyOrders();
                uint128 rsv = _orderReserve(p.market, p.price, remaining, p.reduceOnly);
                orders[id] = Order(a, remaining, rsv, p.price, p.expiry, 0, 0, p.cloid, p.market, p.isBuy, p.reduceOnly);
                _reserveAdd(a, p.market, rsv);
                _insert(id);
                emit OrderRested(id, remaining);
            } else {
                if (truncated) emit OrderTruncated(id, remaining); // GTC hitting bounds: remainder is NOT rested (never crosses the book)
                emit OrderCanceled(id, CancelReason.User, remaining);
            }
        }

        // taker margin: required if exposure increased, flipped, or margin is reserved
        int256 after_ = positions[a][p.market].size;
        bool riskUp = after_ != 0 && ((before_ == 0) || ((before_ > 0) != (after_ > 0)) || _abs(after_) > _abs(before_));
        if (riskUp || (remaining > 0 && orders[id].acct == a && orders[id].reserve > 0)) {
            if (!_marginOK(a, p.market)) revert Unhealthy();
        }
    }

    function _tryFill(uint64 oid, bytes32 taker, OrderParams memory p, uint128 remaining) internal returns (uint128 q) {
        Order storage O = orders[oid];
        if (O.expiry != 0 && O.expiry <= block.timestamp) { _remove(oid, CancelReason.Expired); return 0; }
        if (O.acct == taker) { _remove(oid, CancelReason.SelfTrade); return 0; } // cancel-resting self-trade policy
        if (!_inBand(p.market, O.price)) { _remove(oid, CancelReason.PriceBand); return 0; } // stale/off-market resting price never trades
        q = O.size < remaining ? O.size : remaining;
        uint8 m = p.market;
        _settleMarket(O.acct, m);
        int256 mp = positions[O.acct][m].size;
        if (O.reduceOnly) {
            uint256 allowed = (O.isBuy ? mp < 0 : mp > 0) ? _abs(mp) : 0;
            if (allowed == 0) { _remove(oid, CancelReason.InvalidReduceOnly); return 0; }
            if (q > allowed) q = uint128(allowed);
        } else {
            _settleAll(O.acct);
            if (!_riskOkMaker(O.acct, m)) { _remove(oid, CancelReason.MakerMargin); return 0; }
        }
        _executeFill(oid, O, taker, p.isBuy, q, m);
    }

    /// @dev Every ordinary fill (incl. reduce-only) must execute within +/- bandBps of the CURRENT index. Liquidation, ADL, delist
    ///      settlement and backstop takeovers do not go through here (they execute at mark / settle price by construction).
    function _inBand(uint8 m, uint256 px) internal view returns (bool) {
        (uint256 idx, bool ok) = _index(m);
        if (!ok) return false;
        uint256 d = idx * markets[m].bandBps / BPS;
        return px >= idx - d && px <= idx + d;
    }

    function _riskOkMaker(bytes32 a, uint8 m) internal view returns (bool ok) {
        try this.marginOKExternal(a, m) returns (bool r) { return r; } catch { return false; }
    }

    function marginOKExternal(bytes32 a, uint8 m) external view returns (bool) { return _marginOK(a, m); }

    function _executeFill(uint64 oid, Order storage O, bytes32 taker, bool takerIsBuy, uint128 q, uint8 m) internal {
        uint64 px = O.price;
        bytes32 maker = O.acct;
        int256 sq = int256(uint256(q));
        uint128 oi0 = markets[m].oi;
        _applyFill(maker, m, takerIsBuy ? -sq : sq, px);
        _applyFill(taker, m, takerIsBuy ? sq : -sq, px);

        Market storage M = markets[m];
        if (M.oi > M.maxOI && M.oi > oi0) revert OICap(); // fills that do not raise OI (reduce-only closes) never hit the cap
        M.lastTradePrice = px;

        uint256 n = _notionalFloor(q, px);
        uint256 tf = _ceilBps(n, takerFeeBps);
        int256 mf = makerFeeBps >= 0 ? int256(_ceilBps(n, uint32(makerFeeBps))) : -int256(n * uint32(-makerFeeBps) / BPS);
        _credit(taker, m, -int256(tf));
        _credit(maker, m, -mf);
        feePool += int256(tf) + mf;
        _writeOffIfFlat(taker, m); // a fill that leaves a flat account negative records the loss immediately
        _writeOffIfFlat(maker, m);

        // book update
        O.size -= q;
        levels[m][O.isBuy][px].total -= q;
        uint128 newRsv = _orderReserve(m, px, O.size, O.reduceOnly);
        if (newRsv < O.reserve) { _reserveSub(maker, m, O.reserve - newRsv); O.reserve = newRsv; }
        if (O.size == 0) { O.size = 0; _removeFilled(oid); }
        emit Fill(nextTradeId++, m, oid, maker, taker, takerIsBuy, px, q, tf, mf);
    }

    function _removeFilled(uint64 id) internal {
        Order storage o = orders[id];
        _unlink(id); // size is 0 so level total is unaffected
        _reserveSub(o.acct, o.market, o.reserve);
        openOrders[o.acct].remove(id);
        emit OrderCanceled(id, CancelReason.Filled, 0);
        delete orders[id];
    }

}
