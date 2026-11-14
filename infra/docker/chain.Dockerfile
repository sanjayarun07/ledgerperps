# Local dev chain: Hardhat node (chosen over anvil because scripts/deploy.js uses hardhat's
# `--network localhost` and test/helpers.js; anvil would also work but adds nothing here).
# Build context = repo root.  LOCAL ONLY: hardhat node uses well-known public test keys.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY contracts/package.json contracts/pnpm-lock.yaml contracts/pnpm-workspace.yaml ./
# native addon builds (keccak, secp256k1) are blocked by default in newer pnpm; allow for this local-only image
RUN pnpm install --frozen-lockfile --dangerously-allow-all-builds
COPY contracts/hardhat.config.js ./
COPY contracts/src ./src
COPY contracts/scripts ./scripts
COPY contracts/test ./test
# compile at build time so the solc download is cached in the image layer
RUN npx hardhat compile
EXPOSE 8545
CMD ["npx", "hardhat", "node", "--hostname", "0.0.0.0", "--port", "8545"]
