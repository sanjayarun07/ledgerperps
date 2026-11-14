// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deployer, IPerp} from "./Deployer.sol";
import {PerpBase} from "../src/PerpBase.sol";

/// Ports of matching / reduce-only / withdrawal scenarios from test/exchange.test.js. btc(n)=n hundredths of BTC.
contract UnitMatchingTest is Deployer {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address keeper = makeAddr("keeper");

    function setUp() public {
        _deployAll();
    }

    function _pos(address who) internal view returns (int256 size, int256 basis) {
        (size, basis,,,,) = ex.positions(_key(who), 0);
    }

    function test_deployWiring() public view {
        assertTrue(ex.modulesLocked());
        assertEq(ex.marketCount(), 1);
        assertEq(address(ex).code.length > 0, true);
        // every module reachable
        assertEq(px.adlScore(_key(alice), 0), 0);
        assertEq(px.openOrderIds(_key(alice)).length, 0);
    }

    function test_codeSizesUnderLimit() public view {
        assertLe(address(ex).code.length, 24576);
    }

    // ---------------------------------------------------------------- matching
    function test_partialFill() public {
        _fund(alice, usd(100_000)); _fund(bob, usd(100_000));
        (uint64 id,) = _place(bob, false, price(50000), btc(100), PerpBase.TIF.GTC, false);
        (, uint128 filled) = _place(alice, true, price(50000), btc(40), PerpBase.TIF.IOC, false);
        assertEq(filled, btc(40));
        (int256 a,) = _pos(alice);
        (int256 b,) = _pos(bob);
        assertEq(a, int256(uint256(btc(40))));
        assertEq(b, -int256(uint256(btc(40))));
        (, uint128 rem,,,,,,,,,) = ex.orders(id);
        assertEq(rem, btc(60));
        assertEq(px.getLevel(0, false, price(50000)).total, btc(60));
        // taker fee 5bps on 20,000 notional = 10.00 ; maker fee 1bp = 2.00
        assertEq(ex.collateral(_key(alice)), int256(usd(100_000)) - int256(usd(10)));
        assertEq(ex.collateral(_key(bob)), int256(usd(100_000)) - int256(usd(2)));
    }

    function test_fifoPriceTimePriority() public {
        _fund(alice, usd(100_000)); _fund(bob, usd(100_000)); _fund(carol, usd(100_000)); _fund(dave, usd(100_000));
        _place(bob, false, price(50000), btc(50), PerpBase.TIF.GTC, false);   // first at 50000
        _place(carol, false, price(50000), btc(50), PerpBase.TIF.GTC, false); // second at 50000
        _place(dave, false, price(49900), btc(20), PerpBase.TIF.GTC, false);  // better price, placed last
        _place(alice, true, price(50000), btc(80), PerpBase.TIF.IOC, false);
        // dave (best price) fully filled first: 0.2 ; then bob 0.5 ; then carol 0.1
        (int256 d,) = _pos(dave); (int256 b,) = _pos(bob); (int256 c,) = _pos(carol);
        assertEq(d, -int256(uint256(btc(20))));
        assertEq(b, -int256(uint256(btc(50))));
        assertEq(c, -int256(uint256(btc(10))));
    }

    function test_fokAtomicity() public {
        _fund(alice, usd(100_000)); _fund(bob, usd(100_000));
        (uint64 id,) = _place(bob, false, price(50000), btc(50), PerpBase.TIF.GTC, false);
        int256 colA = ex.collateral(_key(alice));
        int256 colB = ex.collateral(_key(bob));
        vm.prank(alice);
        vm.expectRevert(PerpBase.FokUnfilled.selector);
        px.placeOrder(alice, 0, _op(true, price(50000), btc(100), PerpBase.TIF.FOK, false));
        (int256 a,) = _pos(alice); (int256 b,) = _pos(bob);
        assertEq(a, 0); assertEq(b, 0);
        assertEq(ex.collateral(_key(alice)), colA);
        assertEq(ex.collateral(_key(bob)), colB);
        (, uint128 rem,,,,,,,,,) = ex.orders(id);
        assertEq(rem, btc(50));
        assertEq(px.getLevel(0, false, price(50000)).total, btc(50));
    }

    function test_neverFillsBeyondLimit() public {
        _fund(alice, usd(100_000)); _fund(bob, usd(100_000));
        _place(bob, false, price(50100), btc(50), PerpBase.TIF.GTC, false);
        (, uint128 filled) = _place(alice, true, price(50000), btc(50), PerpBase.TIF.IOC, false);
        assertEq(filled, 0);
    }

    // ---------------------------------------------------------------- reduce-only
    function test_reduceOnly() public {
        _fund(alice, usd(100_000)); _fund(bob, usd(100_000));
        _place(bob, false, price(50000), btc(100), PerpBase.TIF.GTC, false);
        _place(alice, true, price(50000), btc(50), PerpBase.TIF.IOC, false); // long 0.5
        // reduce-only buy would increase
        vm.prank(alice);
        vm.expectRevert(PerpBase.ReduceOnlyViolation.selector);
        px.placeOrder(alice, 0, _op(true, price(50000), btc(10), PerpBase.TIF.IOC, true));
        // reduce-only sell of 2 BTC clips to 0.5 and never reverses
        _place(bob, true, price(50000), btc(200), PerpBase.TIF.GTC, false);
        (, uint128 filled) = _place(alice, false, price(50000), btc(200), PerpBase.TIF.IOC, true);
        assertEq(filled, btc(50));
        (int256 a,) = _pos(alice);
        assertEq(a, 0);
    }

    // ---------------------------------------------------------------- collateral
    function test_withdrawalMarginCheck() public {
        _fund(alice, usd(6000)); _fund(bob, usd(100_000));
        _place(bob, false, price(50000), btc(100), PerpBase.TIF.GTC, false);
        _place(alice, true, price(50000), btc(100), PerpBase.TIF.IOC, false); // 1 BTC long, IM 5000, fee 25
        uint256 w = ex.withdrawable(_key(alice));
        assertEq(w, usd(6000) - usd(25) - usd(5000)); // 975
        vm.startPrank(alice);
        vm.expectRevert(PerpBase.Unhealthy.selector);
        ex.withdraw(0, w + 1);
        ex.withdraw(0, w);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), w);
        assertEq(ex.withdrawable(_key(alice)), 0);
        assertEq(usdc.balanceOf(address(ex)), ex.totalDeposited() - ex.totalWithdrawn());
    }

}
