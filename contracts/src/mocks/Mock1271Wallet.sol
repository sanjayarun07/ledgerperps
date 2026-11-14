// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice TEST ONLY smart wallet: valid signature = signed by `controller`.
contract Mock1271Wallet is IERC1271 {
    address public immutable controller;
    constructor(address c) { controller = c; }
    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(hash, sig);
        return e == ECDSA.RecoverError.NoError && r == controller ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
