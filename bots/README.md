# SIMULATED LIQUIDITY - NOT REAL

Local-demo market-maker bots + oracle driver for the UNAUDITED Perps prototype (mock USDC, `ManualOracle`). Uses `@perps/sdk` (`../sdk/ts`, build it first).
Every script prints a banner; oracle driver / seed / taker / bots REFUSE to run unless RPC is loopback AND `chainId == 31337`.

```bash
cd ../contracts && npx hardhat node &                 # terminal 1
cd ../contracts && npx hardhat run scripts/deploy.js --network localhost
cd ../bots && pnpm install
pnpm oracle      # terminal 2: random-walk the ManualOracle (owner key = hardhat #0). Env: STEP_MS SIGMA_BPS REVERT MAX_DEV_PCT SEED MARKETS DURATION_SEC
pnpm seed        # terminal 3: mint MockUSDC + deposit for 3 MM accounts (subs 0 and 1) + 1 taker, then start the bots (--no-start to skip; DURATION_SEC bounds it)
pnpm backstop-taker  # backstop Phase 2 example: watches backstopAuction(market) and takes inventory when the Dutch-auction price beats the book after fee + MIN_EDGE_BPS (DRY RUN unless SEND=1; MARKET, MAX_SIZE, ROUNDS, POLL_MS); local chain only. NOT a keeper job: taking inventory is trading
pnpm taker       # cross the book with IOC market orders (SIDE=buy|sell SIZE ROUNDS MARKET)
pnpm status      # on-chain: oracle/mark, book top, MM equity/positions
pnpm verify      # on-chain: Fill events, fills by the test taker, self-trade check
pnpm test        # unit tests of quote/diff/gate logic (no node needed)
```
Design: each bot (own key) quotes `LEVELS` levels per side around the **oracle** price with `HALF_SPREAD_BPS`, inventory skew (`SKEW_BPS`) and size taper to
`MAX_INV_NOTIONAL_USD`. Bids rest from subaccount 0, asks from subaccount 1 (a side-set per account) and each account posts reduce-only quotes to unwind
its own position. Every quote is pre-checked against the best opposite level so it never takes liquidity. Quotes are limited to 80% of the market's `bandBps` (read from `getMarket`): the exchange cancels a RESTING order with reason `PriceBand` when it would match while outside index +/- `bandBps`. The default personalities (<= ~50 bps) are far inside the deploy.js band of 500 bps; deeper levels from env overrides are dropped. Stale quotes (price moved > `REFRESH_BPS`,
older than `MAX_QUOTE_AGE_SEC`, wrong size) are cancelled and re-placed. All quotes are pulled when the market is not `Normal`, the contract reports the oracle
degraded, or the oracle has not visibly updated for `ORACLE_STALE_SEC` wall-seconds (chain-time age is useless on an automining dev node).

## Testnet market maker (Arbitrum Sepolia, simulated liquidity)
`npm run testnet-mm -- keygen | status | setup | run | stop` (see the header of `src/testnet-mm.ts`). Fresh testnet-only key in the git-ignored `bots/.env.mm-testnet`; refuses any chain but 421614 and refuses the deployer key. Tiny sizes (about $12 per level, 2 levels per side, BTC and ETH), quotes around the on-chain oracle mark, one sub-account. Fund it with `contracts/scripts/testnet/fund-mm.js`. It is not a real market maker: no edge, no hedging, test USDC only.

The bot also runs a tiny taker from sub-account 1 (every `TAKER_EVERY_SEC`, default 45; `0` disables): it crosses one resting quote so trades, candles and 24h stats exist. It funds sub 1 from sub 0 (`TAKER_FUND_USDC`, default 6) when needed. Trades against your own quotes cost about the spread on ~$12.

## Hedged market making (testnet, simulated)
`HEDGE=sim npm run testnet-mm run` hedges the bot's Ledgerline inventory on an in-memory venue (`SimulatedVenue`), priced from Hyperliquid testnet mids when reachable, else the oracle. `HEDGE=ref` only compares the venue mid with the oracle and pulls quotes if they differ by more than `HEDGE_MAX_DIVERGENCE_BPS` (default 150). Tunables: `HEDGE_THRESHOLD_UNITS`, `HEDGE_MAX_CLIP_UNITS`, `HEDGE_COOLDOWN_SEC`.
**Not real hedging:** no order is sent to any real venue. Signing Hyperliquid exchange actions is not implemented, so the hedge book is a simulation (fees at 2.5 bps assumed). A real hedge also needs funded keys on both venues, venue-side margin and liquidation handling, and latency/failure handling. Unit-tested only (pure logic + simulated venue); not run against the live testnet bot, which is out of gas.

### Real Hyperliquid testnet hedging (`HEDGE=hl`)
`HEDGE=hl` sends real signed IOC orders to `api.hyperliquid-testnet.xyz` (testnet only; other hosts are refused). Use a **fresh** testnet key in `HL_PRIVATE_KEY` or `bots/.env.hl-testnet` (git-ignored; never printed; never the deployer or MM key) and fund that address from Hyperliquid's own testnet faucet. The signing scheme (msgpack, keccak, phantom-agent EIP-712, source `b`) is unit-tested for encoding and formatting only. It has NOT been verified against the live API, because that needs a funded key and the operator to run it. First run: `HEDGE=hl HEDGE_MAX_CLIP_UNITS=0.0002 npm run testnet-mm run` and watch the `[hedge]` lines.
