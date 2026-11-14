import { keccak256, recoverTypedDataAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildOrderParams } from "./order";
import { ORDER_ACTION_TYPE, orderTypedData, placeSignedArgs, randomNonce } from "./signed";

const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const input = {
  owner: acct.address, sub: 0, nonce: 12345n, deadline: 1_900_000_000n, chainId: 31337, verifyingContract: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as const,
  p: buildOrderParams({ market: 0, isBuy: true, price: 50_000_000_000n, size: 10_000n, type: "limit", tif: "GTC", reduceOnly: false }),
};

describe("placeSigned EIP-712", () => {
  it("struct type string is exactly the contract's ORDER_TYPEHASH preimage (field order and types)", () => {
    const fromTypes = "OrderAction(" + orderTypedData(input).types.OrderAction.map((f) => `${f.type} ${f.name}`).join(",") + ")";
    expect(fromTypes).toBe(ORDER_ACTION_TYPE);
    expect(keccak256(toBytes(ORDER_ACTION_TYPE))).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("a signature recovers to the signer under the exchange domain and changes if any field changes", async () => {
    const td = orderTypedData(input);
    const sig = await acct.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(acct.address);
    const tampered = orderTypedData({ ...input, p: { ...input.p, size: 20_000n } });
    expect(await recoverTypedDataAddress({ ...tampered, signature: sig })).not.toBe(acct.address);
    const otherDomain = orderTypedData({ ...input, chainId: 1 });
    expect(await recoverTypedDataAddress({ ...otherDomain, signature: sig })).not.toBe(acct.address);
  });
  it("call args follow placeSigned(owner, sub, p, nonce, deadline, sig)", () => {
    expect(placeSignedArgs(input, "0x1234")).toEqual([acct.address, 0, input.p, 12345n, 1_900_000_000n, "0x1234"]);
  });
  it("nonces are 128-bit and distinct", () => {
    const a = randomNonce(), b = randomNonce();
    expect(a).not.toBe(b);
    expect(a < 1n << 128n).toBe(true);
  });
});
