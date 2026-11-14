// Off-chain signed order (EIP-712 OrderAction) relayed on-chain by a different address.
import { clientFor, deployment, fundIfNeeded } from "./_common.js";
import { decodePerpError, newCloid, toPrice, toSize } from "../src/index.js";

const trader = clientFor(12);
const relayer = clientFor(13); // pays gas; has no authority over the trader's funds
await fundIfNeeded(trader, 5_000);

const signed = await trader.signOrder({ market: 0, isBuy: true, price: toPrice("40000"), size: toSize("0.05"), cloid: newCloid() });
console.log("signed by", signed.signer, "nonce", signed.nonce, "deadline", signed.deadline);
const res = await relayer.placeSigned(signed);
console.log("relayed: order id", res.orderId, "tx", res.hash);
try {
  await relayer.placeSigned(signed); // replay
} catch (e) {
  console.log("replay rejected:", decodePerpError(e)?.message);
}
await trader.cancelAll();
console.log("domain: PerpExchange v1 chain", deployment.chainId, "verifyingContract", deployment.exchange);
