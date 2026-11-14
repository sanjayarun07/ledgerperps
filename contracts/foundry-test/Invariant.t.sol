// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PerpBase} from "../src/PerpBase.sol";
import {Deployer} from "./Deployer.sol";
import {console} from "forge-std/console.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

interface IHandler {
    function checkNetPosition() external view;
    function checkOpenInterest() external view;
    function checkLedgerBalance() external view;
    function checkReserved() external view;
    function checkBook() external view;
    function checkNoPanics() external view;
    function okCalls(bytes32) external view returns (uint256);
    function revertedCalls(bytes32) external view returns (uint256);
    function revertsBySelector(bytes4) external view returns (uint256);
    function liquidations() external view returns (uint256);
    function adls() external view returns (uint256);
    function panicCount() external view returns (uint256);
    function lastPanicCode() external view returns (uint256);
    function lastPanicWhere() external view returns (string memory);
    function lastPanicCalldata() external view returns (bytes memory);
}

/// Stateful invariant suite. Handler is deployed through deployCode so this contract stays under the 24 KB limit.
contract InvariantTest is StdInvariant, Deployer {
    IHandler handler;

    function setUp() public {
        _deployAll();
        address h = deployCode("InvariantHandler.sol:InvariantHandler", abi.encode(address(ex), address(usdc), address(oracle), uint256(4)));
        handler = IHandler(h);
        targetContract(h);
        bytes4[] memory sels = new bytes4[](19);
        sels[0] = bytes4(keccak256("deposit(uint256,uint256)"));
        sels[1] = bytes4(keccak256("withdraw(uint256,uint256,bool)"));
        sels[2] = bytes4(keccak256("placeOrder(uint256,int256,uint256,uint8,bool,bool,uint8)"));
        sels[3] = bytes4(keccak256("cancelOrder(uint256,uint256)"));
        sels[4] = bytes4(keccak256("cancelAll(uint256)"));
        sels[5] = bytes4(keccak256("replaceOrder(uint256,uint256,int256,uint256,uint8,bool,uint8)"));
        sels[6] = bytes4(keccak256("moveOracle(int256)"));
        sels[7] = bytes4(keccak256("warp(uint256,bool)"));
        sels[8] = bytes4(keccak256("pokeFunding()"));
        sels[9] = bytes4(keccak256("liquidate(uint256)"));
        sels[10] = bytes4(keccak256("adl(uint256,uint256)"));
        sels[11] = bytes4(keccak256("recapitalize(uint256)"));
        sels[12] = bytes4(keccak256("takeBest(uint256,uint256,bool,bool,uint8)"));
        // duplicate selectors = higher call weight (fills need orders on both sides)
        for (uint256 i = 13; i < 16; i++) sels[i] = sels[2];
        for (uint256 i = 16; i < 19; i++) sels[i] = sels[12];
        targetSelector(FuzzSelector({addr: h, selectors: sels}));
    }

    function afterInvariant() public view {
        console.log("trades", uint256(ex.nextTradeId()) - 1);
        console.log("orders", uint256(ex.nextOrderId()) - 1);
        console.log("liquidations", handler.liquidations());
        console.log("adls", handler.adls());
        console.log("unresolvedBadDebt", ex.unresolvedBadDebt());
        string[11] memory n = ["deposit", "withdraw", "placeOrder", "cancelOrder", "cancelAll", "replaceOrder", "pokeFunding", "liquidate", "adl", "recapitalize", "fundInsurance"];
        for (uint256 i; i < n.length; i++) {
            bytes32 h = keccak256(bytes(n[i]));
            console.log(string.concat(n[i], " ok/reverted:"), handler.okCalls(h), handler.revertedCalls(h));
        }
        bytes4[13] memory es = [PerpBase.Unhealthy.selector, PerpBase.OracleDegraded.selector, PerpBase.ReduceOnlyViolation.selector,
            PerpBase.FokUnfilled.selector, PerpBase.PostOnlyCross.selector, PerpBase.Expired.selector, PerpBase.MarketRestricted.selector,
            PerpBase.NotLiquidatable.selector, PerpBase.DuplicateClientId.selector, PerpBase.TooManyOrders.selector,
            PerpBase.PriceTooFarFromTop.selector, PerpBase.OICap.selector, PerpBase.BadParam.selector];
        string[13] memory en = ["Unhealthy", "OracleDegraded", "ReduceOnlyViolation", "FokUnfilled", "PostOnlyCross", "Expired", "MarketRestricted", "NotLiquidatable", "DuplicateClientId", "TooManyOrders", "PriceTooFarFromTop", "OICap", "BadParam"];
        for (uint256 i; i < 13; i++) { uint256 c = handler.revertsBySelector(es[i]); if (c > 0) console.log(string.concat("  revert ", en[i]), c); }
        console.log("  revert Error(string)", handler.revertsBySelector(0x08c379a0));
    }

    function invariant_netPositionIsZero() public view { handler.checkNetPosition(); }
    function invariant_bookSortedNotCrossedLevelTotals() public view { handler.checkBook(); }
    function invariant_reservedEqualsOpenOrderReserves() public view { handler.checkReserved(); }
    function invariant_openInterestEqualsPositiveSizes() public view { handler.checkOpenInterest(); }
    function invariant_usdcBalanceEqualsNetDeposits() public view { handler.checkLedgerBalance(); }
    function invariant_noPanicReverts() public view { handler.checkNoPanics(); }
}
