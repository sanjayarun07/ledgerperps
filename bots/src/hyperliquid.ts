/**
 * Hyperliquid TESTNET hedge venue: real signed orders against api.hyperliquid-testnet.xyz.
 * Testnet only: any other host is refused. The key (HL_PRIVATE_KEY or bots/.env.hl-testnet) is a SEPARATE testnet key, never the deployer or MM key,
 * and is never printed. The wallet needs testnet funds from Hyperliquid's own faucet.
 * Signing follows Hyperliquid's documented L1-action scheme (msgpack -> keccak -> phantom "Agent" EIP-712, chainId 1337, source "b" = testnet).
 * UNVERIFIED against the live API until a funded key runs it: unit tests cover the encoding and wire formatting only.
 */
import { encode } from "@msgpack/msgpack";
import { hexToBytes, keccak256, concat, toHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { HedgeVenue } from "./hedge.js";

export const HL_TESTNET = "https://api.hyperliquid-testnet.xyz";

/** Hyperliquid wire number: up to 8 decimals, no trailing zeros, no exponent. */
export function floatToWire(x: number): string {
  const s = x.toFixed(8);
  const t = s.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
}

/** Perp price rule: at most 5 significant figures and at most (6 - szDecimals) decimals; integers always allowed. */
export function roundPerpPrice(px: number, szDecimals: number): number {
  if (Number.isInteger(px)) return px;
  const sig = Number(px.toPrecision(5));
  return Number(sig.toFixed(Math.max(0, 6 - szDecimals)));
}

export function roundSize(sz: number, szDecimals: number): number {
  return Number(sz.toFixed(szDecimals));
}

export interface OrderAction {
  type: "order";
  orders: { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Ioc" | "Gtc" | "Alo" } } }[];
  grouping: "na";
}

export function buildOrderAction(asset: number, isBuy: boolean, px: number, sz: number, reduceOnly: boolean, tif: "Ioc" | "Gtc" | "Alo" = "Ioc"): OrderAction {
  // key order matters: the hash is over the msgpack bytes
  return { type: "order", orders: [{ a: asset, b: isBuy, p: floatToWire(px), s: floatToWire(sz), r: reduceOnly, t: { limit: { tif } } }], grouping: "na" };
}

/** keccak256(msgpack(action) || nonce(8 bytes BE) || 0x00)  (no vault address) */
export function actionHash(action: unknown, nonce: number): Hex {
  const data = encode(action);
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  return keccak256(concat([toHex(data), toHex(n), "0x00"]));
}

export async function signL1Action(account: PrivateKeyAccount, action: unknown, nonce: number): Promise<{ r: Hex; s: Hex; v: number }> {
  const sig = await account.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: "b", connectionId: actionHash(action, nonce) },
  });
  const bytes = hexToBytes(sig);
  return { r: toHex(bytes.slice(0, 32)), s: toHex(bytes.slice(32, 64)), v: bytes[64]! };
}

interface Meta { universe: { name: string; szDecimals: number }[] }

export class HyperliquidVenue implements HedgeVenue {
  readonly name = "hyperliquid-testnet";
  readonly canTrade = true;
  readonly account: PrivateKeyAccount;
  private meta?: Meta;
  private lastNonce = 0;
  constructor(privateKey: Hex, private base = HL_TESTNET, private fetchImpl: typeof fetch = fetch, private slippage = 0.03) {
    if (new URL(base).hostname !== "api.hyperliquid-testnet.xyz") throw new Error(`REFUSING: ${base} is not the Hyperliquid testnet API`);
    this.account = privateKeyToAccount(privateKey);
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await this.fetchImpl(`${this.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`hyperliquid ${path} HTTP ${r.status}`);
    return (await r.json()) as T;
  }
  private async asset(symbol: string) {
    this.meta ??= await this.post<Meta>("/info", { type: "meta" });
    const i = this.meta.universe.findIndex((u) => u.name === symbol);
    if (i < 0) throw new Error(`hyperliquid testnet has no perp ${symbol}`);
    return { index: i, szDecimals: this.meta.universe[i]!.szDecimals };
  }
  async mid(symbol: string): Promise<number> {
    const mids = await this.post<Record<string, string>>("/info", { type: "allMids" });
    const v = Number(mids[symbol]);
    if (!(v > 0)) throw new Error(`hyperliquid has no mid for ${symbol}`);
    return v;
  }
  async position(symbol: string): Promise<number> {
    const st = await this.post<{ assetPositions: { position: { coin: string; szi: string } }[] }>("/info", { type: "clearinghouseState", user: this.account.address });
    return Number(st.assetPositions.find((p) => p.position.coin === symbol)?.position.szi ?? 0);
  }
  async marketOrder(symbol: string, isBuy: boolean, size: number): Promise<{ price: number }> {
    const { index, szDecimals } = await this.asset(symbol);
    const mid = await this.mid(symbol);
    const px = roundPerpPrice(mid * (1 + (isBuy ? 1 : -1) * this.slippage), szDecimals);
    const sz = roundSize(size, szDecimals);
    if (sz <= 0) throw new Error("hedge size rounds to zero");
    const action = buildOrderAction(index, isBuy, px, sz, false, "Ioc");
    const nonce = Math.max(Date.now(), this.lastNonce + 1); this.lastNonce = nonce;
    const res = await this.post<{ status: string; response?: unknown }>("/exchange", { action, nonce, signature: await signL1Action(this.account, action, nonce) });
    if (res.status !== "ok") throw new Error(`hyperliquid rejected: ${JSON.stringify(res).slice(0, 200)}`);
    const st = (res.response as { data?: { statuses?: { filled?: { avgPx: string }; error?: string }[] } } | undefined)?.data?.statuses?.[0];
    if (st?.error) throw new Error(`hyperliquid order: ${st.error}`);
    if (!st?.filled) throw new Error("hyperliquid IOC order did not fill");
    return { price: Number(st.filled.avgPx) };
  }
}
