// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL/TESTNET ONLY faucet token. Not real USDC.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC (TEST)", "tUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}
