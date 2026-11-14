# infra/testnet - Arbitrum Sepolia preparation (UNAUDITED PROTOTYPE, test funds only)

| File | Purpose |
|---|---|
| `testnet.config.json` | single source of truth: USDC, Chainlink feeds, Pyth contract + feed ids, market parameters, expected deployer. Every address has a `source` URL; `verifiedOnChain` is written only by `contracts/scripts/testnet/verify-addresses.js` |
| `env.testnet.example` | variable names for keeper/indexer/frontend (copy to `services.env`, git-ignored) |
| `docker-compose.testnet.yml` | postgres + indexer + keeper in dry-run; reads the chain only |
| `TESTNET_UI_PLAN.md` | what the frontend owner must change |
| `smoke-last-run.json` | written by `smoke-testnet.js` (no secrets) |

Scripts live in `contracts/scripts/testnet/`, config in `contracts/hardhat.testnet.config.js`, secrets template in `contracts/.env.example`.
Everything is dry-run by default; each broadcast needs its own `CONFIRM_*=yes` variable AND chainId 421614 AND (for signing) a key whose address equals `expectedDeployer`.
Step-by-step: `docs/TESTNET_RUNBOOK.md`. Go/no-go beyond testnet: `docs/LAUNCH_CHECKLIST.md`.
