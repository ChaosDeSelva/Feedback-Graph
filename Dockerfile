# Pinned: Node 26.5 (native TypeScript), pnpm 11.13.1.
FROM node:26.5.0-slim AS build
RUN npm i -g pnpm@11.13.1
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json LICENSE NOTICE ./
COPY packages/core/package.json packages/core/
COPY packages/worker/package.json packages/worker/
COPY packages/api/package.json packages/api/
COPY packages/ui/package.json packages/ui/
COPY packages/store-postgres/package.json packages/store-postgres/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm -F @fb/ui build

FROM node:26.5.0-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production

FROM runtime AS worker
# Pinned, like everything else in this image: a rebuild never picks up an agent CLI nobody has tried with this version.
# claude-code in particular: the worker relies on its --restricted and dontAsk flags to keep agents inside the repo.
RUN npm i -g @anthropic-ai/claude-code@2.1.309 @openai/codex@0.162.0 \
  # CODEX_HOME lives on a named volume; created here so the volume starts owned by the unprivileged user.
  && mkdir -p /codex && chown node:node /codex
WORKDIR /app/packages/worker
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "const t=Date.parse(require('fs').readFileSync('/tmp/fg-heartbeat','utf8'));process.exit(Date.now()-t<180000?0:1)"
CMD ["node", "src/main.ts"]

FROM runtime AS api
WORKDIR /app/packages/api
ENV STATIC_DIR=/app/packages/ui/dist PORT=8787
EXPOSE 8787
USER node
CMD ["node", "src/main.ts"]
