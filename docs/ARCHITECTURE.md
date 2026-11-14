# Architecture and trust model

Target (unverified, not built): Arbitrum Nitro appchain in Rollup mode, USDC collateral, Solidity canonical contracts.
Chosen because the brief forbids a trusted off-chain matching engine; all fills/balances are decided by EVM execution.

## Execution lifecycle (UI must show these separately; no UI exists yet)
API receipt → tx submitted → sequencer accepted (soft confirmation) → canonical execution (receipt) → parent-chain batch posted/finalized → bridge withdrawal available (challenge-period dependent).
Short block times are *not* settlement finality.

## Trust
- Cryptographic: signature checks (EIP-712 + EIP-1271), nonces, deadlines; agents cannot call `withdraw`/`transferInternal`.
- Governance: `DEFAULT_ADMIN_ROLE` (intended: timelock + multisig) sets markets/fees/oracle and can rebalance insurance↔backstop; `GUARDIAN_ROLE` can only restrict. **No timelock contract is wired in this repo yet.** Contract is not upgradeable.
- Economic: oracle quality, backstop solvency, insurance size, liquidator incentives.
- Sequencer: single sequencer orders txs (can reorder/censor within its power). Forced inclusion via the parent-chain inbox exists in Nitro but is delayed; nothing here tests it. Users cannot be promised emergency withdrawals while leveraged obligations are open.
- Off-chain services (none built) would be relayers/keepers/indexers only: no authority over balances.

## Matching bounds
16 price levels, 40 maker touches, 64-level insertion walk, 32 open orders/account, 16 conditionals/account.
GTC hitting bounds: remainder is **not rested** (never leaves a crossed book) and `OrderTruncated` is emitted. FOK reverts atomically. Insertion >64 levels from top reverts (`PriceTooFarFromTop`) — no hint mechanism yet.
Self-trade: cancel resting maker. Cancel/replace: always loses priority.
Price band: a fill whose resting price is more than `bandBps` from the current index is not executed; the resting order is cancelled.
Backstop recognition: `_syncBackstop` (PerpBase) is invoked by `PerpLiquidation` (`liquidate`, `settleDelisted`, permissionless `syncBackstop`), `PerpAdl` (`adl`, once per call) and the router's `withdraw`; ADL-2 health/slack uses `PerpAdl.adlHealth` (single `_riskLiq` site; inlining it twice overflowed the viaIR stack). Governance: `setAdlHardPremBps` and `setWithdrawGate` (admin any value in bounds; guardian may only tighten). Phase 2 (inventory soft cap + auction) is NOT built.
Module placement: `replaceOrder` and `backstopPlace` are served by PerpExtras (via the router's `placeFor` self-call) to keep PerpTrading under EIP-170; selectors are unchanged.
