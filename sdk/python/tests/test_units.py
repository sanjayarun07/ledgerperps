import pytest

from perps_sdk import (MarketLimits, from_price, from_size, from_usdc, round_price_to_tick, slippage_price, to_price, to_size, to_usdc,
                       validate_order)


def test_conversions():
    assert to_price("50000.1") == 50_000_100_000
    assert to_size("0.25") == 25_000_000
    assert to_usdc(100.5) == 100_500_000
    assert from_price(50_000_100_000) == "50000.1"
    assert from_size(1) == "0.00000001"
    assert from_usdc(1_000_000) == "1"
    assert from_usdc(-1_500_000) == "-1.5"
    with pytest.raises(ValueError):
        to_price("0.0000001")


def test_tick_and_slippage():
    assert round_price_to_tick(50_000_149_999, 100_000, "down") == 50_000_100_000
    assert round_price_to_tick(50_000_100_001, 100_000, "up") == 50_000_200_000
    assert slippage_price(True, to_price(50000), 50, 100_000) == to_price(50250)
    assert slippage_price(False, to_price(50000), 50, 100_000) == to_price(49750)
    assert slippage_price(True, 50_000_123_457, 0, 100_000) == 50_000_200_000
    assert slippage_price(False, 50_000_123_457, 0, 100_000) == 50_000_100_000


def test_validate():
    m = MarketLimits(100_000, 10_000, 10_000_000, 10**12)
    assert validate_order(m, to_price(50000), to_size("0.01")) == []
    assert "tick" in validate_order(m, 50_000_050_000, to_size("0.01"))[0]
    assert "lot" in validate_order(m, to_price(50000), 12_345)[0]
    assert "min_notional" in validate_order(m, to_price(50000), to_size("0.0001"))[0]
    assert validate_order(m, to_price(50000), to_size("0.0001"), reduce_only=True) == []


def test_cancel_reason_price_band_and_abi_write_off():
    import json
    import pathlib

    from perps_sdk import CancelReason, cancel_reason_text

    assert CancelReason.PRICE_BAND == 8
    assert "too far from the oracle price" in cancel_reason_text(8)
    assert "99" in cancel_reason_text(99)
    abi = json.loads((pathlib.Path(__file__).resolve().parents[1] / "src" / "perps_sdk" / "abi" / "exchange.json").read_text())
    w = [f for f in abi if f["type"] == "function" and f["name"] == "writeOff"]
    assert w and [i["type"] for i in w[0]["inputs"]] == ["bytes32", "uint8"]
    assert any(f["type"] == "event" and f["name"] == "BadDebtUnresolved" for f in abi)


def test_backstop_phase1_abi_and_gated_message():
    import json
    import pathlib

    from perps_sdk.errors import _HUMAN

    abi = json.loads((pathlib.Path(__file__).resolve().parents[1] / "src" / "perps_sdk" / "abi" / "exchange.json").read_text())
    fns = {f["name"]: f for f in abi if f["type"] == "function"}
    for n in ["syncBackstop", "backstopEquity", "adlHealth", "setAdlHardPremBps", "setWithdrawGate", "adlHardPremBps", "bsInsDrawn", "bsDebt", "wdGateThreshold", "principal"]:
        assert n in fns, n
    assert [o["type"] for o in fns["adlHealth"]["outputs"]] == ["int256", "uint256"]
    assert {e["name"] for e in abi if e["type"] == "event"} >= {"BackstopSynced", "AdlSkipped", "AdlHardPremSet", "WithdrawGateSet"}
    assert any(e["type"] == "error" and e["name"] == "WithdrawGated" for e in abi)
    assert "temporarily limited while the exchange has unresolved bad debt" in _HUMAN["WithdrawGated"]


def test_abi_carries_backstop_phase2_surface():
    import json
    import pathlib

    from perps_sdk.errors import _HUMAN

    abi = json.loads((pathlib.Path(__file__).resolve().parents[1] / "src" / "perps_sdk" / "abi" / "exchange.json").read_text())
    assert len(abi) == 199
    fns = {f["name"]: f for f in abi if f["type"] == "function"}
    for n in ["backstopAuction", "backstopCfg", "backstopPlaceOpen", "backstopTakeFeeBps", "pokeBackstop", "setBackstopCfg", "setBackstopPlaceOpen", "setBackstopTakeFee", "takeBackstop", "unwindBackstop"]:
        assert n in fns, n
    assert [o["type"] for o in fns["backstopAuction"]["outputs"]] == ["bool", "bool", "uint256", "uint256", "uint256"]
    assert [i["type"] for i in fns["takeBackstop"]["inputs"]] == ["address", "uint8", "uint8", "uint128", "uint64"]
    assert [i["type"] for i in fns["unwindBackstop"]["inputs"]] == ["bytes32[]", "uint8"]
    assert {e["name"] for e in abi if e["type"] == "event"} >= {"BackstopCfgSet", "BackstopElevated", "BackstopPlaceOpenSet", "BackstopRelaxed", "BackstopTakeFeeSet", "BackstopTaken", "BackstopUnwound"}
    assert any(e["type"] == "error" and e["name"] == "BackstopCap" for e in abi)
    assert "backstop already holds" in _HUMAN["BackstopCap"]
