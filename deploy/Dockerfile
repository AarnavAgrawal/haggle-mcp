# Haggle MCP server as a container, for hosting outside Manufact (AWS ECS Fargate, Azure Container
# Apps, any Docker host). Follows mcp-use's self-hosted deployment (docs.mcp-use.com/typescript/server/
# deployment/self-hosted), adapted to this npm-workspaces monorepo. Guide: docs/mcp-hosting-aws-azure.md
#
# Build from the REPO ROOT (the server imports packages/core, engine, brain):
#   docker build -f deploy/Dockerfile -t haggle-mcp .
# Run (secrets come from the platform's secret store or an env file, never baked into the image):
#   docker run --rm -p 3000:3000 --env-file .env.deploy haggle-mcp
#
# Not at the repo root on purpose: Manufact deploys from this repo and could pick up a root Dockerfile.

FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund
RUN npm run build -w @haggle/mcp

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app /app
# Same start command as the Manufact server (servers update --start-command).
WORKDIR /app/apps/mcp
EXPOSE 3000
# Liveness only (/health). Point the platform's readiness probe at /ready to also check the database,
# migrations and providers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
CMD ["sh", "-c", "../../node_modules/.bin/mcp-use start --host 0.0.0.0 --port ${PORT}"]
