import { bytesToBigInt, type Account, type Address, type Hex, type LocalAccount, type WalletClient } from "viem";
import type { OrderInput, OrderParams, SignedOrder } from "./types.js";
import { Tif } from "./types.js";

export const EIP712_NAME = "PerpExchange";
export const EIP712_VERSION = "1";

/** Must match PerpBase.ORDER_TYPEHASH field-for-field (order matters). */
export const ORDER_ACTION_TYPES = {
  OrderAction: [
    { name: "owner", type: "address" },
    { name: "sub", type: "uint8" },
    { name: "market", type: "uint8" },
    { name: "isBuy", type: "bool" },
    { name: "price", type: "uint64" },
    { name: "size", type: "uint128" },
    { name: "tif", type: "uint8" },
    { name: "reduceOnly", type: "bool" },
    { name: "cloid", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ORDER_TYPE_STRING =
  "OrderAction(address owner,uint8 sub,uint8 market,bool isBuy,uint64 price,uint128 size,uint8 tif,bool reduceOnly,uint64 cloid,uint64 expiry,uint256 nonce,uint256 deadline)";

export function exchangeDomain(chainId: number | bigint, exchange: Address) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId: Number(chainId), verifyingContract: exchange } as const;
}

export function withDefaults(o: OrderInput): OrderParams {
  return {
    market: o.market,
    isBuy: o.isBuy,
    price: o.price,
    size: o.size,
    tif: o.tif ?? Tif.GTC,
    reduceOnly: o.reduceOnly ?? false,
    cloid: o.cloid ?? 0n,
    expiry: o.expiry ?? 0n,
  };
}

/** Random 192-bit nonce (nonces are per-owner, single use, unordered). */
export function randomNonce(): bigint {
  const b = new Uint8Array(24);
  globalThis.crypto.getRandomValues(b);
  return bytesToBigInt(b);
}

export interface SignOrderArgs {
  /** The account whose funds trade (the master). */
  owner: Address;
  sub?: number;
  order: OrderInput;
  chainId: number | bigint;
  exchange: Address;
  /** Either a local account (private key) or a wallet client holding the signing account. */
  signer: LocalAccount | { walletClient: WalletClient; account: Account | Address };
  nonce?: bigint;
  /** unix seconds; default now + 300s */
  deadline?: bigint;
}

/**
 * Produces an EIP-712 signed order for relaying via `placeSigned`. The signer is either the owner or an
 * agent key approved with `approveAgent`; relaying costs the relayer gas only - funds stay with `owner`.
 */
export async function signOrder(a: SignOrderArgs): Promise<SignedOrder> {
  const params = withDefaults(a.order);
  const sub = a.sub ?? 0;
  const nonce = a.nonce ?? randomNonce();
  const deadline = a.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300);
  const message = {
    owner: a.owner,
    sub,
    market: params.market,
    isBuy: params.isBuy,
    price: params.price,
    size: params.size,
    tif: params.tif,
    reduceOnly: params.reduceOnly,
    cloid: params.cloid,
    expiry: params.expiry,
    nonce,
    deadline,
  };
  const base = { domain: exchangeDomain(a.chainId, a.exchange), types: ORDER_ACTION_TYPES, primaryType: "OrderAction" as const, message };
  let signature: Hex;
  let signer: Address;
  if ("signTypedData" in a.signer) {
    signature = await a.signer.signTypedData(base);
    signer = a.signer.address;
  } else {
    const acc = a.signer.account;
    signature = await a.signer.walletClient.signTypedData({ ...base, account: acc } as any);
    signer = typeof acc === "string" ? acc : acc.address;
  }
  return { owner: a.owner, sub, params, nonce, deadline, signature, signer };
}
