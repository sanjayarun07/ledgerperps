"""Deploys a FRESH exchange (router + modules + MockUSDC + ManualOracle) to the local hardhat node per test session,
from contracts/artifacts. Skips if no node is listening (start it with `cd contracts && npx hardhat node`)."""
import json
import os
import pathlib

import pytest
from eth_account import Account
from eth_utils import function_signature_to_4byte_selector, keccak
from web3 import Web3

from perps_sdk import PerpClient

Account.enable_unaudited_hdwallet_features()
# NEVER default to :8545 (the Nitro testnode's L1 geth on the dev machine); these tests deploy contracts. Use a private hardhat node
# (`cd contracts && npx hardhat node --port 18660`) or set PERP_RPC_URL explicitly. :8545 is refused.
RPC = os.environ.get("PERP_RPC_URL", "http://127.0.0.1:18660")
if RPC.rstrip("/").endswith(":8545"):
    raise RuntimeError("refusing to run SDK integration tests against :8545 (Nitro testnode L1); use a private hardhat node and PERP_RPC_URL")
ART = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "artifacts" / "src"
MNEMONIC = "test test test test test test test test test test test junk"  # PUBLIC hardhat dev mnemonic
FEED = keccak(b"BTC-USD")


def hh(i):
    return Account.from_mnemonic(MNEMONIC, account_path=f"m/44'/60'/0'/0/{i}")


def art(rel):
    return json.loads((ART / rel).read_text())


def selectors(abi):
    out = []
    for f in abi:
        if f["type"] == "function":
            out.append(function_signature_to_4byte_selector(f"{f['name']}({','.join(_t(i) for i in f['inputs'])})"))
    return out


def _t(i):
    if i["type"].startswith("tuple"):
        return "(" + ",".join(_t(c) for c in i["components"]) + ")" + i["type"][5:]
    return i["type"]


@pytest.fixture(scope="session")
def w3():
    w = Web3(Web3.HTTPProvider(RPC))
    if not w.is_connected():
        pytest.skip("no local node at " + RPC)
    return w


class Env:
    pass


@pytest.fixture(scope="session")
def env(w3):
    admin = hh(0)

    def send(fn):
        tx = fn.build_transaction({"from": admin.address, "nonce": w3.eth.get_transaction_count(admin.address, "pending"), "chainId": w3.eth.chain_id})
        return w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(admin.sign_transaction(tx).raw_transaction))

    def deploy(rel, *args):
        a = art(rel)
        c = w3.eth.contract(abi=a["abi"], bytecode=a["bytecode"])
        tx = c.constructor(*args).build_transaction({"from": admin.address, "nonce": w3.eth.get_transaction_count(admin.address, "pending"), "chainId": w3.eth.chain_id})
        r = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(admin.sign_transaction(tx).raw_transaction))
        return r["contractAddress"]

    usdc = deploy("MockUSDC.sol/MockUSDC.json")
    oracle = deploy("oracles/ManualOracle.sol/ManualOracle.json")
    exchange = deploy("PerpExchange.sol/PerpExchange.json", usdc, oracle, admin.address)
    ex_abi = art("PerpExchange.sol/PerpExchange.json")["abi"]
    core = w3.eth.contract(address=exchange, abi=ex_abi)
    have = set(selectors(ex_abi))
    for n in ["PerpTrading", "PerpExtras", "PerpLiquidation", "PerpTwap", "PerpAdl"]:
        a = art(f"{n}.sol/{n}.json")
        mod = deploy(f"{n}.sol/{n}.json")
        sels = [s for s in selectors(a["abi"]) if s not in have]
        have.update(sels)
        send(core.functions.registerModule(mod, sels))
    send(core.functions.lockModules())
    orc = w3.eth.contract(address=oracle, abi=art("oracles/ManualOracle.sol/ManualOracle.json")["abi"])
    send(orc.functions.set(FEED, 50_000_000_000))
    MAXU = (1 << 128) - 1
    send(core.functions.createMarket(
        (FEED, 100_000, 10_000, 10_000_000, 10**12, 10**13, 3600, 500, 100, 3600, 8, 400_000_000),
        [(100_000_000_000, 1000, 500), (1_000_000_000_000, 2000, 1000), (MAXU, 5000, 2500)],
    ))
    e = Env()
    e.deployment = {"exchange": exchange, "usdc": usdc, "oracle": oracle}
    e.w3 = w3
    e.client = lambda i, **kw: PerpClient(w3, exchange, hh(i), usdc, oracle, **kw)
    e.set_oracle = lambda px: send(orc.functions.set(FEED, px))
    e.set_oracle_at = lambda px, t: send(orc.functions.setAt(FEED, px, t))
    return e


@pytest.fixture(scope="session")
def fund(env):
    from perps_sdk import to_usdc

    def _fund(i, usd):
        c = env.client(i)
        c.mint_mock_usdc(c.owner, to_usdc(usd))
        c.approve_usdc()
        c.deposit(to_usdc(usd))
        return c

    return _fund
