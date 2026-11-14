/**
 * Single lookup from contract errors (custom errors in contracts/abi/PerpExchange.merged.json, `BadParam(what)` reasons and
 * `require` strings) to a friendly message plus the next step. Pure and unit-tested; the UI never shows a raw selector.
 *
 * An action's `target` is a UI anchor (see lib/focus.ts) the toast button jumps to: deposit box, size field, etc.
 */
export type ActionTarget = "deposit" | "size" | "price" | "orders" | "positions" | "withdraw" | "session" | "glossary" | "poke";
export interface FixAction { label: string; target: ActionTarget }
export interface Friendly { code: string; title: string; detail: string; actions: FixAction[] }
export interface ErrorContext {
  /** USDC (1e6) the user is short by for this action, when known (Unhealthy) */
  shortfall?: bigint;
  /** formatter for the shortfall so this module stays free of unit code */
  fmtUsd?: (v: bigint) => string;
  market?: string;
  /** `principal(account)` (1e6 USDC): what the account may still withdraw while the limiter is active */
  principal?: bigint;
}

export const CUSTOM_ERRORS = [
  "AccessControlBadConfirmation", "AccessControlUnauthorizedAccount", "BadParam", "DuplicateClientId", "Expired", "FokUnfilled", "InvalidShortString",
  "MarketRestricted", "NotAuthorized", "NotLiquidatable", "OICap", "OracleDegraded", "PostOnlyCross", "PriceTooFarFromTop", "ReduceOnlyViolation",
  "ReentrancyGuardReentrantCall", "SafeERC20FailedOperation", "StringTooLong", "TooManyOrders", "Unhealthy", "WithdrawGated", "BackstopCap",
] as const;

const A = (label: string, target: ActionTarget): FixAction => ({ label, target });

/** Human wording for `BadParam(reason)` / `require(reason)` strings the contracts use. */
export const BAD_PARAM: Record<string, { title: string; detail: string; actions?: FixAction[] }> = {
  amount: { title: "Amount is not valid", detail: "Enter an amount greater than zero." },
  "cancel orders first": { title: "Cancel your resting orders first", detail: "This change is blocked while orders are open in this market.", actions: [A("Show open orders", "orders")] },
  cond: { title: "Trigger order not found", detail: "That TP/SL or trigger order no longer exists (it may have fired or been cancelled).", actions: [A("Show open orders", "orders")] },
  "fee-on-transfer unsupported": { title: "This token takes a fee on transfer", detail: "The exchange only supports plain USDC transfers." },
  inactive: { title: "Already finished", detail: "That schedule or order is no longer active.", actions: [A("Show open orders", "orders")] },
  interval: { title: "Interval is not allowed", detail: "Pick a TWAP interval that is at least one second." },
  lot: { title: "Size is not a multiple of the lot", detail: "Sizes must be a whole number of lots. Use the suggested size shown under the size field.", actions: [A("Fix size", "size")] },
  "lot/size": { title: "Size is not a multiple of the lot", detail: "Sizes must be a whole number of lots. Use the suggested size shown under the size field.", actions: [A("Fix size", "size")] },
  market: { title: "Unknown market", detail: "That market does not exist on this exchange." },
  "min notional": { title: "Order is too small", detail: "The order value is below the market minimum. Increase the size.", actions: [A("Increase size", "size")] },
  "no adl debt": { title: "Nothing to deleverage", detail: "There is no auto-deleveraging debt on this market right now." },
  "no order": { title: "Order not found", detail: "It was already filled or cancelled.", actions: [A("Show open orders", "orders")] },
  "no position": { title: "You have no position here", detail: "There is nothing to close or protect in this market.", actions: [A("Show positions", "positions")] },
  "no room": { title: "Not enough room on the book", detail: "The order book cannot take this order right now. Try a smaller size or a price closer to the market.", actions: [A("Change size", "size")] },
  "nonce used": { title: "That signed order was already used", detail: "Each signed order works once. Sign a new one." },
  "not in profit": { title: "Position is not in profit", detail: "Only profitable positions can be auto-deleveraged." },
  "not isolated": { title: "Market is in cross mode", detail: "Switch this market to isolated margin first, then add or remove isolated margin.", actions: [A("Margin mode", "positions")] },
  "not opposite to backstop": { title: "Wrong side for deleveraging", detail: "Pick positions on the opposite side of the backstop." },
  "not ranked": { title: "Targets are not in rank order", detail: "List deleverage targets from highest to lowest ADL score." },
  "nothing to repay": { title: "Nothing to repay", detail: "There is no recapitalization debt on that market." },
  "not triggered": { title: "Trigger price not reached yet", detail: "The mark price has not crossed the trigger, so the order cannot fire. It fires automatically when it does." },
  "position/orders open": { title: "Close your position and orders first", detail: "You can only switch margin mode when this market has no position and no resting orders.", actions: [A("Show positions", "positions"), A("Show open orders", "orders")] },
  "remove isolated margin first": { title: "Remove isolated margin first", detail: "Take the isolated margin back to your main balance, then switch to cross.", actions: [A("Margin mode", "positions")] },
  size: { title: "Size is not valid", detail: "Enter a size greater than zero that fits the lot size and the market's order limit.", actions: [A("Fix size", "size")] },
  "slice < lot": { title: "Each TWAP slice is smaller than one lot", detail: "Use fewer slices or a larger total size.", actions: [A("Fix size", "size")] },
  slices: { title: "Number of slices is not allowed", detail: "Use between 2 and 100 slices." },
  slippage: { title: "Slippage is out of range", detail: "Pick a maximum slippage between 0 and 1000 bps (10%)." },
  targets: { title: "Invalid deleverage target list", detail: "Provide between one and the maximum number of targets." },
  tick: { title: "Price is not a multiple of the tick", detail: "Prices move in fixed steps. Use the suggested price shown under the price field.", actions: [A("Fix price", "price")] },
  "too early": { title: "Not due yet", detail: "This TWAP slice can only run after its scheduled time (measured in chain time). Wait for the next block after the countdown." },
  "bad cfg": { title: "Invalid configuration", detail: "That setting is outside the allowed range (admin action)." },
  bounds: { title: "Value out of bounds", detail: "That setting is outside the allowed range (admin action)." },
  backstop: { title: "The backstop account cannot do that", detail: "This action is not available for the system backstop account." },
  locked: { title: "Locked", detail: "This part of the system has been locked by the admins." },
  "must be reduce-only": { title: "Only reduce-only orders are allowed", detail: "Turn on reduce-only, or close your position instead.", actions: [A("Show positions", "positions")] },
  "self only": { title: "Only the owner can do this", detail: "Use the wallet that owns this subaccount." },
  insurance: { title: "Insurance fund is too small", detail: "The insurance fund cannot cover that amount." },
};

function badParam(what: string): Friendly {
  const m = BAD_PARAM[what];
  if (m) return { code: `BadParam:${what}`, title: m.title, detail: m.detail, actions: m.actions ?? [] };
  return { code: `BadParam:${what}`, title: "The exchange rejected this action", detail: `Reason from the contract: "${what}". Check the amounts and try again.`, actions: [] };
}

export function friendlyFromContract(name: string, args: readonly unknown[] = [], ctx: ErrorContext = {}): Friendly {
  const mk = ctx.market ? ` on ${ctx.market}` : "";
  switch (name) {
    case "BadParam": return badParam(String(args[0] ?? ""));
    case "Unhealthy": {
      const need = ctx.shortfall && ctx.shortfall > 0n && ctx.fmtUsd ? ` You need ${ctx.fmtUsd(ctx.shortfall)} USDC more.` : "";
      return { code: name, title: "Not enough free margin", detail: `This would leave your account below its margin requirement.${need} Add collateral or make the order smaller.`, actions: [A("Deposit", "deposit"), A("Reduce size", "size")] };
    }
    case "MarketRestricted": return { code: name, title: `Trading is paused${mk}`, detail: "New orders are blocked (the market or the whole exchange is paused). You can still cancel orders and add collateral; closing positions may be blocked until it reopens.", actions: [A("Show open orders", "orders")] };
    case "OracleDegraded": return { code: name, title: "Price feed is stale", detail: "The oracle price is too old, so new orders and some withdrawals are blocked. Cancel orders if you need to; trading resumes after the next oracle update.", actions: [A("Show open orders", "orders")] };
    case "ReduceOnlyViolation": return { code: name, title: "This order would increase your position", detail: "Reduce-only orders may only shrink a position, or the market is in reduce-only mode. Place an order on the opposite side, or a smaller one.", actions: [A("Change size", "size")] };
    case "PostOnlyCross": return { code: name, title: "Post-only order would trade immediately", detail: "Post-only orders must rest on the book. Pick a price that does not cross the best price, or switch time-in-force to GTC.", actions: [A("Change price", "price")] };
    case "FokUnfilled": return { code: name, title: "Fill-or-kill could not fill completely", detail: "There is not enough liquidity at your limit price for the full size. Reduce the size, widen the price, or use IOC to take what is available.", actions: [A("Reduce size", "size"), A("Change price", "price")] };
    case "DuplicateClientId": return { code: name, title: "Duplicate order id", detail: "An order with this client id already exists. Retry (a new id is generated for you).", actions: [] };
    case "WithdrawGated": {
      const up = ctx.principal !== undefined && ctx.fmtUsd ? ` You can withdraw up to ${ctx.fmtUsd(ctx.principal)} USDC.` : " You can still withdraw up to the amount you deposited.";
      return { code: name, title: "Withdrawal is temporarily limited", detail: `Withdrawals above your deposited amount are temporarily limited while the exchange has unresolved bad debt.${up}`, actions: [] };
    }
    case "BackstopCap": return { code: name, title: "Backstop is at its inventory limit", detail: "The exchange's backstop already holds as much of this market as it is allowed to, so it cannot take more right now. Your own orders and positions are not affected; try again once its inventory has been reduced.", actions: [] };
    case "TooManyOrders": return { code: name, title: "Too many open orders", detail: "Cancel some resting orders, trigger orders or TWAPs before adding more.", actions: [A("Show open orders", "orders")] };
    case "PriceTooFarFromTop": return { code: name, title: "Price is too far from the market", detail: "The book can only place an order a limited number of price levels away from the best price. Move your price closer to the market.", actions: [A("Change price", "price")] };
    case "OICap": return { code: name, title: `Market is at its open-interest limit${mk}`, detail: "No more new exposure can be opened right now. You can still reduce or close positions. Try a smaller size or another market.", actions: [A("Reduce size", "size")] };
    case "NotAuthorized": return { code: name, title: "This key is not allowed to do that", detail: "The signer is not the owner of this subaccount and has no active session key (it may have expired or been revoked). Use your wallet, or authorize a fresh session key.", actions: [A("Session keys", "session")] };
    case "NotLiquidatable": return { code: name, title: "Account is not below maintenance margin", detail: "Only accounts below their maintenance margin can be liquidated." , actions: [] };
    case "Expired": return { code: name, title: "Order or signature expired", detail: "Its expiry or deadline is in the past (checked in chain time). Sign or place it again.", actions: [] };
    case "AccessControlUnauthorizedAccount": return { code: name, title: "Admin permission required", detail: "That action needs an admin or guardian role your wallet does not have.", actions: [] };
    case "AccessControlBadConfirmation": return { code: name, title: "Role change rejected", detail: "Confirm with the same account that holds the role.", actions: [] };
    case "ReentrancyGuardReentrantCall": return { code: name, title: "Busy, try again", detail: "The exchange was already processing a call. Retry in a moment.", actions: [] };
    case "SafeERC20FailedOperation": return { code: name, title: "Token transfer failed", detail: "The USDC transfer was rejected. Check your balance and the approved amount, then try again.", actions: [A("Deposit", "deposit")] };
    case "InvalidShortString": case "StringTooLong": return { code: name, title: "Invalid text value", detail: "A text field is too long for the contract.", actions: [] };
    default: return { code: name, title: "The exchange rejected this action", detail: `Contract error ${name}. Nothing was sent.`, actions: [] };
  }
}

/** Reasons that do not come from the contract. */
export function friendlyClient(kind: "rejected" | "no-gas" | "no-wallet" | "wrong-chain" | "receipt-timeout" | "reverted" | "network", extra?: string): Friendly {
  switch (kind) {
    case "rejected": return { code: kind, title: "You rejected the request in your wallet", detail: "Nothing was sent. Try again when you are ready.", actions: [] };
    case "no-gas": return { code: kind, title: "Not enough gas to send this", detail: "Your wallet has no native tokens to pay the network fee. On the local demo, connect a Hardhat dev account (they come with gas) or send this address some gas, then retry.", actions: [] };
    case "no-wallet": return { code: kind, title: "Wallet not connected", detail: "Connect a wallet to continue.", actions: [] };
    case "wrong-chain": return { code: kind, title: "Wallet is on the wrong network", detail: "Switch your wallet to the exchange network, then retry.", actions: [] };
    case "receipt-timeout": return { code: kind, title: "Still waiting for confirmation", detail: `The transaction was sent but no receipt has arrived yet${extra ? ` (${extra})` : ""}. It may still confirm; check the activity log.`, actions: [] };
    case "reverted": return { code: kind, title: "Transaction failed on-chain", detail: "It was included in a block but reverted, so nothing changed. Your gas was spent.", actions: [] };
    case "network": return { code: kind, title: "Cannot reach the network", detail: `${extra ?? "The node did not respond."} Check your connection and retry.`, actions: [] };
  }
}
