// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IOracle} from "../IOracle.sol";

/// @notice LOCAL SUBSTITUTE. Owner-set prices; never use outside local/test environments.
contract ManualOracle is IOracle {
    address public immutable owner;
    struct P { uint256 price; uint256 t; }
    mapping(bytes32 => P) public p;
    constructor() { owner = msg.sender; }
    function set(bytes32 feed, uint256 price) external {
        require(msg.sender == owner, "owner");
        p[feed] = P(price, block.timestamp);
    }
    function setAt(bytes32 feed, uint256 price, uint256 t) external {
        require(msg.sender == owner, "owner");
        p[feed] = P(price, t);
    }
    function latest(bytes32 feed) external view returns (uint256, uint256) {
        P memory x = p[feed];
        require(x.price > 0, "no price");
        return (x.price, x.t);
    }
}
