// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deployer} from "./Deployer.sol";
import {MathHarness} from "./MathHarness.sol";
import {PerpBase} from "../src/PerpBase.sol";

/// Stateless property tests (forge `testFuzz_`).
contract FuzzTest is Deployer {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    MathHarness h;

    function setUp() public {
        _deployAll();
        h = MathHarness(deployCode("MathHarness.sol:MathHarness"));
        _fund(alice, usd(50_000_000));
        _fund(bob, usd(50_000_000));
    }

    /// price on the tick grid in [47500, 52500] = oracle 50000 +/- bandBps (500): fills outside the band are rejected by design (WASH-1)
    function _px(uint256 k) internal pure returns (uint64) { return uint64(47_500e6 + bound2(k, 0, 50_000) * 1e5); }
    /// size on the lot grid, 0.01 .. 5 BTC
    function _sz(uint256 k) internal pure returns (uint128) { return uint128(bound2(k, 1, 500) * 1e6); }
    function bound2(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) { return lo + x % (hi - lo + 1); }

    function _pos(address who) internal view returns (int256 size, int256 basis) { (size, basis,,,,) = ex.positions(_key(who), 0); }

    // ---------------------------------------------------------------- fill / limit price bounds
    function testFuzz_fillRespectsLimitPrice(uint256 makerPxK, uint256 takerPxK, uint256 makerSzK, uint256 takerSzK, bool takerBuys) public {
        uint64 mp = _px(makerPxK); uint64 tp = _px(takerPxK);
        uint128 ms = _sz(makerSzK); uint128 ts = _sz(takerSzK);
        _place(bob, !takerBuys, mp, ms, PerpBase.TIF.GTC, false);
        (, uint128 filled) = _place(alice, takerBuys, tp, ts, PerpBase.TIF.IOC, false);
        bool crosses = takerBuys ? tp >= mp : tp <= mp;
        if (!crosses) {
            assertEq(filled, 0, "filled through limit");
        } else {
            uint128 exp = ms < ts ? ms : ts;
            assertEq(filled, exp, "should fill min(sizes)");
            (int256 s, int256 b) = _pos(alice);
            // executes at the MAKER price, never worse than taker's limit
            assertEq(b, (takerBuys ? int256(1) : -1) * int256(uint256(filled)) * int256(uint256(mp)), "basis != filled*makerPx");
            assertEq(s, (takerBuys ? int256(1) : -1) * int256(uint256(filled)));
            if (takerBuys) assertLe(mp, tp); else assertGe(mp, tp);
        }
        assertLe(filled, ts);
    }

    // ---------------------------------------------------------------- weighted entry + reversal
    function testFuzz_weightedEntryAndReversal(uint256 p1k, uint256 p2k, uint256 p3k, uint256 s1k, uint256 s2k, uint256 s3k, bool long) public {
        uint64 p1 = _px(p1k); uint64 p2 = _px(p2k); uint64 p3 = _px(p3k);
        uint128 s1 = _sz(s1k); uint128 s2 = _sz(s2k); uint128 s3 = _sz(s3k);
        int256 sgn = long ? int256(1) : -1;
        // alice opens in two legs (maker = bob)
        _place(bob, !long, p1, s1, PerpBase.TIF.GTC, false);
        _place(alice, long, p1, s1, PerpBase.TIF.IOC, false);
        _place(bob, !long, p2, s2, PerpBase.TIF.GTC, false);
        _place(alice, long, p2, s2, PerpBase.TIF.IOC, false);
        (int256 sz, int256 basis) = _pos(alice);
        assertEq(sz, sgn * int256(uint256(s1) + uint256(s2)));
        assertEq(basis, sgn * (int256(uint256(s1)) * int256(uint256(p1)) + int256(uint256(s2)) * int256(uint256(p2))), "weighted basis");
        int256 colBefore = ex.collateral(_key(alice));

        // third leg in the opposite direction: reduces, closes, or reverses
        _place(bob, long, p3, s3, PerpBase.TIF.GTC, false);
        (, uint128 filled) = _place(alice, !long, p3, s3, PerpBase.TIF.IOC, false);
        if (filled == 0) return; // e.g. rejected by margin on the flip leg is a revert, not zero; zero means no cross
        uint256 open = uint256(s1) + uint256(s2);
        (int256 sz2, int256 basis2) = _pos(alice);
        assertEq(sz2, sgn * (int256(open) - int256(uint256(filled))), "size after leg 3");
        if (filled > open) {
            // reversed: new basis is exactly (excess * p3), opposite sign
            assertEq(basis2, -sgn * int256(uint256(filled) - open) * int256(uint256(p3)), "reversal basis");
        } else if (filled == open) {
            assertEq(basis2, 0);
        } else {
            // partially reduced: basis shrinks proportionally, never changes sign, |remaining basis| <= |old basis|
            assertTrue(basis2 * sgn >= 0);
            assertLe(uint256(basis2 * sgn), uint256(basis * sgn));
        }
        // ledger: alice+bob collateral + feePool + dust ~= deposits (no funding accrued here)
        int256 lhs = ex.collateral(_key(alice)) + ex.collateral(_key(bob)) + ex.feePool() + int256(ex.dustBasis() / 1e8) + int256(ex.insurance());
        int256 rhs = int256(ex.totalDeposited()) - int256(ex.totalWithdrawn());
        int256 drift = lhs - rhs;
        assertTrue(drift >= -3 && drift <= 3, "ledger drift");
        colBefore;
    }

    // ---------------------------------------------------------------- funding owed rounding
    function testFuzz_fundingOwedNeverFavoursUser(int128 size, int128 dIdx) public view {
        int256 owed = h.fundingOwed(size, dIdx);
        int256 exact = int256(size) * int256(dIdx);
        int256 S = 1e14;
        // owed (positive = user pays) is exactly ceil(exact / S): the user always pays at least the exact amount
        // and receives at most the exact amount.
        assertGe(owed * S, exact, "user would pay less than exact / receive more than exact");
        assertLt((owed - 1) * S, exact, "rounding is not tight");
    }

    function testFuzz_fdivFloors(int128 a, int64 b) public view {
        vm.assume(b != 0);
        int256 q = h.fdiv(a, b);
        // q = floor(a/b): q*b <= a < (q+1)*b for b>0 ; mirrored for b<0
        if (b > 0) { assertLe(q * b, int256(a)); assertGt((q + 1) * b, int256(a)); }
        else { assertGe(q * b, int256(a)); assertLt((q + 1) * b, int256(a)); }
    }

    function testFuzz_notionalAndFeeRoundingDirection(uint64 size, uint64 price_, uint16 bps) public view {
        uint256 f = h.notionalFloor(size, price_);
        uint256 c = h.notionalCeil(size, price_);
        assertLe(f, c);
        assertLe(c - f, 1);
        assertGe(c * 1e8, uint256(size) * price_);
        uint256 cb = h.ceilBps(f, bps);
        assertGe(cb * 1e4, f * bps);
        assertLe(cb * 1e4, f * bps + 9999);
    }

    // ---------------------------------------------------------------- withdrawable <= equity - IM - reserved
    function testFuzz_withdrawableBoundedByFreeEquity(uint256 pxK, uint256 szK, bool long, uint256 movePct, bool moveUp, uint256 restK, bool rest) public {
        // smaller deposit so margin actually binds
        address carol = makeAddr("carol");
        _fund(carol, usd(20_000));
        uint64 p = _px(pxK); uint128 s = _sz(szK);
        _place(bob, !long, p, s, PerpBase.TIF.GTC, false);
        vm.prank(carol);
        try px.placeOrder(carol, 0, _op(long, p, s, PerpBase.TIF.IOC, false)) {} catch {}
        if (rest) {
            vm.prank(carol);
            try px.placeOrder(carol, 0, _op(!long, _px(restK), _sz(restK / 7), PerpBase.TIF.GTC, false)) {} catch {}
        }
        uint256 mv = bound2(movePct, 0, 30);
        uint256 np = moveUp ? 50_000e6 * (100 + mv) / 100 : 50_000e6 * (100 - mv) / 100;
        _setPx(np);
        bytes32 k = _key(carol);
        (int256 eq, uint256 im,, uint256 resv, uint256 avail) = ex.accountState(k);
        int256 col = ex.collateral(k);
        int256 freeEq = eq - int256(im) - int256(resv);
        int256 freeCol = col - int256(im) - int256(resv);
        if (freeEq <= 0 || freeCol <= 0) assertEq(avail, 0, "withdrawable positive without free margin");
        else {
            assertLe(int256(avail), freeEq, "withdrawable > equity-IM-reserved");
            assertLe(int256(avail), freeCol, "withdrawable > collateral-IM-reserved");
        }
        // withdrawing exactly `avail` is allowed and leaves the account margin-healthy; avail+1 is not
        vm.prank(carol);
        try ex.withdraw(0, avail + 1) { fail("withdrew more than withdrawable"); } catch {}
        if (avail > 0) {
            vm.prank(carol);
            ex.withdraw(0, avail);
            (int256 eq2, uint256 im2,, uint256 resv2,) = ex.accountState(k);
            assertGe(eq2, int256(im2) + int256(resv2), "unhealthy after max withdrawal");
        }
        assertEq(usdc.balanceOf(address(ex)), ex.totalDeposited() - ex.totalWithdrawn());
    }
}
