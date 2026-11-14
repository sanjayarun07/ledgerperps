// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IOracle} from "../IOracle.sol";

interface AggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80);
}

/// @notice Chainlink adapter. UNVERIFIED on the target chain: feed addresses must be confirmed per docs/DEPENDENCIES.md.
contract ChainlinkAdapter is IOracle {
    address public immutable admin;
    mapping(bytes32 => AggregatorV3) public feeds;
    constructor() { admin = msg.sender; }
    function setFeed(bytes32 id, address agg) external { require(msg.sender == admin, "admin"); feeds[id] = AggregatorV3(agg); }
    function latest(bytes32 id) external view returns (uint256, uint256) {
        AggregatorV3 a = feeds[id];
        require(address(a) != address(0), "no feed");
        (, int256 ans,, uint256 t,) = a.latestRoundData();
        require(ans > 0, "bad answer");
        uint8 d = a.decimals();
        uint256 px = d >= 6 ? uint256(ans) / 10 ** (d - 6) : uint256(ans) * 10 ** (6 - d);
        require(px > 0, "zero");
        return (px, t);
    }
}
