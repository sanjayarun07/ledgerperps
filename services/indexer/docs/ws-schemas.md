# WebSocket protocol (`GET /v1/ws`)

JSON text frames in both directions. **Derived data only, never authoritative for balances** (see README).
All large integers (prices, sizes, amounts) are decimal strings; ids, `seq`, block numbers and timestamps are numbers.

Scales: price 1e6, size 1e8, USDC 1e6.

## Client -> server

| message | meaning |
|---|---|
| `{"op":"subscribe","channel":"book","market":0}` | snapshot, then deltas |
| `{"op":"subscribe","channel":"trades","market":0}` | every fill in the market |
| `{"op":"subscribe","channel":"candles","market":0,"interval":"1m"}` | `1m`, `5m`, `1h`; the forming candle is re-sent on every fill |
| `{"op":"subscribe","channel":"orders","acct":"0x<32-byte key>"}` | order state changes of an account |
| `{"op":"subscribe","channel":"fills","acct":"0x<32-byte key>"}` | fills where the account is maker or taker |
| `{"op":"unsubscribe", ...same fields...}` | |
| `{"op":"resnapshot","channel":"book","market":0}` | request a fresh book snapshot |
| `{"op":"ping"}` | server answers `{"type":"pong"}` (the server also sends WS ping frames every 20 s) |

`acct` may also be a 20-byte owner address, with an optional `"sub": <0..255>` field (default 0).
Limits: 64 subscriptions per connection, 4 KiB per client frame.

## Server -> client

```jsonc
{"type":"subscribed","channel":"book","market":0,"interval":null,"acct":null}

// book: full snapshot, then one delta per level change
{"type":"snapshot","channel":"book","market":0,"seq":42,
 "bids":[["49000000000","75000000"]],            // [price,size], best (highest) first
 "asks":[["50100000000","30000000"]]}              // best (lowest) first
{"type":"delta","channel":"book","market":0,"seq":43,"side":"ask","price":"50100000000","size":"10000000"}
//   size = NEW TOTAL at that level; "0" removes the level

{"type":"trade","channel":"trades","market":0,"data":{ /* Fill, same schema as REST */ }}
{"type":"candle","channel":"candles","market":0,"interval":"1m","data":{"t":1020,"o":"..","h":"..","l":"..","c":"..","v":"..","qv":"..","n":3}}
{"type":"order","channel":"orders","acct":"0x..","data":{ /* OrderRow, same schema as REST */ }}
{"type":"fill","channel":"fills","acct":"0x..","role":"maker","data":{ /* Fill */ }}

{"type":"resync","reason":"reorg","fork_block":1234}   // see "Reorgs"
{"type":"error","code":"invalid_argument","message":"..."}
{"type":"pong"}
```

Error codes on the socket: `invalid_argument`, `unknown_channel`, `unknown_op`, `too_many_subscriptions`.

## Book sequence numbers and gap detection

`seq` is a per-market counter of book-changing events (rest, fill, cancel). It is derived deterministically from the
chain's event log, so the same history always yields the same numbers (REST `GET /v1/markets/{m}/book` returns the
same `seq`).

* The snapshot is taken and the subscription registered atomically (under the read-model lock), so the first delta
  after a snapshot with `seq = N` always has `seq = N+1`: no gaps and no duplicates.
* Client algorithm: keep `last_seq`. On `delta`, require `seq == last_seq + 1`. If `seq <= last_seq` ignore it
  (duplicate). If `seq > last_seq + 1`, you missed messages: discard local state and send `resnapshot`, buffer deltas
  until the `snapshot` arrives, then drop buffered deltas with `seq <= snapshot.seq` and apply the rest.
* Deltas are emitted as blocks are indexed, so a client sees the book as of the indexed head, which lags the chain head
  by `lag_blocks` (see `/v1/status`). `Fill` events that exhaust a resting order arrive after the contract's
  `OrderCanceled(Filled)`; the indexer defers that level change to the fill so level sizes never go negative.

## Backpressure

Each connection has a bounded outbound queue (`--ws-queue`, default 256 messages). The indexer never blocks on a client:
if the queue is full the client is **dropped** and the server sends a close frame with code **4008**
(`slow consumer: queue overflow, reconnect and resnapshot`). Messages already queued are still delivered first. Other
close codes: `1001` server going away. `ws_dropped_slow_total` counts drops.

## Reorgs

If the chain reorganises, the indexer rolls back its derived rows and replays the surviving event log. Every connection
then receives `{"type":"resync","reason":"reorg","fork_block":N}` followed by a fresh `snapshot` for each subscribed book.
Per-market `seq` restarts from the replayed history, so after `resync` discard all local book state (a `seq` may go
backwards). `trade`, `order`, `fill` and `candle` messages already delivered for orphaned blocks are **not** retracted:
re-fetch REST history (`indexed_block` tells you the head the data reflects) when you receive `resync`.

## Reconnecting

1. Reconnect with exponential backoff and jitter (start 250 ms, cap 10 s). 4008 means you were too slow: reduce work per
   message or subscribe to fewer channels before reconnecting.
2. Re-send every `subscribe`. Book subscriptions start with a fresh `snapshot`; reset `last_seq` from it.
3. There is **no replay** of missed `trade` / `order` / `fill` / `candle` messages. After a reconnect, backfill from REST
   using the last id/cursor you processed (`/v1/markets/{m}/trades?order=asc&cursor=...`,
   `/v1/accounts/{a}/orders|fills`), then continue from the stream; de-duplicate by `trade_id` / order `id`.
4. The connection is subject to the same rate limit and API-key rules as REST on connect (per key when a key is sent, else per client IP; HTTP 401 without a required key, 429 with `Retry-After` on upgrade).
