# UNTESTED TEMPLATE. Context = repo root. Source: frontend (Next.js, pnpm; `next start -p 3100`).
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# sync-deployment.mjs reads ../contracts/{abi,deployments}; run `make up` (deployer) first so these exist
COPY contracts/abi /contracts/abi
COPY contracts/deployments /contracts/deployments
COPY frontend ./
RUN pnpm build
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
EXPOSE 3100
CMD ["pnpm", "start"]
