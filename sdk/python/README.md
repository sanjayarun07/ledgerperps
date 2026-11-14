# perps-sdk (Python) - UNAUDITED local prototype

web3.py + eth-account client. Same core surface as the TS SDK: deposits/withdraws/internal transfers, limit + market-as-IOC orders
(slippage helper), cancel/cancel_all/replace, EIP-712 signed orders (`sign_order` + `place_signed`), agent keys, keeper calls
(`liquidate`, `write_off`, `sync_backstop`, `backstop_equity`, `adl_health`, `principal`, `poke_funding`, `execute_conditional`), reads (`markets`, `mark_price`, `book_snapshot`, `account_state`, `positions`,
`open_orders`, `oracle_status`, `get_fills`), tick/lot validation and custom-error decoding (`PerpError.error_name`).
Raw units: price 1e6, size 1e8, USDC 1e6 (`to_price/to_size/to_usdc`).

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
python scripts/gen_abi.py          # refresh src/perps_sdk/abi/*.json from contracts/abi
python -m pytest -q                # needs `npx hardhat node`; deploys a fresh exchange per session
python examples/quickstart.py      # needs deploy.js --network localhost
```
Not wrapped (use TS SDK or `client.ex.functions...`): conditional/bracket, TWAP, isolated margin, ADL. The same dev-chain clock-drift
caveat as the TS SDK applies: `PerpClient.sign_order` uses chain time for deadlines.
