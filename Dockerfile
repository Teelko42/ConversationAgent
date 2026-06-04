# Aizen server image — runs the TypeScript app directly via tsx (no compile step).
# Used by Phase 5 (infra/azure-deploy-app.ps1 → `az acr build`).
FROM node:22-bookworm-slim
WORKDIR /app

# pnpm via corepack (version pinned by package.json "packageManager").
RUN corepack enable

# Install dependencies first for better layer caching, then copy the rest.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# Bring in the remaining root files (tsconfig, etc.). .dockerignore keeps
# node_modules, .git, .data, and .env out of the image.
COPY . .

ENV NODE_ENV=production
ENV PORT=5173
EXPOSE 5173

# Root "start" = tsx packages/server/src/index.ts — no dist build needed at runtime.
CMD ["pnpm", "start"]
