// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal, ABI-compatible stand-in for mds1's canonical Multicall3 (`aggregate3` only). Used ONLY by the keeper e2e to
/// install code at the canonical address 0xcA11bde05977b3631167028862bE2a173976CA11 on a fresh hardhat node (which has
/// no Multicall3). Real chains already have the canonical contract. No storage, no constructor => runtime code can be
/// installed with hardhat_setCode.
contract Multicall3Lite {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }

    function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; ++i) {
            Result memory r = returnData[i];
            (r.success, r.returnData) = calls[i].target.call(calls[i].callData);
            if (!calls[i].allowFailure && !r.success) revert("Multicall3: call failed");
        }
    }
}
