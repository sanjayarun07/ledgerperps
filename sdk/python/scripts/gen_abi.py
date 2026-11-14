"""Copies + normalises contracts/abi/*.json into src/perps_sdk/abi/ (ethers' JSON has stateMutability 'undefined')."""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "abi"
out = pathlib.Path(__file__).resolve().parents[1] / "src" / "perps_sdk" / "abi"
out.mkdir(parents=True, exist_ok=True)


def fix_io(x):
    o = {"type": x["type"], "name": x.get("name", "")}
    if "indexed" in x:
        o["indexed"] = x["indexed"]
    if "components" in x:
        o["components"] = [fix_io(c) for c in x["components"]]
    return o


def norm(abi):
    res = []
    for f in abi:
        if f["type"] not in ("function", "event", "error"):
            continue
        o = {"type": f["type"], "name": f["name"], "inputs": [fix_io(i) for i in f.get("inputs", [])]}
        if f["type"] == "function":
            o["outputs"] = [fix_io(i) for i in f.get("outputs", [])]
            sm = f.get("stateMutability")
            o["stateMutability"] = sm if sm in ("view", "pure", "payable") else "nonpayable"
        if f["type"] == "event":
            o["anonymous"] = False
        res.append(o)
    return res


for src, dst in [("PerpExchange.merged.json", "exchange.json"), ("MockUSDC.json", "erc20.json"), ("ManualOracle.json", "oracle.json")]:
    data = norm(json.loads((root / src).read_text()))
    (out / dst).write_text(json.dumps(data, indent=1))
    print("wrote", dst, len(data))
