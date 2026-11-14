// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PerpBase} from "./PerpBase.sol";

interface IPlacer {
    function placeFor(bytes32 a, PerpBase.OrderParams calldata p) external returns (uint64 id, uint128 filled);
}

/// @notice On-chain TWAP parent orders. Executed ONLY via delegatecall from PerpExchange (no own state variables).
/// @dev HONEST SEMANTICS: a TWAP here is an on-chain SCHEDULE, not a native resting order. Nothing executes by itself:
///      each slice runs only when some keeper (anyone) calls executeTwapSlice after its due time, so timing is
///      best-effort and depends on keeper liveness. A slice is an IOC order priced at mark +/- slippageBps and goes
///      through the normal margin path; it may fill partially or not at all. A slice that reverts for ANY reason (no
///      liquidity inside the limit, insufficient margin, reduce-only with no position, market paused, oracle degraded /
///      stale, global pause, ...) is NOT retried: it is counted in `failed`, consumes its schedule slot, and its
///      unfilled quantity is not re-queued except that the final slice sends `total - filled` (the whole unfilled
///      remainder), so a TWAP with failures can end with a larger last slice. If keepers are late the schedule does not
///      burst to catch up: a late slice re-anchors the cadence at now + interval.
contract PerpTwap is PerpBase {
    event TwapPlaced(uint64 indexed id, bytes32 indexed acct, uint8 market, bool isBuy, uint128 total, uint16 slices, uint32 interval, uint32 slippageBps, bool reduceOnly);
    event TwapSlice(uint64 indexed id, uint16 sliceIndex, uint128 filled, bool ok);
    event TwapDone(uint64 indexed id, uint128 filled, uint16 failed);
    event TwapCanceled(uint64 indexed id, uint128 filled);

    uint256 constant MAX_TWAPS = 8;

    function placeTwap(
        address owner, uint8 sub, uint8 market, bool isBuy, uint128 total, uint16 slices,
        uint32 intervalSecs, uint32 slippageBps, bool reduceOnly
    ) external nonReentrant returns (uint64 id) {
        bytes32 a = _register(owner, sub);
        _authTradeScoped(a, market, uint128(total), uint64(markPrice(market)));
        Market storage M = markets[market];
        if (!M.exists) revert BadParam("market");
        if (total == 0 || total % M.lot != 0) revert BadParam("size");
        if (slices < 2 || slices > 100) revert BadParam("slices");
        if (total / slices < M.lot) revert BadParam("slice < lot");
        if (intervalSecs == 0) revert BadParam("interval");
        if (slippageBps > 1000) revert BadParam("slippage");
        if (++twapCount[a] > MAX_TWAPS) revert TooManyOrders();
        id = nextTwapId++;
        twaps[id] = Twap(a, total, 0, uint64(block.timestamp), intervalSecs, slippageBps, slices, 0, 0, market, isBuy, reduceOnly, true);
        emit TwapPlaced(id, a, market, isBuy, total, slices, intervalSecs, slippageBps, reduceOnly);
    }

    /// @notice Permissionless keeper entry. Never reverts because of a failing child order.
    function executeTwapSlice(uint64 id) external nonReentrant {
        Twap storage t = twaps[id];
        if (!t.active) revert BadParam("inactive");
        if (block.timestamp < t.nextTime) revert BadParam("too early");

        uint16 idx = t.done;
        bool last = idx + 1 == t.slices;
        uint128 remaining = t.total - t.filled;
        uint128 sz;
        bool ok;
        uint128 got;
        if (remaining != 0) {
            Market storage M = markets[t.market];
            if (last) {
                sz = remaining;
            } else {
                sz = t.total / t.slices;
                sz -= sz % M.lot;
                if (sz > remaining) sz = remaining;
            }
            try this.markPrice(t.market) returns (uint256 mk) {
                bool buy = t.isBuy;
                uint256 lim = buy ? mk * (BPS + t.slippageBps) / BPS : mk * (BPS - t.slippageBps) / BPS;
                lim -= lim % M.tick; // buy: round down (safer); sell: round up below
                if (!buy && lim < mk * (BPS - t.slippageBps) / BPS) lim += M.tick;
                if (lim != 0 && lim <= type(uint64).max) {
                    OrderParams memory p = OrderParams(t.market, buy, uint64(lim), sz, TIF.IOC, t.reduceOnly, 0, 0);
                    try IPlacer(address(this)).placeFor(t.acct, p) returns (uint64, uint128 f) {
                        got = f; ok = true;
                    } catch {}
                }
            } catch {}
        }
        if (ok) t.filled += got; else t.failed++;
        t.done = idx + 1;
        uint64 nt = t.nextTime + t.interval;
        // late keeper: restart the cadence from now (otherwise the next slice would be instantly due again)
        t.nextTime = nt > block.timestamp ? nt : uint64(block.timestamp) + t.interval;
        emit TwapSlice(id, idx, got, ok);
        // Done when all slices ran, or nothing is left to execute.
        if (t.done == t.slices || t.filled == t.total) {
            t.active = false;
            twapCount[t.acct]--;
            emit TwapDone(id, t.filled, t.failed);
        }
    }

    function cancelTwap(uint64 id) external nonReentrant {
        Twap storage t = twaps[id];
        if (!t.active) revert BadParam("inactive");
        _authTrade(t.acct);
        t.active = false;
        twapCount[t.acct]--;
        emit TwapCanceled(id, t.filled);
    }

    function twapStatus(uint64 id) external view returns (Twap memory) { return twaps[id]; }
}
