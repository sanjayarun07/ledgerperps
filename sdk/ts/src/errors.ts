import { decodeErrorResult, type Hex } from "viem";
import { erc20ErrorsAbi, exchangeAbi } from "./abi.js";

const ERROR_ABI = [...exchangeAbi.filter((x) => x.type === "error"), ...erc20ErrorsAbi] as const;

const HUMAN: Record<string, string> = {
  NotAuthorized: "caller is not the account owner or an unexpired agent (or the signature is invalid)",
  BadParam: "invalid parameter",
  MarketRestricted: "market is paused/degraded or the exchange is globally paused",
  OracleDegraded: "oracle price is missing or stale; no risk-taking allowed",
  Unhealthy: "insufficient margin / withdrawable collateral",
  ReduceOnlyViolation: "order would not reduce the position (reduce-only market or order)",
  PostOnlyCross: "post-only order would cross the book",
  FokUnfilled: "fill-or-kill order could not be completely filled",
  DuplicateClientId: "client order id (cloid) already used on this account",
  TooManyOrders: "too many open orders / conditionals / TWAPs on this account",
  PriceTooFarFromTop: "price is too far from the top of book to insert",
  OICap: "open-interest cap reached",
  NotLiquidatable: "account is above maintenance margin",
  Expired: "order or signature has expired",
  BackstopCap: "The exchange's backstop already holds as much of this market as it is allowed to; discretionary backstop orders are refused until the inventory is reduced",
  WithdrawGated: "Withdrawals above your deposited amount are temporarily limited while the exchange has unresolved bad debt (you can still withdraw up to your principal(acct))",
};

/** A decoded custom error from the exchange (or ERC20/OpenZeppelin). */
export class PerpError extends Error {
  constructor(
    public readonly errorName: string,
    public readonly args: readonly unknown[] = [],
    public readonly raw?: Hex,
    options?: { cause?: unknown },
  ) {
    const detail = args.length ? `(${args.map((a) => String(a)).join(", ")})` : "";
    super(`${errorName}${detail}${HUMAN[errorName] ? `: ${HUMAN[errorName]}` : ""}`, options);
    this.name = "PerpError";
  }
  is(name: string, firstArg?: unknown): boolean {
    return this.errorName === name && (firstArg === undefined || this.args[0] === firstArg);
  }
}

function tryDecode(data: Hex, cause: unknown): PerpError | undefined {
  try {
    const d = decodeErrorResult({ abi: ERROR_ABI as any, data });
    return new PerpError(d.errorName, (d.args as readonly unknown[]) ?? [], data, { cause });
  } catch {
    return undefined;
  }
}

/** Collects every 0x-hex string (len >= 10) reachable via cause/data/raw/error/details fields. */
function collectHex(e: unknown, out: Hex[] = [], seen = new Set<unknown>(), depth = 0): Hex[] {
  if (e == null || depth > 8) return out;
  if (typeof e === "string") {
    if (/^0x[0-9a-fA-F]{8,}$/.test(e)) out.push(e as Hex);
    return out;
  }
  if (typeof e !== "object" || seen.has(e)) return out;
  seen.add(e);
  const o = e as Record<string, unknown>;
  for (const k of ["raw", "data", "cause", "error", "originalError"]) if (k in o) collectHex(o[k], out, seen, depth + 1);
  return out;
}

/**
 * Decodes a viem/RPC error into a typed PerpError when its revert data matches one of the exchange's custom
 * errors (or Error(string) / Panic). Returns undefined when no revert data is found.
 */
export function decodePerpError(err: unknown): PerpError | undefined {
  if (err instanceof PerpError) return err;
  for (const h of collectHex(err)) {
    const d = tryDecode(h, err);
    if (d) return d;
  }
  // router `require(..)` strings and other string reverts that viem already decoded
  const msg = (err as any)?.shortMessage ?? (err as any)?.message;
  if (typeof msg === "string") {
    const m = msg.match(/reverted with(?: the following)?(?: reason string)? '([^']+)'/) ?? msg.match(/reason: (.+)/);
    if (m) return new PerpError("Error", [m[1]], undefined, { cause: err });
  }
  return undefined;
}

/** Decode if possible else rethrow the original error. */
export function rethrowDecoded(err: unknown): never {
  throw decodePerpError(err) ?? err;
}
