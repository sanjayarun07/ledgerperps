/**
 * AUTHENTICATION EXAMPLE
 * On-chain there are no API keys or passwords: authority is (1) the owner's wallet key, (2) an expiring,
 * trading-only AGENT key approved by the owner, and (3) per-order EIP-712 signatures that anyone may relay.
 * Agents can place/cancel/replace orders but can never withdraw or transfer collateral.
 * (The off-chain indexer's /v1 endpoints are read-only market/account data and need no auth in this prototype.)
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { clientFor, deployment, fundIfNeeded, key, RPC } from "./_common.js";
import { PerpClient, toPrice, toSize, localChain } from "../src/index.js";

const owner = clientFor(14);
await fundIfNeeded(owner, 5_000);

// 1. generate a fresh session key locally and give it a little gas
const agentAcct = privateKeyToAccount(generatePrivateKey());
const gasFunder = createWalletClient({ chain: localChain(deployment.chainId, RPC), transport: http(RPC), account: key(0) });
await gasFunder.sendTransaction({ to: agentAcct.address, value: 10n ** 17n });

// 2. owner approves it for one hour of chain time
// expiry is relative to CHAIN time (a busy dev node runs far ahead of wall-clock)
await owner.approveAgentFor(agentAcct.address, 3600);

// 3. the agent trades on behalf of the owner (owner = master address; wallet = agent key)
const agent = new PerpClient({
  publicClient: owner.publicClient,
  walletClient: createWalletClient({ chain: localChain(deployment.chainId, RPC), transport: http(RPC), account: agentAcct }),
  exchange: deployment.exchange, usdc: deployment.usdc, oracle: deployment.oracle,
  owner: owner.owner,
});
const o = await agent.placeOrder({ market: 0, isBuy: true, price: toPrice("40000"), size: toSize("0.05") });
console.log("agent placed order", o.orderId, "for owner account", owner.acct());
await agent.cancelOrder(o.orderId);

// 4. agent cannot move the owner's funds: withdraw() acts on the caller's own (empty) account
try { await agent.withdraw(1n); } catch (e) { console.log("agent withdraw blocked:", (e as Error).message); }

// 5. revoke
await owner.revokeAgent(agentAcct.address);
try { await agent.placeOrder({ market: 0, isBuy: true, price: toPrice("40000"), size: toSize("0.05") }); } catch (e) { console.log("after revoke:", (e as Error).message); }
