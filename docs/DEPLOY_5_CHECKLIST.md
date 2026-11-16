# Deploy #5 checklist (DONE 2026-11-16, exchange 0x5524Edf75e1eE356FeA9557E6f209D06ce4768E8)

The contracts in `contracts/src` have moved ahead of the live deploy #4 (git tag `deploy-4-arbsepolia`). A redeploy needs the user's go-ahead; this is what must change with it.

## Contract changes since deploy #4
1. Order struct packed into 3 slots; the public `orders(id)` getter now returns `(acct, size, reserve, market, isBuy, reduceOnly, price, expiry, prev, next, cloid)`. **Old order: `(acct, size, reserve, price, expiry, prev, next, cloid, market, isBuy, reduceOnly)`.**
2. New functions `batchPlace`, `batchCancel`, `requote`, constant `MAX_BATCH`; new events `BatchItemRejected`, `FeesUpdated`.
3. Default `makerFeeBps = -1` (rebate). `setFees` now emits `FeesUpdated`.
4. `expiry` above `uint32` max now reverts (`BadParam("expiry")`).
5. New contract `MarketMakerVault` (optional, separate deploy; see `docs/VAULT.md`).

## Things that read the old layout and must be regenerated or edited at redeploy
- `contracts/abi/PerpExchange.merged.json` (`node scripts/export-abi.js`), then copy to `sdk/ts/src/abi.ts`, `sdk/python/src/perps_sdk/abi/exchange.json` and the frontend generated ABI.
- `sdk/ts/src/client.ts` `getOrder` (about line 651) and `sdk/python/src/perps_sdk/client.py` `get_order` (about line 381) index the tuple by position: price moves from index 3 to 6, expiry 4 to 7, cloid 7 to 10, market 8 to 3, isBuy 9 to 4, reduceOnly 10 to 5. Do not change them before the redeploy: the live exchange still has the old order.
- Add SDK wrappers for `batchPlace`, `batchCancel`, `requote`.
- The Rust indexer and keeper decode events, not `orders()`; check their ABI/event lists for the two new events (unknown events should be ignored, confirm).
- `infra/testnet/testnet.config.json` (optional fee override), `contracts/deployments/arbitrumSepolia.json`, `frontend/src/generated/deployment.testnet.json`, `docs/MARKET_MAKER_GUIDE.md` fee text, README live addresses.
- Then: `docs/TESTNET_RUNBOOK.md` section 18 (move the keeper), indexer resync, bots, re-run `smoke-testnet.js` and `measure-gas.js`.

## Status
Deployed and smoke-tested (14/14, live Chainlink included), backstop enabled, ABIs regenerated, TS and Python SDK `getOrder`/`get_order` updated and batch wrappers added, indexer reset, bots redeployed. `MarketMakerVault` is NOT deployed. The user's own keeper (started from their shell with their key) still points at deploy #3 or #4 and must be moved: `docs/TESTNET_RUNBOOK.md` section 18.
