# Testnet mode (frontend)

Everything is driven by the chain id (`NEXT_PUBLIC_CHAIN_ID`) or an explicit `NEXT_PUBLIC_NETWORK_KIND=local|testnet|mainnet`. Pure rules live in `src/lib/network.ts`; `src/lib/config.ts` wires the env.

| | local (31337/1337) | testnet (421614 Arbitrum Sepolia) | mainnet (42161, 1, unknown ids) |
|---|---|---|---|
| Banner | LOCAL DEMO - mock USDC, manual oracle, not real liquidity | TESTNET - Arbitrum Sepolia - test funds only | MAINNET - <name> - real funds at risk |
| Override via `NEXT_PUBLIC_REAL_DEPLOYMENT=1` + `disclaimer.override` | yes (unchanged) | never (testnet banner cannot be hidden) | yes |
| Renders without REAL_DEPLOYMENT | yes | yes | NO: "Refusing to start" page |
| Footer | "Local demo chain" + unaudited notice | "Arbitrum Sepolia (testnet)" + unaudited notice | chain name + notice |
| Wallet | injected + Hardhat/random burner | injected only (burner hidden) | injected only |
| Faucets in the Account drawer | mint button (MockUSDC) | Circle USDC faucet + ETH faucet link | none |
| USDC ABI | MockUSDC | plain ERC-20 (approve/allowance/balanceOf) | plain ERC-20 |
| Explorer links | none | sepolia.arbiscan.io (tx, exchange address) | arbiscan.io |

Env: `NEXT_PUBLIC_RPC_URL` (default per network), `NEXT_PUBLIC_EXPLORER_URL` (override), `NEXT_PUBLIC_INDEXER_URL`.

- **Wrong network:** a banner "Trading is disabled until you switch to Arbitrum Sepolia" with a "Switch to Arbitrum Sepolia" action; the ticket's primary button becomes the same action. wagmi sends `wallet_switchEthereumChain`, then `wallet_addEthereumChain` (chain id 0x66eee, RPC, explorer) if the wallet does not know the chain.
- **Deposit:** state machine `depositStep` (enter amount / insufficient / needs approve / ready / approving / depositing) with two-step text; 6 decimals; allowance read from the chain.
- **Transactions:** toasts show "Approve this order in your wallet." while signing, a View on explorer link, and confirmation depth. Receipts are polled with backoff (1s to 8s cap, straight to the cap on a rate limit, 3 minute deadline off-local); public client polls every 4s and batches 20 on non-local.
- **Oracle degraded:** specific text naming the Pyth/Chainlink source (`oracleDegradedText`); age is supported but the chain read does not expose it yet, so the banner omits the age.

## Verification
Unit tests: `src/lib/network.test.ts`, `src/test/testnet-wallet.test.ts` (mock EIP-1193). Browser: private dev server `NEXT_DIST_DIR=.next-testnet NEXT_PUBLIC_CHAIN_ID=421614 next dev -p 3247` against the LOCAL chain with `scripts/dev/mock-wallet.js`; screenshots in `docs/screens/testnet/`. Audit: `AUDIT_PORT=3247 sh scripts/dev/ticket-audit.sh`.
NOT verified: a real wallet, the real Arbitrum Sepolia RPC, real Circle USDC (6-decimals assumed, not read), real receipts and rate limits, Pyth/Chainlink age display.
