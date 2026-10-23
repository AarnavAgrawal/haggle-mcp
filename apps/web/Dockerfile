# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# (The only build args are NEXT_PUBLIC_* values, public by design: the linter flags "KEY" in their names.)
#
# Haggle web app (apps/web) as a Node container, for a host that runs images (AWS ECS / App Runner,
# Azure Container Apps, Fly, Cloud Run). docs/production-deploy.md has the full procedure.
#
# Build context = the REPO ROOT (npm workspaces: the lockfile and @haggle/core live there):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key> \
#     [--build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=<site key>] [--build-arg NEXT_PUBLIC_SUPPORT_EMAIL=<address>] \
#     -t haggle-web:<sha> .
#   docker run --init -p 3000:3000 --env-file <web env file, server secrets only> haggle-web:<sha>
#
# NEXT_PUBLIC_* values are inlined into the bundle at build time, so an image belongs to ONE environment.
# Server secrets (SUPABASE_SERVICE_ROLE_KEY, HAGGLE_SERVICE_TOKEN, ANTHROPIC_API_KEY, CRON_SECRET,
# HAGGLE_TICK_SECRET, HAGGLE_MCP_URL, WEB_CHAT_DAILY_CAP) are given only at run time, never baked in.
# The ignore file is apps/web/Dockerfile.dockerignore (BuildKit reads <Dockerfile>.dockerignore; a
# plain apps/web/.dockerignore would be ignored with the repo root as context).

ARG NODE_IMAGE=node:22-bookworm-slim

# ── build: install the workspaces from the lockfile, then next build (standalone output) ───────────
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# The root package.json's engines floor (node >= 22.22.2), as CI checks it.
RUN node -e 'const w=require("./package.json").engines.node.replace(/^>=\s*/,"").split(".").map(Number),h=process.versions.node.split(".").map(Number);const ok=h[0]>w[0]||(h[0]===w[0]&&(h[1]>w[1]||(h[1]===w[1]&&h[2]>=w[2])));if(!ok){console.error(`node ${process.versions.node} < ${w.join(".")}`);process.exit(1)}'
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_HAGGLE_DEMO=""
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ARG NEXT_PUBLIC_SUPPORT_EMAIL=""
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  || { echo "build args NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required (inlined at build time)" >&2; exit 1; }
RUN NEXT_OUTPUT=standalone npm run build -w @haggle/web

# Normalize the standalone layout into /out with the app at /out/apps/web: with the monorepo as the
# tracing root Next writes .next/standalone/apps/web/server.js; with the app as root, .next/standalone/server.js.
RUN set -eu; cd apps/web; \
  if [ -f .next/standalone/apps/web/server.js ]; then mkdir -p /out && cp -a .next/standalone/. /out/; \
  elif [ -f .next/standalone/server.js ]; then mkdir -p /out/apps/web && cp -a .next/standalone/. /out/apps/web/; \
  else echo "no .next/standalone output: next.config.ts must set output: \"standalone\" when NEXT_OUTPUT=standalone" >&2; exit 1; fi; \
  mkdir -p /out/apps/web/.next; cp -a .next/static /out/apps/web/.next/static; \
  if [ -d public ]; then cp -a public /out/apps/web/public; fi; \
  rm -rf /out/apps/web/.env* /out/.env*

# ── runtime: the traced files only, as the unprivileged `node` user ────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app/apps/web
# App files stay root-owned (read-only to the process); only Next's cache directory is writable.
COPY --from=build /out /app
RUN mkdir -p /app/apps/web/.next/cache && chown -R node:node /app/apps/web/.next/cache
USER node
EXPOSE 3000
# Liveness for the host's health check: GET /api/health (see docs/production-deploy.md). Run with
# --init (or the host's init process) so SIGTERM reaches node and in-flight streams close cleanly.
CMD ["node", "server.js"]
