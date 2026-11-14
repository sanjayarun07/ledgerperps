// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Oracle adapter. Price scale: 1e6 (USDC per 1 whole base unit). MUST revert on invalid data.
interface IOracle {
    function latest(bytes32 feed) external view returns (uint256 price, uint256 updatedAt);
}
