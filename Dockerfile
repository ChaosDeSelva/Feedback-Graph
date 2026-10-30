# Pinned: Node 26.5 (native TypeScript), pnpm 11.13.1.
FROM node:26.5.0-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583 AS build
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

FROM node:26.5.0-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# The services run as uid 1000 (node) by default, or as your own uid on Linux (HOST_UID/HOST_GID in .env, which
# docker-compose.yml passes as `user:`). A uid with no account here gets HOME=/ from Docker, which it cannot write, so
# HOME is a folder any uid can write: the agent CLIs keep their settings there.
RUN mkdir -p /home/fg && chmod 1777 /home/fg
ENV NODE_ENV=production HOME=/home/fg

FROM runtime AS worker
# Pinned, like everything else in this image: a rebuild never picks up an agent CLI nobody has tried with this version.
# claude-code in particular: the worker relies on its --restricted and dontAsk flags to keep agents inside the repo.
RUN npm i -g @anthropic-ai/claude-code@2.1.309 @openai/codex@0.162.0 \
  # CODEX_HOME and the codex-runner scratch live on named volumes, which start as a copy of these folders: writable by
  # whichever uid runs the worker (the default node, or HOST_UID), sticky for shared scratch; the key root is private.
  && mkdir -p /codex /scratch /redaction-key && chown node:node /codex /scratch /redaction-key && chmod 1777 /codex /scratch && chmod 0700 /redaction-key
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

# The codex-runner sidecar (docker-compose.yml, profile "codex"): only the Codex CLI, the runner script and Node. No
# repo, no other packages, nothing mounted but the scratch volume and the Codex login. Built from the plain Node image,
# not from runtime, so none of the app is in it.
FROM node:26.5.0-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583 AS codex-runner
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g @openai/codex@0.162.0 \
  && npm cache clean --force \
  # Runs as the worker's uid (HOST_UID in docker-compose.yml): the token it writes is readable only by that uid.
  && mkdir -p /codex /scratch /runner && chown node:node /codex /scratch && chmod 1777 /codex /scratch
WORKDIR /runner
COPY packages/core/src/llm/exec.ts packages/core/src/llm/codexRunner.ts packages/core/src/llm/codexRunnerMain.ts ./
RUN echo '{"type":"module","private":true}' > package.json
ENV CODEX_HOME=/codex RUNNER_SCRATCH=/scratch RUNNER_PORT=8790 NODE_ENV=production
EXPOSE 8790
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8790/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "codexRunnerMain.ts"]
