// TEMPLATE -- NOT RUN. Function names (prepareChainConfig, createRollupPrepareDeploymentParamsConfig, createRollup) are
// from docs.arbitrum.io/launch-arbitrum-chain/deploy/deploy-chain (retrieved 2026-11-13). Package name and exact
// argument shapes are UNVERIFIED: the docs mention both `@arbitrum/chain-sdk` and `@offchainlabs/chain-sdk`.
// Secrets come from the environment / a secrets manager. Never commit keys.
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains"; // parent chain: UNVERIFIED choice
import { prepareChainConfig, createRollupPrepareDeploymentParamsConfig, createRollup } from "@arbitrum/chain-sdk"; // UNVERIFIED package

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY); // testnet only; fund with gas
const parentChainPublicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(process.env.PARENT_CHAIN_RPC) });
const chainId = Number(process.env.CHAIN_ID);
const owner = process.env.CHAIN_OWNER; // multisig / UpgradeExecutor admin

const chainConfig = prepareChainConfig({
  chainId,
  arbitrum: { InitialChainOwner: owner, DataAvailabilityCommittee: false /* MaxCodeSize / MaxInitCodeSize: leave default unless needed -- immutable after deploy */ },
});
const config = createRollupPrepareDeploymentParamsConfig(parentChainPublicClient, { chainId: BigInt(chainId), owner, chainConfig });
const result = await createRollup({
  params: { config, batchPosters: [process.env.BATCH_POSTER_ADDR], validators: [process.env.VALIDATOR_ADDR] },
  account: deployer,
  parentChainPublicClient,
});
console.log(JSON.stringify(result.coreContracts, null, 2)); // record to infra/nitro/deployments/<env>.json
