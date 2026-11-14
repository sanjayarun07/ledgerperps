# UNTESTED TEMPLATE. Context = repo root. bots/ is a TypeScript pnpm package (@perps/bots) that depends on
# `link:../sdk/ts` (the sdk dir may not exist yet -> build will fail until it does). Default command runs the market-maker bot
# (`pnpm mm` = tsx src/run-mm.ts); override in compose for seed/oracle/taker.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY sdk ./sdk
COPY bots ./bots
COPY contracts/deployments ./contracts/deployments
WORKDIR /repo/bots
RUN pnpm install --frozen-lockfile --dangerously-allow-all-builds
USER node
CMD ["pnpm", "mm"]
