# Market-making vault (testnet, unaudited)

`contracts/src/MarketMakerVault.sol`. A pooled market-making account for the Ledgerline exchange. **Source and tests only: it is not deployed.** Simulated liquidity on a testnet; no claim of audit or mainnet readiness.

## What it does
- Depositors put in USDC and receive ERC-20 shares (`LLMM`, 12 decimals).
- The vault contract owns one exchange sub-account (`sub`, set at deploy) and forwards every deposit there as collateral.
- A protocol-run **operator bot** quotes from that account with a scoped session key (`setOperator`): it can place and cancel orders in the markets named by `marketMask`, up to `maxOrderNotional` per order, until `expiry`. It can never withdraw or transfer (the exchange only lets the owner do that, and the owner is the vault).
- Share price = (idle USDC + exchange equity of the vault account) / shares. Equity includes unrealised PnL and funding, floored at zero.
- Redeem pays USDC from idle cash first, then withdraws from the exchange. It can only pay what the exchange lets that sub-account withdraw (equity less initial margin less margin reserved by resting orders), so while the operator holds a large position `redeem` reverts with `InsufficientLiquidity` and `maxRedeem(owner)` tells a holder how many shares can leave right now.

## Controls
| Control | Who | Effect |
|---|---|---|
| `setOperator(agent, expiry, marketMask, maxOrderNotional)` | admin | Authorises the key; replacing the operator revokes the previous key |
| `revokeOperator()` | admin or guardian | Cuts the operator off immediately |
| `setDepositsPaused(bool)` | guardian | Blocks new deposits only; redemptions are never blocked by the vault |
| `setParams(depositCap, lockSeconds)` | admin | Cap on total vault assets after a deposit; lock up to 7 days |

Other protections: virtual shares/assets (inflation-attack guard), `minShares` / `minAssets` slippage arguments, a lock on every holder after receiving shares by deposit (a transfer passes the later lock time on, so it cannot be used to skip it), and new deposits are refused while equity is zero but shares exist (`Impaired`).

## Trust model: read this
This is **not** trustless market making.
1. The operator can lose depositors' money by quoting badly, or by trading at bad prices against an accomplice. Scope, per-order cap, lock and revocation limit and shorten this; they do not remove it.
2. NAV uses the exchange's mark-based equity. A mark moved inside its oracle band moves NAV. The lock and deposit cap make exploiting that costly; they do not make it impossible.
3. Withdrawals can be delayed when the account's free margin is low. If the oracle is stale for a market the vault holds a position in, `totalAssets()` reverts, so deposits and redemptions fail closed until the feed recovers.
4. A single admin key controls the parameters, as on the exchange itself (SA-4 in `docs/SELF_AUDIT.md`).
5. No performance or management fee is implemented. The vault earns the maker rebate and the spread, and loses to adverse selection, like any maker.

## Tests
`contracts/test/vault.test.js`, 16 tests: deposit/mint/forward, equal share price, NAV following profit and loss, lock, transfer cannot skip the lock, redeem limited by free margin with partial redeem, operator cannot withdraw or use admin functions, operator scope (market mask, order cap), revoke and replace operator, cap and pause, slippage guards, donation (inflation) attack, impaired vault refuses deposits, `pushIdle` and the exchange ledger identity.

## Not done
No deploy script, no frontend, no operator bot. The bot would be the existing ladder bot signed with the operator key and pointed at the vault address (`placeOrder(vaultAddress, sub, ...)`).
