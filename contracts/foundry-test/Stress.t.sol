// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PerpBase} from "../src/PerpBase.sol";
import {PerpExchange} from "../src/PerpExchange.sol";
import {Deployer, IPerp} from "./Deployer.sol";
import {StressHandler, IStressPerp} from "./StressHandler.sol";
import {StressKeeper} from "./StressKeeper.sol";
import {StressChecks} from "./StressChecks.sol";
import {StressAdl} from "./StressAdl.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";

interface IStressHandler {
    function checkNetPosition() external view;
    function checkLedger() external view;
    function checkDebtSum() external view;
    function checkFunding() external view;
    function checkViol(bytes32 p) external view;
    function checkProtocolBuffers() external;
    function liqCount() external view returns (uint256);
    function adlCount() external view returns (uint256);
    function liveFails() external view returns (uint256);
    function leak() external view returns (uint256);
    function minBackstopEq() external view returns (int256);
    function calls(bytes32) external view returns (uint256);
    function okCalls(bytes32) external view returns (uint256);
}

/// Stress invariants under large price gaps (-60% .. +150%), stale oracles, keepers, market state changes, delisting.
/// Run counts are env-configurable: FOUNDRY_INVARIANT_RUNS / FOUNDRY_INVARIANT_DEPTH (defaults below).
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 250
/// forge-config: default.invariant.fail_on_revert = false
contract StressInvariantTest is StdInvariant, Deployer {
    IStressHandler h;
    StressKeeper kp;

    function setUp() public {
        _deployAll(); // market 0 = BTC
        PerpBase.Tier[] memory t = new PerpBase.Tier[](3);
        t[0] = PerpBase.Tier(uint128(usd(100_000)), 1000, 500);
        t[1] = PerpBase.Tier(uint128(usd(1_000_000)), 2000, 1000);
        t[2] = PerpBase.Tier(type(uint128).max, 5000, 2500);
        bytes32[3] memory feeds = [FEED, keccak256("ETH-USD"), keccak256("SOL-USD")];
        uint256[3] memory p0 = [uint256(50_000e6), 3_000e6, 150e6];
        uint256[3] memory tick = [uint256(100_000), 10_000, 10_000];
        uint256[3] memory lot = [uint256(10_000), 100_000, 1_000_000];
        for (uint256 m = 1; m < 3; m++) {
            oracle.set(feeds[m], p0[m]);
            ex.createMarket(PerpExchange.MarketConfig({
                feed: feeds[m], tick: uint64(tick[m]), lot: uint64(lot[m]), minNotional: uint64(usd(10)), maxOrderSize: m == 1 ? 5000e8 : 200_000e8,
                maxOI: m == 1 ? 20_000e8 : 1_000_000e8, maxAge: 60, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000
            }), t);
        }
        // handler split in two contracts (actions / keepers+invariants) to stay under the EIP-170 limit enforced by foundry.toml
        address hh = deployCode("StressHandler.sol:StressHandler");
        address kk = deployCode("StressKeeper.sol:StressKeeper");
        StressHandler(hh).init(ex, usdc, oracle, feeds, p0, tick, lot);
        StressHandler(hh).setKeeper(kk);
        StressKeeper(kk).init(ex, usdc, hh);
        address cc = deployCode("StressChecks.sol:StressChecks");
        StressChecks(cc).init(ex, usdc, kk);
        StressKeeper(kk).setChecks(cc);
        address aa = deployCode("StressAdl.sol:StressAdl");
        StressAdl(aa).init(ex, kk, hh);
        h = IStressHandler(cc); kp = StressKeeper(kk);
        ex.grantRole(0x00, hh); ex.grantRole(0x00, kk); // handlers act as admin (state changes, delist, rebalance)
        ex.grantRole(ex.BACKSTOP_ROLE(), address(0xB5));
        targetContract(hh); targetContract(kk); targetContract(aa);
        bytes4[] memory s = new bytes4[](40);
        uint256 n;
        s[n++] = StressHandler.configIso.selector;
        s[n++] = StressHandler.configIso.selector;
        for (uint256 i; i < 6; i++) s[n++] = StressHandler.openPosition.selector;
        s[n++] = StressHandler.close.selector; s[n++] = StressHandler.close.selector;
        s[n++] = StressHandler.premium.selector; s[n++] = StressHandler.premium.selector;
        for (uint256 i; i < 4; i++) s[n++] = StressHandler.shock.selector;
        s[n++] = StressHandler.stale.selector; s[n++] = StressHandler.recover.selector; s[n++] = StressHandler.warp.selector;
        s[n++] = StressHandler.setState.selector; s[n++] = StressHandler.pause.selector;
        s[n++] = StressHandler.delist.selector; s[n++] = StressHandler.settle.selector; s[n++] = StressHandler.settle.selector;
        s[n++] = StressHandler.bsunwind.selector;
        bytes4[] memory sel = new bytes4[](n);
        for (uint256 i; i < n; i++) sel[i] = s[i];
        targetSelector(FuzzSelector({addr: hh, selectors: sel}));
        bytes4[] memory k = new bytes4[](20);
        uint256 j;
        for (uint256 i; i < 5; i++) k[j++] = StressKeeper.liquidate.selector;
        k[j++] = StressKeeper.sweep.selector; k[j++] = StressKeeper.sweep.selector;
        k[j++] = StressKeeper.recapitalize.selector; k[j++] = StressKeeper.poke.selector;
        k[j++] = StressKeeper.donate.selector;
        bytes4[] memory ksel = new bytes4[](j);
        for (uint256 i; i < j; i++) ksel[i] = k[i];
        targetSelector(FuzzSelector({addr: kk, selectors: ksel}));
        bytes4[] memory asel = new bytes4[](9);
        for (uint256 i; i < 4; i++) asel[i] = StressAdl.adl.selector;
        asel[4] = StressAdl.syncBackstop.selector; asel[5] = StressAdl.syncBackstop.selector;
        asel[6] = StressAdl.deposit.selector; asel[7] = StressAdl.withdraw.selector; asel[8] = StressAdl.rebalance.selector;
        targetSelector(FuzzSelector({addr: aa, selectors: asel}));
    }

    function afterInvariant() public view {
        console.log("liquidations", kp.liqCount());
        console.log("adls", kp.adlCount());
        console.log("liveness failures", kp.liveFails());
        console.log("ADL rounding leak (1e-8 USDC)", kp.leak());
        console.log("min backstop equity (USDC micro)");
        console.logInt(kp.minBackstopEq());
        console.log("unresolvedBadDebt", ex.unresolvedBadDebt());
    }

    function invariant_P1_netPositionPerMarketIsZero() public view { h.checkNetPosition(); }
    function invariant_P2_exactLedgerIdentityInclIsoMargin() public view { h.checkLedger(); }
    function invariant_P3a_P9_debtBookkeeping() public view { h.checkDebtSum(); }
    function invariant_FUND_fundingConservedInclBackstop() public view { h.checkFunding(); }
    function invariant_P4_bucketIsolation() public view { h.checkViol("P4"); }
    function invariant_P5_liquidationCorrectness() public view { h.checkViol("P5"); }
    function invariant_P7_adlBounds() public view { h.checkViol("P7"); }
    function invariant_P8_insurance() public view { h.checkViol("P8"); }
    function invariant_P3_P11_backstopRecognisedAfterSync() public { h.checkProtocolBuffers(); }
    function invariant_P11_syncChecks() public view { h.checkViol("P11"); }
    function invariant_P10_liveness() public view { h.checkViol("P10"); }
    function invariant_P0_noPanicNoOOG() public view { h.checkViol("P0"); }
    function invariant_P9_recapitalizeExact() public view { h.checkViol("P9"); }
}

/// Deterministic Foundry regression tests for findings that were FIXED in src/ (each failed before the fix).
contract StressFindingsTest is Deployer {
    address alice = makeAddr("alice"); address bob = makeAddr("bob"); address keeper = makeAddr("keeper");

    function setUp() public { _deployAll(); ex.setFees(5, 1, 50, 5000, 10000, uint64(usd(1_000_000))); }

    function test_FIXED_ADL1_longTargetFullyClosedGivesBackstopWrongSign() public {
        _fund(alice, usd(6500)); _fund(bob, usd(100_000));
        _place(alice, false, price(50000), btc(100), PerpBase.TIF.GTC, false); // alice short 1 BTC
        _place(bob, true, price(50000), btc(100), PerpBase.TIF.IOC, false);    // bob long 1 BTC
        _setPx(price(70000));
        vm.prank(keeper); px.liquidate(_key(alice), 0);                          // backstop short 1 BTC
        bytes32[] memory t = new bytes32[](1); t[0] = _key(bob);
        vm.prank(keeper); px.adl(t, 0);
        assertEq(_size(alice) + _size(bob) + _sizeK(BACK), 0, "net position incl BACKSTOP must be 0");
    }

    function test_FIXED_LIQ1_staleUnrelatedOracleDoesNotBlockLiquidation() public {
        oracle.set(keccak256("ETH-USD"), 3000e6);
        PerpBase.Tier[] memory t = new PerpBase.Tier[](1);
        t[0] = PerpBase.Tier(type(uint128).max, 1000, 500);
        ex.createMarket(PerpExchange.MarketConfig({feed: keccak256("ETH-USD"), tick: 10_000, lot: 100_000, minNotional: uint64(usd(10)), maxOrderSize: 5000e8, maxOI: 20_000e8,
            maxAge: 60, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000}), t);
        _fund(alice, usd(6500)); _fund(bob, usd(100_000));
        _place(bob, false, price(50000), btc(80), PerpBase.TIF.GTC, false);
        _place(alice, true, price(50000), btc(80), PerpBase.TIF.IOC, false);
        PerpBase.OrderParams memory o = PerpBase.OrderParams({market: 1, isBuy: false, price: 3000e6, size: 4e8, tif: PerpBase.TIF.GTC, reduceOnly: false, cloid: 0, expiry: 0});
        vm.prank(bob); px.placeOrder(bob, 0, o);
        o.isBuy = true; o.tif = PerpBase.TIF.IOC;
        vm.prank(alice); px.placeOrder(alice, 0, o);
        _setPx(price(35000)); // BTC -30%
        vm.warp(block.timestamp + 70); // ETH feed (never re-set) is now stale; BTC feed refreshed below
        _setPx(price(35000));
        vm.prank(keeper);
        px.liquidate(_key(alice), 0); // succeeds: only the liquidated market needs a fresh mark (stale ETH is valued in the account's favour)
    }

    function test_FIXED_WASH1_offMarketReduceOnlyWashIsRejected() public {
        address cp = makeAddr("cp");
        _fund(alice, usd(6500)); _fund(bob, usd(6500)); _fund(cp, usd(200_000)); _fund(makeAddr("honest"), usd(100_000));
        _place(cp, false, price(50000), btc(100), PerpBase.TIF.GTC, false);
        _place(alice, true, price(50000), btc(100), PerpBase.TIF.IOC, false);                   // alice long 1 BTC
        _place(bob, true, price(1), btc(1000), PerpBase.TIF.GTC, false);                         // accomplice bids 10 BTC at $1
        _place(alice, false, price(1), btc(100), PerpBase.TIF.IOC, true);                       // alice's reduce-only dump finds only an out-of-band bid
        assertEq(_size(alice), int256(uint256(btc(100))), "off-band fill must not execute");
        int256 pos_;
        for (uint256 i; i < 4; i++) { address[4] memory who = [alice, bob, cp, makeAddr("honest")]; int256 c = ex.collateral(_key(who[i])); if (c > 0) pos_ += c; }
        pos_ += int256(ex.insurance());
        assertLe(pos_ - int256(ex.unresolvedBadDebt()), int256(usdc.balanceOf(address(ex))) + 2, "positive claims exceed vault");
    }

    // ---- BACKSTOP-1 / ADL-2 (fixed): deterministic repros --------------------------------------------------------
    function _bsSetup() internal returns (bytes32 ka, bytes32 kb) {
        ka = _key(alice); kb = _key(bob);
        _fund(alice, usd(6500)); _fund(bob, usd(100_000));
        _place(alice, false, price(50000), btc(100), PerpBase.TIF.GTC, false);   // alice short 1 BTC
        _place(bob, true, price(50000), btc(100), PerpBase.TIF.IOC, false);      // bob long 1 BTC
        _setPx(price(60000));
        vm.prank(keeper); px.liquidate(ka, 0);                                     // backstop short 1 BTC @60k, alice bad debt
    }

    function test_FIXED_BACKSTOP1_deficitRecordedAfterSyncAndRepaidOnReversion() public {
        _bsSetup();
        uint256 ubd0 = ex.unresolvedBadDebt();
        uint256[4] memory pxs = [uint256(100_000), 150_000, 250_000, 500_000];
        for (uint256 i; i < 4; i++) {
            _setPx(price(pxs[i]));
            vm.prank(keeper); IStressPerp(address(ex)).syncBackstop();
            assertGe(ex.collateral(BACK), 0, "backstop bucket non-negative after sync");
            assertGe(IStressPerp(address(ex)).backstopEquity(), -2, "E_B >= 0 after sync");
            assertEq(ex.unresolvedBadDebt(), ubd0 + usd(pxs[i] - 60_000), "recorded debt == mark-to-market loss");
        }
        _setPx(price(60000)); vm.prank(keeper); IStressPerp(address(ex)).syncBackstop();
        assertEq(ex.unresolvedBadDebt(), ubd0, "reversion repays the recorded deficit");
        assertEq(ex.bsDebt(), 0);
    }

    function test_FIXED_BACKSTOP1_withdrawGateLimitsEarnedProfitNotPrincipal() public {
        (, bytes32 kb) = _bsSetup();
        _setPx(price(100000));
        address carol = makeAddr("carol"); _fund(carol, usd(100_000));
        _place(carol, true, price(100000), btc(100), PerpBase.TIF.GTC, false);
        _place(bob, false, price(100000), btc(100), PerpBase.TIF.IOC, true);       // bob realises +50k
        assertGt(ex.collateral(kb), int256(usd(100_000)), "bob holds earned profit");
        vm.prank(bob); vm.expectRevert(PerpBase.WithdrawGated.selector); ex.withdraw(0, usd(100_000) + 1);
        vm.prank(bob); ex.withdraw(0, usd(100_000));                                 // principal always leaves
        vm.prank(bob); vm.expectRevert(PerpBase.WithdrawGated.selector); ex.withdraw(0, 1);
        assertGt(ex.unresolvedBadDebt(), ex.wdGateThreshold());
    }

    function test_FIXED_BACKSTOP1_adlClearsRecordedBackstopDebt() public {
        // after the deficit is recorded, ADL of the winner clears debt up to its profit (ceiling adlHardPremBps)
        (, bytes32 kb) = _bsSetup();
        _setPx(price(100000));
        vm.prank(keeper); IStressPerp(address(ex)).syncBackstop();
        bytes32[] memory t = new bytes32[](1); t[0] = kb;
        uint256 u0 = ex.unresolvedBadDebt();
        vm.prank(keeper); px.adl(t, 0);                                              // healthy winner: executes
        assertLt(ex.unresolvedBadDebt(), u0);
    }
}
