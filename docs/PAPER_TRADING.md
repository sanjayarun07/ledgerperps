# BTC paper trading on testnet (real oracle price, thick simulated book)

**Everything here is simulated liquidity on free test collateral, on Arbitrum Sepolia. Unaudited. Not real market depth.** Label it that way in any UI or post.

## What is real and what is not
- **Real:** the BTC price. The market reads Chainlink BTC/USD directly (verified 2026-11-16: 15-63 s old, within about 1-6 bps of Coinbase). Order matching, margin, funding and liquidation run on-chain.
- **Simulated:** all liquidity (our market-maker bot), and the collateral (test USDC).
- **Caveat:** a testnet Chainlink feed updates on its own heartbeat/deviation rules, so it can lag the real price between updates. The pre-flight check measures this.

## Why a deploy #3 is needed first
The bot needs about $91,000 of collateral at full depth (`preflight` computes it). The deployed exchange uses Circle test USDC, which cannot be minted (faucet only). `USE_MOCK_USDC=yes` at deploy time gives a free-mint test token. Deploy #3 also carries the TWAP fix and the SA-1 market-bounds fix. See `docs/TESTNET_RUNBOOK.md` section 17 for the deploy steps, adding `USE_MOCK_USDC=yes`.

BTC `maxOI` is raised to 100 BTC (about $6.4M) in `infra/testnet/testnet.config.json` for deploy #3 (it was 10 BTC, too small for the full depth). On an existing deployment use `setMarketParams`.

## Steps (after deploy #3, in `contracts/` unless noted)
1. Mint test collateral to the bot address (dry run first):
   `TO=<bot address> AMOUNT=150000 CONFIRM_MINT=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/mint-test-usdc.js --network arbitrumSepolia`
2. Send the bot about 0.1 ETH of testnet gas (`fund-mm.js` with `MM_ETH`). The pre-flight prints a rough 24 h estimate.
3. In `bots/`: deposit into sub 0, then fan out to the tier subaccounts:
   - `MM_DEPOSIT_USDC=150000 CONFIRM_MM_SETUP=yes npx tsx src/testnet-mm.ts setup`
   - `DEPTH=thick CONFIRM_MM_FANOUT=yes npx tsx src/testnet-mm.ts fanout` (run without the confirm first to see the transfers)
4. Check everything (read-only, exits 1 on errors): `DEPTH=thick npx tsx src/testnet-mm.ts preflight`
5. Start quoting (refuses to start if pre-flight has errors): `DEPTH=thick MARKETS=BTC-USD npx tsx src/testnet-mm.ts run`
   - Smaller book: `DEPTH_SCALE=0.25`. Another sub range: `DEPTH_SUB_BASE=4` (tiers use subs 4-9).
6. Run the indexer, and the keeper in live mode with its own key (runbook section 17), so funding and liquidations happen.
7. Stop: `DEPTH=thick CONFIRM_MM_STOP=yes npx tsx src/testnet-mm.ts stop` (cancels every tier order and sweeps collateral back to sub 0).

## The ladder (`bots/src/depth.ts`, `THICK_BTC`)
| Tier | Levels per side | Spacing | Clip | Refresh |
|---|---|---|---|---|
| near | 8 | 4 to 25 bps | $2,000 | 3 bps / 5 min |
| mid | 8 | 40 to 145 bps | $6,000 | 12 bps / 15 min |
| far | 8 | 180 to 390 bps | $15,000 | 40 bps / 40 min |

About $184k per side at scale 1. Each tier uses its own pair of subaccounts because one account can rest at most 32 orders. Quotes stay inside 80% of the market's 500 bps price band.

## Pre-flight checks
Oracle fresh and its age; oracle within bps of Coinbase; ladder geometry (32-order limit, band, inside spread below `maxSpreadBps`); clip sizes (lot, minimum notional, max order size); collateral needed against free collateral (suggests `DEPTH_SCALE`); ETH for 24 h (rough); open-interest cap against depth.

## Known limits
- No hedging in thick mode: the bot carries inventory risk on test money. It skews quotes and shrinks size as inventory grows.
- If the oracle lags a real move, takers can pick off the near tier (like a real market maker with a slow feed). This is normal for paper trading.
- The ETH estimate assumes every order is replaced on its max age; actual use depends on price moves.
- Funding only accrues if someone calls `pokeFunding` (the keeper, or `poke-funding.js`).

## Keeping the 1-minute chart moving (simulated taker)
The ladder bot's own taker fires only once per quoting pass (minutes). For a trade every ~20 s use the separate taker, which has its own wallet so it never shares the maker's nonce (`bots/src/testnet-taker.ts`, git-ignored key in `bots/.env.taker-testnet`):
1. `npx tsx src/testnet-taker.ts keygen`, then fund the printed address with ETH and test USDC (`send-eth.js`, `mint-test-usdc.js`).
2. `TAKER_DEPOSIT_USDC=500 CONFIRM_TAKER_SETUP=yes npx tsx src/testnet-taker.ts setup`
3. `TAKER_EVERY_SEC=20 npx tsx src/testnet-taker.ts run` (0.001 BTC per trade, alternating sides; `TAKER_SIZE`, `TAKER_MAX_POS`).
This is simulated activity on free test USDC, not real market activity.
