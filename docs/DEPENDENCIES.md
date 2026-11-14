# External dependency register (2026-11-13)

Legend: **VERIFIED-LOCAL** = observed in this repo/toolchain on this machine; **VERIFIED-DOC** = read on an official page on 2026-11-13 (only as far as stated);
**UNVERIFIED** = not checked. **No oracle feed IDs, Chainlink aggregator addresses, Pyth contract addresses, USDC addresses, bridge addresses or RollupCreator
addresses are listed here on purpose - none was verified.** Obtain each from the official source named in the "Where to verify" column and record
them in a reviewed, versioned deployment file.

| Dependency | Version / use | Status | Where to verify |
|---|---|---|---|
| OpenZeppelin Contracts | `5.1.0` pinned in `contracts/package.json` (AccessControl, ReentrancyGuard, EIP712, ECDSA, SignatureChecker, EnumerableSet, ERC20/SafeERC20). | VERIFIED-LOCAL (version pinned; installed copy not diffed against the npm tarball). Security advisories for 5.1.0 NOT checked. | https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories ; npm integrity hash from `pnpm-lock.yaml` |
| Hardhat | `2.22.17` + `@nomicfoundation/hardhat-toolbox 5.0.0`; solc `0.8.24`, optimizer 200 runs, `viaIR`, evm `cancun`. Used for tests and in-process gas benchmark. | VERIFIED-LOCAL (tests run). Cancun support on the target chain UNVERIFIED (Nitro/ArbOS version dependent). | Hardhat release notes; Arbitrum docs for supported opcodes / ArbOS version |
| fast-check | `4.10.2` (property tests) | VERIFIED-LOCAL | npm |
| Foundry | `forge 1.9.0-Homebrew`, `anvil 1.9.0-Homebrew` installed on the dev machine. **No `foundry.toml` or `.t.sol` in repo**; no Foundry tests exist. | VERIFIED-LOCAL (installed); unused | https://book.getfoundry.sh |
| Solidity compiler | 0.8.24 (viaIR, cancun) | VERIFIED-LOCAL. Known-bug list for 0.8.24 not checked. | https://docs.soliditylang.org/en/latest/bugs.html |
| Pyth | `contracts/src/oracles/PythAdapter.sol` uses a minimal `IPythLike.getPriceUnsafe(bytes32)` interface (price,conf,expo,publishTime). Pull model: prices must be pushed on-chain by someone. | UNVERIFIED: interface compatibility with the deployed Pyth contract, deployment on the target chain, price feed IDs, update fees, whether `getPriceUnsafe` exists on that version. | https://docs.pyth.network (contract addresses and price-feed ID pages) |
| Chainlink | `ChainlinkAdapter.sol` uses `AggregatorV3` `latestRoundData()`/`decimals()`. No round-completeness / `answeredInRound` check; heartbeat enforced only by the exchange's `maxAge`. | UNVERIFIED: whether Chainlink data feeds exist on the target chain and for which pairs; deviation/heartbeat; L2 sequencer-uptime feed (not used by the adapter). | https://docs.chain.link/data-feeds/price-feeds/addresses |
| Arbitrum Nitro / Chain SDK | Target chain stack (README/ARCHITECTURE). Templates in `infra/nitro`. | VERIFIED-DOC for items listed in `infra/nitro/README.md` (chainConfig fields, SDK flow, size-limit facts, nitro-testnode). Docs were mid-rename and internally inconsistent in places. NOT deployed or run. | https://docs.arbitrum.io (URLs listed in infra/nitro/README.md) |
| Chain max code size | Docs state `MaxCodeSize` default 24576, max 96 KB (98,304), init code max 192 KB, **immutable after deployment**. All current contracts are < 24,576 B so defaults appear sufficient. | VERIFIED-DOC for the statement; NOT tested on any node. The README claim "38.5 KB" is outdated vs measured artifacts. | https://docs.arbitrum.io/launch-arbitrum-chain/chain-config/execution/smart-contract-size-limit |
| USDC on target chain | Vault expects a 6-decimals ERC-20 (asserted in constructor) without fee-on-transfer. Local demo uses `MockUSDC`. | UNVERIFIED: whether native USDC (Circle) is available on the chain; if only bridged USDC (e.g. USDC.e-style) is available, issuer, blacklisting, pause and upgrade authority differ. Bridging path (token bridge / CCTP availability) NOT verified. | https://developers.circle.com/stablecoins/usdc-on-main-networks ; Arbitrum token bridge docs |
| Bridge (parent <-> chain) | Not integrated in contracts. Withdrawals from L2 to the parent chain are subject to the challenge period (docs: default 6.4 days withdrawals when fast withdrawals are off - VERIFIED-DOC on a conceptual page). | UNVERIFIED for this deployment | Arbitrum docs "Deploy a chain and its token bridge" |
| Docker images | `node:22-bookworm-slim`, `postgres:16`, `redis:7`, plus pinned tags for redpanda / prometheus / grafana in `infra/docker-compose.yml` | node/postgres/redis/prometheus/grafana images were pulled by the local run on 2026-11-13 (prometheus & grafana confirmed running); redpanda tag NOT pulled -> UNVERIFIED | Docker Hub |
| external-secrets operator | Helm chart references `external-secrets.io/v1beta1` ExternalSecret | UNVERIFIED API version; only `helm template` was run (no cluster) | https://external-secrets.io |
| Terraform AWS modules | `terraform-aws-modules/vpc ~>5`, `eks ~>20`, aws provider `~>5` | `tofu validate` passed locally; versions otherwise UNVERIFIED; no plan/apply | Terraform registry |
| Rust crates (keeper) | alloy 2.5.0, tokio, axum, prometheus-client in `services/keeper/Cargo.toml` | Owned by keeper workstream; not reviewed here (cargo-audit not run) | `cargo audit` |
| npm packages (frontend/bots/sdk) | various | Not reviewed here (`pnpm audit` not run) | `pnpm audit` |

## Supply-chain gaps (open)
- No lockfile integrity verification beyond `--frozen-lockfile`; no SBOM; no dependency pinning policy for Docker images (tags, not digests).
- `pnpm install --dangerously-allow-all-builds` is used in the local-dev Dockerfiles because `keccak`/`secp256k1` build scripts are blocked by default; do not copy to production images.
- Dev images run Hardhat's well-known test keys; they must never be exposed publicly.
