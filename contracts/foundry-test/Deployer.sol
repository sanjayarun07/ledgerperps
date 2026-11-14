// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PerpExchange} from "../src/PerpExchange.sol";
import {PerpBase} from "../src/PerpBase.sol";
import {PerpTrading} from "../src/PerpTrading.sol";
import {PerpExtras} from "../src/PerpExtras.sol";
import {PerpLiquidation} from "../src/PerpLiquidation.sol";
import {PerpTwap} from "../src/PerpTwap.sol";
import {PerpAdl} from "../src/PerpAdl.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ManualOracle} from "../src/oracles/ManualOracle.sol";
import {IOracle} from "../src/IOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Full module interface used by tests to call the router with the merged ABI (the router only declares its own
///      functions; module functions arrive via fallback). Declared here so tests stay type-safe.
interface IPerp {
    // trading
    function placeOrder(address owner, uint8 sub, PerpBase.OrderParams calldata p) external returns (uint64 id, uint128 filled);
    function replaceOrder(uint64 oldId, PerpBase.OrderParams calldata p) external returns (uint64 id, uint128 filled);
    function backstopPlace(PerpBase.OrderParams calldata p) external returns (uint64 id, uint128 filled);
    // extras
    function cancelOrder(uint64 id) external;
    function cancelAll(address owner, uint8 sub) external;
    function getLevel(uint8 m, bool isBuy, uint64 price) external view returns (PerpBase.Level memory);
    function getMarket(uint8 m) external view returns (PerpBase.Market memory);
    function openOrderIds(bytes32 a) external view returns (uint256[] memory);
    // liquidation / adl
    function liquidate(bytes32 a, uint8 market) external;
    function adl(bytes32[] calldata targets, uint8 market) external;
    function adlScore(bytes32 a, uint8 market) external view returns (uint256);
    function recapitalize(uint8 market, uint256 amount) external;
}

/// @notice Deploys MockUSDC, ManualOracle, router + 5 modules. Module selectors are read from forge's build artifacts
///         (`methodIdentifiers`), minus any selector the router itself defines (those never reach the fallback).
abstract contract Deployer is Test {
    bytes32 constant FEED = keccak256("BTC-USD");
    uint8 constant MKT = 0;

    MockUSDC usdc;
    ManualOracle oracle;
    PerpExchange ex;
    IPerp px; // same address as ex, module-aware interface
    address admin = address(this);
    bytes32 BACK;

    function usd(uint256 n) internal pure returns (uint256) { return n * 1e6; }
    function btc(uint256 hundredthsOfBtc) internal pure returns (uint128) { return uint128(hundredthsOfBtc * 1e6); } // 1 => 0.01 BTC
    function price(uint256 n) internal pure returns (uint64) { return uint64(n * 1e6); }

    function _deployAll() internal {
        usdc = MockUSDC(deployCode("MockUSDC.sol:MockUSDC"));
        oracle = ManualOracle(deployCode("ManualOracle.sol:ManualOracle"));
        ex = PerpExchange(payable(deployCode("PerpExchange.sol:PerpExchange", abi.encode(address(usdc), address(oracle), admin))));
        px = IPerp(address(ex));
        BACK = ex.BACKSTOP();

        string[5] memory files = ["PerpTrading", "PerpExtras", "PerpLiquidation", "PerpTwap", "PerpAdl"];
        for (uint256 i; i < 5; i++) {
            address mod = deployCode(string.concat(files[i], ".sol:", files[i]));
            ex.registerModule(mod, _moduleOnlySelectors(files[i]));
        }
        ex.lockModules();

        oracle.set(FEED, price(50000));
        PerpExchange.MarketConfig memory c = PerpExchange.MarketConfig({
            feed: FEED, tick: 100_000, lot: 10_000, minNotional: uint64(usd(10)), maxOrderSize: 100e8, maxOI: 1000e8,
            maxAge: 60, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000
        });
        PerpBase.Tier[] memory t = new PerpBase.Tier[](3);
        t[0] = PerpBase.Tier(uint128(usd(100_000)), 1000, 500);
        t[1] = PerpBase.Tier(uint128(usd(1_000_000)), 2000, 1000);
        t[2] = PerpBase.Tier(type(uint128).max, 5000, 2500);
        ex.createMarket(c, t);
    }

    function _ids(string memory name) internal view returns (string[] memory sigs, bytes4[] memory sels) {
        string memory j = vm.readFile(string.concat("out-forge/", name, ".sol/", name, ".json"));
        sigs = vm.parseJsonKeys(j, ".methodIdentifiers");
        sels = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; i++) {
            sels[i] = bytes4(vm.parseBytes(string.concat("0x", vm.parseJsonString(j, string.concat(".methodIdentifiers['", sigs[i], "']")))));
        }
    }

    function _moduleOnlySelectors(string memory name) internal view returns (bytes4[] memory out) {
        (, bytes4[] memory core) = _ids("PerpExchange");
        (, bytes4[] memory mod) = _ids(name);
        bytes4[] memory tmp = new bytes4[](mod.length);
        uint256 n;
        for (uint256 i; i < mod.length; i++) {
            bool inCore;
            for (uint256 k; k < core.length; k++) if (core[k] == mod[i]) { inCore = true; break; }
            if (!inCore) tmp[n++] = mod[i];
        }
        out = new bytes4[](n);
        for (uint256 i; i < n; i++) out[i] = tmp[i];
    }

    // ---- helpers
    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(who, 0, amt);
        vm.stopPrank();
    }

    function _key(address who) internal pure returns (bytes32) { return keccak256(abi.encode(who, uint8(0))); }

    function _op(bool isBuy, uint64 p, uint128 size, PerpBase.TIF tif, bool ro) internal pure returns (PerpBase.OrderParams memory) {
        return PerpBase.OrderParams({market: 0, isBuy: isBuy, price: p, size: size, tif: tif, reduceOnly: ro, cloid: 0, expiry: 0});
    }

    function _place(address who, bool isBuy, uint64 p, uint128 size, PerpBase.TIF tif, bool ro) internal returns (uint64 id, uint128 filled) {
        vm.prank(who);
        return px.placeOrder(who, 0, _op(isBuy, p, size, tif, ro));
    }

    function _size(address who) internal view returns (int256 s) { (s,,,,,) = ex.positions(_key(who), 0); }
    function _sizeK(bytes32 k) internal view returns (int256 s) { (s,,,,,) = ex.positions(k, 0); }

    function _setPx(uint256 p) internal { oracle.set(FEED, p); }
}
