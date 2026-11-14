import { BaseError, ChainMismatchError, ContractFunctionRevertedError, HttpRequestError, UserRejectedRequestError } from "viem";
import { friendlyClient, friendlyFromContract, type ErrorContext, type Friendly } from "./messages";

/** Decode any thrown viem error into a Friendly message (title, detail, suggested fixes). Pure apart from reading the error. */
export function explainError(e: unknown, ctx: ErrorContext = {}): Friendly {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return friendlyClient("rejected");
    if (e.walk((x) => x instanceof ChainMismatchError)) return friendlyClient("wrong-chain");
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data) return friendlyFromContract(rev.data.errorName, rev.data.args ?? [], ctx);
    if (rev?.reason) { // require("...") strings
      return friendlyFromContract("BadParam", [rev.reason], ctx);
    }
    if (e.walk((x) => /insufficient funds|enough funds|exceeds the balance/i.test((x as Error).message ?? ""))) return friendlyClient("no-gas");
    if (e.walk((x) => x instanceof HttpRequestError)) return friendlyClient("network", e.shortMessage);
    return { code: "unknown", title: "The action could not be sent", detail: e.shortMessage || e.message, actions: [] };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied/i.test(msg)) return friendlyClient("rejected");
  return { code: "unknown", title: "The action could not be completed", detail: msg, actions: [] };
}
