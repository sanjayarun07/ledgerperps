// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IOracle} from "../IOracle.sol";

interface IPythLike {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @notice Pyth adapter (pull oracle: someone must push updates). UNVERIFIED on the target chain.
contract PythAdapter is IOracle {
    IPythLike public immutable pyth;
    uint256 public immutable maxConfBps;
    constructor(address _pyth, uint256 _maxConfBps) { pyth = IPythLike(_pyth); maxConfBps = _maxConfBps; }
    function latest(bytes32 id) external view returns (uint256, uint256) {
        IPythLike.Price memory r = pyth.getPriceUnsafe(id);
        require(r.price > 0, "bad price");
        uint256 raw = uint256(uint64(r.price));
        require(uint256(r.conf) * 10_000 <= raw * maxConfBps, "wide conf");
        int256 shift = int256(r.expo) + 6; // target 1e6
        uint256 px = shift >= 0 ? raw * 10 ** uint256(shift) : raw / 10 ** uint256(-shift);
        require(px > 0, "zero");
        return (px, r.publishTime);
    }
}
