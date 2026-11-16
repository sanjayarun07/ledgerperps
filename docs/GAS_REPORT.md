# Gas per operation (deploy #4, Arbitrum Sepolia)

Measured live with `contracts/scripts/testnet/measure-gas.js` on DEMO-USD (so the BTC book was untouched). Raw data: `infra/testnet/gas-report.json`. Code state: git tag `deploy-4-arbsepolia`.

`gasUsed` on Arbitrum includes the L1 data-posting component converted to gas units, so these are the figures that drive cost. Testnet gas price at the time was 0.02 gwei and ETH 1,824.92 USD (testnet feed); dollar figures scale linearly with both.

| Operation | Gas | USD |
|---|---:|---:|
| deposit, first time on a sub-account | 122,627 | 0.0045 |
| deposit, repeat | 68,276 | 0.0025 |
| place GTC, new price level, empty side | 348,769 | 0.0128 |
| place GTC, joins an existing level | 279,941 | 0.0103 |
| place GTC, new level next to an existing one | 337,559 | 0.0124 |
| place post-only, new level | 323,240 | 0.0118 |
| cancel one order (alone at its level) | 79,615 | 0.0029 |
| cancel one order (head of a queue of 2) | 83,444 | 0.0031 |
| replace order (cancel + place, new level) | 326,738 | 0.0120 |
| cancelAll, 2 resting orders | 119,140 | 0.0044 |
| cancelAll, 8 resting orders on 8 levels | 346,816 | 0.0127 |
| taker IOC buy, fills 1 resting order | 311,179 | 0.0114 |
| taker IOC buy, sweeps 3 orders on 3 levels | 369,766 | 0.0135 |
| taker IOC sell, closes position vs 1 bid | 222,636 | 0.0082 |
| pokeFunding | 99,174 | 0.0036 |

## What this says

- **Quoting is the expensive part.** A market maker refreshing one bid and one ask costs two cancels plus two places, about 0.8M gas (about 0.03 USD at these prices). A 5-level ladder per side refreshed every minute is 20 transactions, about 5M gas.
- **A new resting order costs 280k to 350k gas.** The order struct takes 4 storage slots (each fresh slot is 22.1k for the SSTORE alone), plus the price-level and bitmap updates, plus the account's open-order bookkeeping.
- **Cancel is cheap (80k) and `cancelAll` is cheaper per order as the batch grows** (about 43k per order at 8 orders versus 60k at 2), because the fixed per-call overhead is shared. Placing has no equivalent batch today, so every order pays the full per-transaction base cost.
- **Taker fills are comparable to a place** (220k to 370k), and each extra resting order swept adds roughly 30k to 60k.

## What was done about it (all in source, none deployed; see the last section)

1. Batch place, batch cancel and a cancel-and-place `requote`: built and tested.
2. Order storage packed from 4 slots to 3: built and tested.
3. Maker rebate funded by the taker fee (taker 5 bps, maker -1 bp): built and tested.
4. Protocol market-making vault (`docs/VAULT.md`): built and tested.

Dollar costs here are testnet. They are a model, not a mainnet quote.

## Changes built after this measurement (source only, NOT deployed)

Measured in the Hardhat suite (gas there excludes the Arbitrum L1-data component, so compare the ratios, not the absolute numbers to the table above):

| Change | Effect |
|---|---|
| Order struct 4 slots to 3 (reserve `uint96`, order links `uint48`, expiry `uint32`) | 5 separate GTC places: 1,539,013 to 1,427,063 gas (about 22k, or 7%, per resting order) |
| `batchPlace` of 5 orders in one transaction | 880,926 gas, against 1,427,063 for 5 separate places on the new layout and 1,539,013 on the old one (43% less than the old way) |
| `batchCancel`, `requote` | one transaction for a whole cancel-and-replace cycle; per-call overhead and the signer check are paid once |
| Maker rebate (taker 5 bps, maker -1 bp) | not a gas change: it makes quoting earn 1 bp when filled instead of paying 1 bp |

What was not changed, and is the next target if gas still matters: each resting order also pays for the `EnumerableSet` bookkeeping in `openOrders[acct]` (two fresh slots per order). Replacing it with a counter plus an indexer-side list would remove about 40k per order, at the cost of `cancelAll` needing the ids supplied by the caller.

Re-measure with `CONFIRM_MEASURE_GAS=yes npx hardhat --config hardhat.testnet.config.js run scripts/testnet/measure-gas.js --network arbitrumSepolia` after the redeploy (use `GAS_REPORT_FILE=gas-report.deploy5.json` to keep both reports).
