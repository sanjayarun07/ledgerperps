// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Re-exported so the audited OpenZeppelin timelock is compiled and deployable from this repo.
// Deployment pattern (scripts/deploy-governed.js): proposers/executors = multisig, minDelay >= 24h on a real network,
// then grant DEFAULT_ADMIN_ROLE on the exchange to the timelock and renounce the deployer's role.
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
