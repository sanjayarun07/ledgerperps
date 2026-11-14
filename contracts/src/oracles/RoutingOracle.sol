// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IOracle} from "../IOracle.sol";

/// @notice TESTNET DEMO ONLY. The exchange has ONE oracle address for all markets; this router sends exactly one feed id (the DEMO
/// market, priced by an admin-controlled ManualOracle) to `demo` and every other feed id (real Chainlink / median feeds) to `main`.
/// It has no owner, no setters and holds no state: immutable wiring, so it cannot be repointed after deployment. A revert in the chosen
/// oracle propagates unchanged (stale/invalid data must revert), so a broken demo feed can never affect the real markets.
contract RoutingOracle is IOracle {
    IOracle public immutable main;
    IOracle public immutable demo;
    bytes32 public immutable demoFeed;

    constructor(IOracle _main, IOracle _demo, bytes32 _demoFeed) {
        require(address(_main) != address(0) && address(_demo) != address(0) && _demoFeed != bytes32(0), "zero");
        main = _main;
        demo = _demo;
        demoFeed = _demoFeed;
    }

    function latest(bytes32 feed) external view returns (uint256, uint256) {
        return feed == demoFeed ? demo.latest(feed) : main.latest(feed);
    }
}
