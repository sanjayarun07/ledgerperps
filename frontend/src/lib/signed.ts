import type { Address, Hex } from "viem";
import type { OrderParams } from "./order";

/**
 * EIP-712 typed data for PerpExchange.placeSigned. Must match contracts/src/PerpBase.sol:
 *   ORDER_TYPEHASH = keccak256("OrderAction(address owner,uint8 sub,uint8 market,bool isBuy,uint64 price,uint128 size,uint8 tif,bool reduceOnly,uint64 cloid,uint64 expiry,uint256 nonce,uint256 deadline)")
 *   domain = EIP712("PerpExchange", "1"), chainId, verifyingContract = the exchange (router).
 * The signer is the owner (EOA, or EIP-1271 wallet) or an unexpired session key of the subaccount; anyone may relay it.
 */
export const ORDER_ACTION_TYPE = "OrderAction(address owner,uint8 sub,uint8 market,bool isBuy,uint64 price,uint128 size,uint8 tif,bool reduceOnly,uint64 cloid,uint64 expiry,uint256 nonce,uint256 deadline)";
export const ORDER_TYPES = {
  OrderAction: [
    { name: "owner", type: "address" }, { name: "sub", type: "uint8" }, { name: "market", type: "uint8" }, { name: "isBuy", type: "bool" },
    { name: "price", type: "uint64" }, { name: "size", type: "uint128" }, { name: "tif", type: "uint8" }, { name: "reduceOnly", type: "bool" },
    { name: "cloid", type: "uint64" }, { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;

export interface SignedOrderInput { owner: Address; sub: number; p: OrderParams; nonce: bigint; deadline: bigint; chainId: number; verifyingContract: Address }

export function orderTypedData(i: SignedOrderInput) {
  return {
    domain: { name: "PerpExchange", version: "1", chainId: i.chainId, verifyingContract: i.verifyingContract },
    types: ORDER_TYPES,
    primaryType: "OrderAction" as const,
    message: {
      owner: i.owner, sub: i.sub, market: i.p.market, isBuy: i.p.isBuy, price: i.p.price, size: i.p.size, tif: i.p.tif, reduceOnly: i.p.reduceOnly,
      cloid: i.p.cloid, expiry: i.p.expiry, nonce: i.nonce, deadline: i.deadline,
    },
  };
}

/** Random 128-bit nonce: nonces are one-shot per owner (`nonceUsed[owner][nonce]`) and need not be sequential. */
export function randomNonce(rand: (n: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): bigint {
  const b = rand(new Uint8Array(16));
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
}

/** The calldata arguments of placeSigned(owner, sub, p, nonce, deadline, sig). */
export const placeSignedArgs = (i: SignedOrderInput, sig: Hex) => [i.owner, i.sub, i.p, i.nonce, i.deadline, sig] as const;
