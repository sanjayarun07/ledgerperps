// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IOracle} from "../IOracle.sol";

interface AggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Chainlink adapter. UNVERIFIED on the target chain: feed addresses must be confirmed per docs/DEPENDENCIES.md.
///         SA-8: optional per-feed sanity bounds (a feed pinned at its circuit-breaker min/max is rejected) and a stale-round check.
///         The admin is an immutable EOA with no timelock (SA-4): on any real deployment it must be a timelock/multisig.
contract ChainlinkAdapter is IOracle {
    address public immutable admin;
    mapping(bytes32 => AggregatorV3) public feeds;
    /// @notice Accepted price range per feed, in 1e6 units. `max == 0` means no bounds are set (unbounded, the old behaviour).
    mapping(bytes32 => uint256) public minPrice;
    mapping(bytes32 => uint256) public maxPrice;
    event FeedSet(bytes32 indexed id, address aggregator);
    event BoundsSet(bytes32 indexed id, uint256 minPrice, uint256 maxPrice);
    constructor() { admin = msg.sender; }
    function setFeed(bytes32 id, address agg) external { require(msg.sender == admin, "admin"); feeds[id] = AggregatorV3(agg); emit FeedSet(id, agg); }
    function setBounds(bytes32 id, uint256 minPx, uint256 maxPx) external {
        require(msg.sender == admin, "admin");
        require(maxPx == 0 || minPx < maxPx, "bounds");
        minPrice[id] = minPx; maxPrice[id] = maxPx;
        emit BoundsSet(id, minPx, maxPx);
    }
    function latest(bytes32 id) external view returns (uint256, uint256) {
        AggregatorV3 a = feeds[id];
        require(address(a) != address(0), "no feed");
        (uint80 rid, int256 ans,, uint256 t, uint80 air) = a.latestRoundData();
        require(ans > 0, "bad answer");
        require(air == 0 || air >= rid, "stale round"); // answeredInRound is deprecated on some feeds (0): only reject when it is set and behind
        uint8 d = a.decimals();
        uint256 px = d >= 6 ? uint256(ans) / 10 ** (d - 6) : uint256(ans) * 10 ** (6 - d);
        require(px > 0, "zero");
        uint256 hi = maxPrice[id];
        if (hi != 0) require(px >= minPrice[id] && px <= hi, "out of bounds");
        return (px, t);
    }
}
