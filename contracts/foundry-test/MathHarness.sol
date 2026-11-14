// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PerpBase} from "../src/PerpBase.sol";

/// @dev Exposes PerpBase internal pure math for property tests. Deployed via deployCode to keep test bytecode small.
contract MathHarness is PerpBase {
    function fundingOwed(int256 size, int256 dIdx) external pure returns (int256) { return _fundingOwed(size, dIdx); }
    function fdiv(int256 a, int256 b) external pure returns (int256) { return _fdiv(a, b); }
    function notionalCeil(uint256 s, uint256 p) external pure returns (uint256) { return _notionalCeil(s, p); }
    function notionalFloor(uint256 s, uint256 p) external pure returns (uint256) { return _notionalFloor(s, p); }
    function ceilBps(uint256 x, uint256 b) external pure returns (uint256) { return _ceilBps(x, b); }
}
