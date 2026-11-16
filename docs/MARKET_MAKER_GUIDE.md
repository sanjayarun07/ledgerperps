# Connecting an outside market maker (testnet)

**Status: Arbitrum Sepolia testnet only. Unaudited prototype. All collateral is free test USDC; all liquidity is simulated.** Nothing here is a mainnet offer. This guide describes what the code does today and calls out what is missing compared with a venue like Hyperliquid.

## What an outside market maker gets
- A fully on-chain central limit order book: every order, cancel and fill is a transaction on Arbitrum Sepolia. There is no off-chain matching engine and no special market-maker API.
- Reads from a public RPC (or the indexer), writes as signed transactions through the TypeScript SDK (`sdk/ts`, package `@perps/sdk`, not published to npm) or the Python SDK (`sdk/python`).
- A trading-only **agent key** so the bot never holds the key that can withdraw.

## What you need
| Item | Where |
|---|---|
| Deployment manifest (exchange, token, oracle addresses, chain id 421614) | `contracts/deployments/arbitrumSepolia.json` |
| An Arbitrum Sepolia RPC | Any provider. Public ones rate-limit; run a keyed one for a live bot. |
| Testnet ETH for gas | Any Sepolia/Arbitrum Sepolia faucet or bridge |
| Test USDC | Deploy #3 uses `MockUSDC` with a public `mint(to, amount)`; ask the operator or call it. `deployment.collateral === "mock"` tells you. |
| Indexer (optional, for fast reads/streams) | Operator-run; see "Reading data" |

Always read addresses from the manifest. They change on every redeploy.

## Units (raw integers everywhere)
- Price: 1e6 (USDC per base unit). Size: 1e8 (BTC has 8 decimals here). USDC: 1e6.
- Each market has a `tick` (price step), `lot` (size step), `minNotional` and `maxOrderSize`. Read them with `marketConfig(id)`. Orders off the grid revert.
- Account key = `keccak256(abi.encode(owner, sub))`; `sub` is a `uint8` subaccount index.

## Setup
1. Create two keys: a **master** key (owns funds) and an **agent** key (trades).
2. Fund the master: ETH for gas, test USDC, `approveUsdc()`, `deposit(amount, { sub })`.
3. Authorise the agent for a subaccount: `approveAgent(agent, expiry, { sub })` (or `approveAgentScoped` in the contract to limit markets and per-order notional). Agents can place and cancel but **cannot withdraw or transfer**. Keys expire; renew or revoke with `revokeAgent`.
4. The bot builds its client with the agent as signer and the master as `owner`.

### Why several subaccounts
Each account/subaccount can rest at most **32 open orders** (`MAX_OPEN_ORDERS`). A deep ladder needs several subaccounts; funds move between your own subaccounts with `transferInternal`. Margin is per subaccount (cross within it), so fund each one for what it quotes. `bots/src/depth.ts` and `docs/PAPER_TRADING.md` show a worked 3-tier, 6-subaccount ladder.

## Minimal quoting example (TypeScript)
```ts
import { PerpClient, Tif, newCloid } from "@perps/sdk";
import deployment from "./arbitrumSepolia.json" assert { type: "json" };

const c = PerpClient.fromPrivateKey({
  rpcUrl: process.env.RPC_URL!,
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}`, // trading-only key
  owner: process.env.MASTER_ADDRESS as `0x${string}`,          // the funded account
  deployment,
  sub: 4,
});

const market = 0;                                   // BTC-USD in the current deployment
const cfg = await c.marketConfig(market);
const mark = await c.markPrice(market);             // book mid clamped to the oracle index +/- band
const tick = cfg.tick;
const bid = ((mark - mark / 2000n) / tick) * tick;  // about 5 bps below mark
const placed = await c.placeOrder({
  market, isBuy: true, price: bid, size: 10_000n,   // 0.0001 BTC
  tif: Tif.PostOnly,                                // reverts (PostOnlyCross) instead of crossing
  reduceOnly: false, cloid: newCloid(),
  expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), // unix seconds; 0 = never. Acts as your dead-man switch
});
// later: c.replaceOrder(placed.orderId, newOrder), c.cancelOrder(id), c.cancelAll()
```
Method names, arguments and return types are in `sdk/ts/src/client.ts`; `sdk/ts/examples/` has runnable files (quickstart, relayed signed orders, keeper, and `05-outside-market-maker.ts`, a dry-run-by-default quoting loop).

Order types: `GTC`, `IOC`, `FOK`, `PostOnly`. Also available: reduce-only, client order ids (`cloid`, single-use per account), `replaceOrder`, conditional/stop orders, brackets and TWAP.

## Signed orders and relaying
`signOrder` (EIP-712) plus `placeSigned` lets someone else submit your order, with per-owner nonces, a deadline and the same agent scope checks. Useful if you want a separate sender process.

## Reading data
- **RPC reads** (no indexer): `bookSnapshot(market, depth)`, `bestPrice`, `markPrice`, `oracleStatus`, `accountState`, `positions`, `openOrders`, `getFills`, `watchFills`. Simple and always correct, but each call is an RPC request.
- **Indexer REST** (operator-run): `/v1/markets`, `/v1/markets/{id}/book`, `/v1/accounts/{owner}/positions`, `/v1/accounts/{acct}/orders`, `/v1/accounts/{acct}/fills`, `/v1/status`. Note account routes that take an `acct` use the hashed key above.
- **Indexer WebSocket** `/v1/ws`: subscribe with `{channel: "book" | "trades" | "account", ...}`. The book channel is exercised by the frontend; treat the others as less proven.
- The SDK's `IndexerClient` (`sdk/ts/src/indexer.ts`) was rewritten on 2026-11-16 to match the live indexer and exercised against it (markets, book, trades, candles, positions, orders, fills, WebSocket book subscribe). The WS orders channel is read from server source, not exercised. The indexer is derived from events and not authoritative: verify balances and margin on-chain.
- Public RPCs lag and throttle. The repo's bots run through a local forwarder with concurrency 1 for that reason.

## Costs and fees
- Every place, replace and cancel is a transaction. A resting order costs roughly 350k gas on Arbitrum Sepolia (measured on the demo run); replacing every few seconds adds up. The ladder bot uses refresh thresholds and maximum quote ages to cut this.
- Trading fees on the live deployment (read on-chain 2026-11-16): **taker 5 bps, maker 1 bp, and the maker value is a fee, not a rebate** (a negative value would be a rebate). So makers pay here, unlike Hyperliquid's volume-tiered rebates. Confirm with `takerFeeBps()` and `makerFeeBps()` before you size a strategy.
- **Live since deploy #5 (2026-11-16):** the contract default is **taker 5 bps, maker rebate 1 bp** (`makerFeeBps = -1`, funded from the taker fee, never more than it: `setFees` enforces `|maker| <= taker`), a 3-slot order layout (about 22k gas less per resting order), and three batch calls: `batchPlace(owner, sub, orders[], atomic)`, `batchCancel(ids[])` and `requote(owner, sub, cancelIds[], orders[], atomic)`. With `atomic = false` a failing order is skipped and reported by a `BatchItemRejected` event, so one post-only cross does not kill the whole requote. At most 32 orders per call. Measured in the Hardhat suite: 5 places in one `batchPlace` used 881k gas against 1,539k for 5 separate transactions on the old layout (see `docs/GAS_REPORT.md`). The repo's ladder bot (`bots/src/mm.ts`) sends one `requote` per subaccount per tick (set `MM_BATCH=no` to use single orders, and it falls back by itself on an exchange without batch calls); the `/maker` console places its whole ladder with one `batchPlace`.

## Risk rules you must design around
- **Mark price = book mid clamped to index +/- band**; it falls back to the index when the spread exceeds `maxSpreadBps`. Quote inside the band (the repo's bot stays within 80% of it) or your orders can be rejected or your quotes can distort the mark. Liquidations use the mark.
- **Oracle freshness:** if the oracle is stale (`maxAge`) the market degrades: new risk and withdrawals can be blocked. Check `oracleStatus(market)` before quoting.
- **Margin:** tiered initial/maintenance margin by notional (for BTC 10%/5% up to $100k, rising above). A resting order reserves margin.
- **Liquidation:** anyone can liquidate an account below maintenance. A backstop takes inventory and auctions it. There is also ADL. Read `docs/BACKSTOP_DESIGN.md` and `docs/GAPS.md`.
- **Pausing/admin:** the admin can pause markets and, until modules are locked, replace modules. This is a prototype with a single admin key (see `docs/SELF_AUDIT.md`, SA-4).

## Hedging
There is no built-in hedge. One net position per market per subaccount; subaccounts do not net against each other. The reference bot (`bots/`) carries inventory risk on test money, skewing quotes and shrinking size as inventory grows. A real maker would hedge on another venue: read your position with `positions()` or `watchFills`, and send the offsetting order from your own hedging code.

## What is missing compared with Hyperliquid
- No batch place/cancel in one transaction, and no off-chain order submission: latency is block time plus RPC.
- No `scheduleCancel`; the nearest tool is per-order `expiry`.
- No maker rebate tiers, no volume-based rate limits (limits come from your RPC and gas).
- No separate low-latency market-data stream beyond the indexer; no official API wallet tooling beyond `approveAgent`.
- Testnet, free collateral, simulated liquidity, unaudited contracts, no uptime promises.

## Checklist before you connect
1. Manifest is current and `chainId` is 421614.
2. `oracleStatus` is fresh for the market you quote.
3. Agent key approved for the right subaccounts, with an expiry you can monitor.
4. Orders land on `tick`/`lot`, above `minNotional`, within the band.
5. Each subaccount stays at or below 32 resting orders.
6. A stop plan: `cancelAll` per subaccount, or `expiry` set on every order.
