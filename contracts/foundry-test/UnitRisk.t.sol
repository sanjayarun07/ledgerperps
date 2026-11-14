// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deployer, IPerp} from "./Deployer.sol";
import {PerpBase} from "../src/PerpBase.sol";

/// Ports of liquidation / isolated / ADL scenarios from test/exchange.test.js and test/isolated_adl.test.js.
contract UnitRiskTest is Deployer {
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

    // ---------------------------------------------------------------- liquidation
    function _levered() internal {
        _fund(alice, usd(6000)); _fund(bob, usd(100_000)); _fund(carol, usd(200_000));
        _place(bob, false, price(50000), btc(100), PerpBase.TIF.GTC, false);
        _place(alice, true, price(50000), btc(100), PerpBase.TIF.IOC, false);
    }

    function test_liquidationToBackstop() public {
        _levered();
        _setPx(price(47500));
        vm.prank(keeper);
        vm.expectRevert(PerpBase.NotLiquidatable.selector);
        px.liquidate(_key(alice), 0);
        _setPx(price(45500));
        // alice rests an order which liquidation must cancel
        vm.prank(alice);
        try px.placeOrder(alice, 0, _op(true, price(40000), btc(1), PerpBase.TIF.GTC, false)) {} catch {}
        vm.prank(keeper);
        px.liquidate(_key(alice), 0);
        assertEq(_size(alice), int256(uint256(btc(50))));
        assertEq(_sizeK(BACK), int256(uint256(btc(50))));
        assertEq(_size(alice) + _size(bob) + _sizeK(BACK), 0);
        uint256 fee = (uint256(22750e6) * 50 + 9999) / 10000;
        assertEq(ex.collateral(_key(keeper)), int256(fee * 5000 / 10000));
        assertEq(px.openOrderIds(_key(alice)).length, 0);
        assertEq(ex.reserved(_key(alice)), 0);
    }

    function test_isolatedLossCappedAtIsolatedMargin() public {
        _fund(alice, usd(100_000)); _fund(bob, usd(100_000));
        vm.startPrank(alice);
        ex.setIsolated(0, 0, true);
        ex.addIsoMargin(0, 0, usd(1100));
        vm.stopPrank();
        _place(bob, false, price(50000), btc(20), PerpBase.TIF.GTC, false);
        _place(alice, true, price(50000), btc(20), PerpBase.TIF.IOC, false);
        int256 cross = ex.collateral(_key(alice));
        ex.setFees(5, 1, 50, 5000, 10000, uint64(usd(1_000_000)));
        _setPx(price(40000)); // -2000 vs ~1095 margin
        vm.prank(keeper);
        px.liquidate(_key(alice), 0);
        assertEq(ex.collateral(_key(alice)), cross, "cross untouched");
        (,,, , int256 iso,) = ex.positions(_key(alice), 0);
        assertEq(iso, 0);
        assertGt(ex.unresolvedBadDebt(), usd(900));
        assertLt(ex.unresolvedBadDebt(), usd(950));
        assertEq(ex.adlDebt(0), ex.unresolvedBadDebt());
    }

    // ---------------------------------------------------------------- ADL
    function _physicalClaims() internal view returns (int256 claims) {
        address[5] memory who = [alice, bob, carol, dave, keeper];
        for (uint256 i; i < 5; i++) claims += ex.collateral(_key(who[i]));
        claims += ex.collateral(BACK) + int256(ex.insurance()) + ex.feePool() + ex.fundingPool();
    }

    function test_adlRestoresSolvency() public {
        _levered();
        ex.setFees(5, 1, 50, 5000, 10000, uint64(usd(1_000_000)));
        ex.setAdlMaxPremBps(10000);
        bytes32[] memory t = new bytes32[](1);
        t[0] = _key(bob);
        vm.prank(keeper);
        vm.expectRevert(); // no debt
        px.adl(t, 0);
        _setPx(price(30000));
        vm.prank(keeper);
        px.liquidate(_key(alice), 0);
        uint256 debt = ex.adlDebt(0);
        assertGt(debt, 0);
        assertEq(ex.unresolvedBadDebt(), debt);
        vm.prank(keeper);
        px.adl(t, 0);
        assertLe(ex.adlDebt(0), 1);
        assertLe(ex.unresolvedBadDebt(), 1);
        assertEq(_size(alice), 0); assertEq(_size(bob), 0); assertEq(_sizeK(BACK), 0);
        int256 diff = _physicalClaims() - int256(usdc.balanceOf(address(ex)));
        assertTrue(diff >= -5 && diff <= 5, "claims == held within dust");
    }

    function test_adlRecapitalizeClosesResidual() public {
        _levered();
        ex.setFees(5, 1, 50, 5000, 10000, uint64(usd(1_000_000)));
        bytes32[] memory t = new bytes32[](1);
        t[0] = _key(bob);
        _setPx(price(30000));
        vm.prank(keeper);
        px.liquidate(_key(alice), 0);
        vm.prank(keeper);
        px.adl(t, 0);
        uint256 rest = ex.adlDebt(0);
        assertGt(rest, 0);
        usdc.mint(carol, rest);
        vm.startPrank(carol);
        usdc.approve(address(ex), rest);
        px.recapitalize(0, rest);
        vm.stopPrank();
        assertEq(ex.adlDebt(0), 0);
        assertEq(ex.unresolvedBadDebt(), 0);
        int256 diff = _physicalClaims() - int256(usdc.balanceOf(address(ex)));
        assertTrue(diff >= -5 && diff <= 5, "claims == held within dust");
    }
}
