// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// @notice Test-only Chainlink-style aggregator. Never deploy to a real network.
contract MockAggregator {
    uint8 public decimals = 8;
    uint80 public roundId; int256 public answer; uint256 public updatedAt; uint80 public answeredInRound;
    function set(int256 a, uint256 t) external { roundId++; answer = a; updatedAt = t; answeredInRound = roundId; }
    function setAnsweredInRound(uint80 r) external { answeredInRound = r; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (roundId, answer, updatedAt, updatedAt, answeredInRound); }
}
