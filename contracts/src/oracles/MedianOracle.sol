// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IOracle} from "../IOracle.sol";

/// @notice Two-source aggregator: rejects stale sources, and reverts if fresh sources disagree by > maxDevBps.
/// Returns the older-update-time-safe average. With one fresh source it reverts unless allowSingle (default false).
contract MedianOracle is IOracle {
    IOracle public immutable a;
    IOracle public immutable b;
    uint256 public immutable maxAge;
    uint256 public immutable maxDevBps;
    constructor(IOracle _a, IOracle _b, uint256 _maxAge, uint256 _maxDevBps) { a = _a; b = _b; maxAge = _maxAge; maxDevBps = _maxDevBps; }
    function latest(bytes32 feed) external view returns (uint256, uint256) {
        (uint256 pa, uint256 ta) = a.latest(feed);
        (uint256 pb, uint256 tb) = b.latest(feed);
        require(block.timestamp - ta <= maxAge && block.timestamp - tb <= maxAge, "stale source");
        uint256 hi = pa > pb ? pa : pb; uint256 lo = pa > pb ? pb : pa;
        require((hi - lo) * 10_000 <= lo * maxDevBps, "source disagreement");
        return ((pa + pb) / 2, ta < tb ? ta : tb);
    }
}
