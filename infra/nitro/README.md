# Arbitrum Nitro (Orbit / "Arbitrum chain") templates

STATUS: **templates only. Nothing here was deployed, run, or tested.** No contract addresses are given: addresses
(RollupCreator, bridge, etc.) MUST be taken from the official "canonical factory contracts" page for your parent chain.
Anything not confirmed from a doc page is marked `UNVERIFIED`.

## Sources (retrieved 2026-11-13 via WebFetch/WebSearch; the docs are mid-rename "Orbit" -> "Arbitrum chain", "Orbit SDK" -> "Chain SDK" and some pages were inconsistent, e.g. package name `@arbitrum/chain-sdk` vs import `@offchainlabs/chain-sdk` -- check the SDK repo)
- Deploy a chain: https://docs.arbitrum.io/launch-arbitrum-chain/deploy/deploy-chain
- Configure node: https://docs.arbitrum.io/launch-arbitrum-chain/deploy/configure-node
- chainConfig reference: https://docs.arbitrum.io/launch-arbitrum-chain/chain-config/chainConfig-reference
- Smart contract size limit: https://docs.arbitrum.io/launch-arbitrum-chain/chain-config/execution/smart-contract-size-limit
- Ownership and access: https://docs.arbitrum.io/launch-arbitrum-chain/operate/ownership-and-access
- Nitro CLI flags: https://docs.arbitrum.io/run-a-node/nitro/cli-flags-reference
- Local test chain: https://github.com/OffchainLabs/nitro-testnode (`./test-node.bash --init`; sequencer HTTP :8547, WS :8548)
- Docs index: https://docs.arbitrum.io/llms.txt
- Canonical factory contract addresses (NOT fetched; go here): linked from the deploy page above ("Canonical factory contracts").

## Verified from the docs (as retrieved)
- `chainConfig.arbitrum` has `InitialChainOwner`, `DataAvailabilityCommittee` (false = Rollup), `MaxCodeSize` (default 24576), `MaxInitCodeSize` (default 49152), `InitialArbOSVersion` (page showed 51), `EnableArbOS=true`, `AllowDebugPrecompiles=false`.
- `chainId` and `InitialChainOwner` must match `chainId` and `owner` in the rollup `Config` struct.
- Contract size: the docs state limits are set at deployment and **cannot be changed later**; stated max 96 KB code / 192 KB init code; "higher values unsupported, may cause failures"; the page's own "safe values" table: 24/48 KB or 48/96 KB; the page is internally inconsistent (init-code comment vs stated max). **I did not test any value on a node.**
- Deployment flow with the SDK: `prepareChainConfig` -> `createRollupPrepareDeploymentParamsConfig` -> `createRollup` (calls `RollupCreator`) -> `prepareNodeConfig` -> run Nitro.
- Rollup mode has `DataAvailabilityCommittee=false`; the docs recommend a Rollup-as-a-Service provider for production.

## Relevance to this repo (checked locally 2026-11-13)
The README's "38.5 KB" claim is stale: deployed bytecode sizes (re-measured 2026-11-13 after the stress-campaign fixes, from `contracts/artifacts` and byte-for-byte on a local Nitro testnode via `eth_getCode`) are
PerpExchange 19,864 B, PerpExtras 18,276 B, PerpTrading 17,352 B, PerpLiquidation 12,218 B, PerpAdl 11,664 B, PerpTwap 10,246 B -- all under 24,576 (EIP-170); the largest (PerpExchange) has 4,712 B headroom.
A local nitro-testnode (default `MaxCodeSize`) accepted a 24,576 B contract and rejected 24,577 B and larger (`infra/nitro-local/README.md`). So the default `MaxCodeSize` 24576 should suffice today; keep it unless that changes, because it cannot be changed later.
Whether the delegatecall-router approach fits future growth is a design question, not a Nitro one.

## Steps (template)
1. Choose parent chain (Arbitrum Sepolia for testnet). UNVERIFIED: current RPC, faucet, canonical RollupCreator address -> canonical factory contracts page.
2. Fund deployer EOA on parent chain (gas). Deployer key never reused as owner.
3. Create owner: multisig (+ timelock) address; becomes `InitialChainOwner` and rollup `owner`. Decide `batchPosters` and `validators` addresses (separate keys).
4. Fill `chain-config.template.json`; run `deploy-rollup.template.mjs` (needs `npm i` of the Chain SDK -- exact package name UNVERIFIED, see above) on **testnet first**.
5. Record `coreContracts` from the receipt into `infra/nitro/deployments/<env>.json` (do not hand-type addresses).
6. Generate node config with `prepareNodeConfig`, compare against `node-config.template.json`, run Nitro (see https://docs.arbitrum.io/run-a-node/run-full-node ).
7. Bridge/token-bridge deployment: separate SDK step (UNVERIFIED details; see docs "Deploy a chain and its token bridge"). USDC: do NOT assume native USDC exists on your chain; see docs/DEPENDENCIES.md.
8. Fund batch poster + validator on the parent chain; monitor balances (RUNBOOKS.md).
9. Hand chain-owner rights (ArbOwner precompile / UpgradeExecutor) to multisig+timelock; test an owner action on testnet.
10. Soak on testnet; only then discuss mainnet. Parameters worth deliberate decision (UNVERIFIED defaults): challenge period / confirm period, block time, gas pricing/min base fee, sequencer TxMaxDataSize, forced-inclusion delay (`maxTimeVariation`), validator whitelist / BoLD settings.

## Sequencer trust (relevant to docs/THREAT_MODEL.md)
Single sequencer orders transactions. Forced inclusion goes via the parent-chain delayed inbox after a delay; not tested here.
