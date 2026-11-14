"""Quickstart against the local demo deployment (contracts/deployments/localhost.json). LOCAL DEMO ONLY.
Run: .venv/bin/python examples/quickstart.py   (needs `npx hardhat node` + deploy.js --network localhost)"""
import json
import pathlib

from eth_account import Account

from perps_sdk import OrderParams, PerpClient, Tif, from_price, from_size, from_usdc, to_price, to_size, to_usdc

Account.enable_unaudited_hdwallet_features()
dep = json.loads((pathlib.Path(__file__).resolve().parents[3] / "contracts/deployments/localhost.json").read_text())
MNEMONIC = "test test test test test test test test test test test junk"  # PUBLIC hardhat dev mnemonic
key = lambda i: Account.from_mnemonic(MNEMONIC, account_path=f"m/44'/60'/0'/0/{i}")

maker = PerpClient.from_deployment("http://127.0.0.1:8545", dep, key(3).key.hex())
taker = PerpClient.from_deployment("http://127.0.0.1:8545", dep, key(4).key.hex())
for c, usd in ((maker, 20_000), (taker, 5_000)):
    c.mint_mock_usdc(c.owner, to_usdc(usd))
    c.approve_usdc()
    c.deposit(to_usdc(usd))

mark = maker.mark_price(0)
tick = maker.market_config(0).tick
ask_px = (mark * 10050 // 10000) // tick * tick
ask = maker.place_order(OrderParams(0, False, ask_px, to_size("0.1"), Tif.GTC))
print("resting ask", ask.order_id, "@", from_price(ask_px))
fill = taker.market_order(0, True, to_size("0.05"), slippage_bps=100)
print("taker filled", from_size(fill.filled), "@", [from_price(f.price) for f in fill.fills])

# EIP-712 signed order relayed by someone else
signed = taker.sign_order(OrderParams(0, True, to_price("40000"), to_size("0.05")))
res = maker.place_signed(signed)  # maker pays gas; taker's funds trade
print("relayed signed order", res.order_id, "equity", from_usdc(taker.account_state().equity))
taker.cancel_all()
maker.cancel_all()
