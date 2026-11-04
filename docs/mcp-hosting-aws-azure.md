# Moving the Haggle MCP server from Manufact to AWS or Azure

Status: **a guide, not done.** The container in `deploy/Dockerfile` was built and run locally (2026-11-02):
`/health` 200, `/ready` 200, `tools/list` serves all 22 tools, the process runs as a non-root user. No AWS or
Azure deployment has been made. Production still runs on Manufact (`haggle-prod`,
https://wild-forge-smbdu.run.mcp-use.com/mcp).

## Is there an option for this?

Yes, through Docker. It is not a one-command deploy:

- `mcp-use deploy` deploys **only to Manufact Cloud** (`npx mcp-use deploy --help`, mcp-use 2.10.0: "Deploy an
  MCP server to Manufact Cloud"). mcp-use has no AWS or Azure deploy command and no AWS/Azure guide.
- mcp-use **officially documents self-hosting** as a Docker image on your own infrastructure:
  https://docs.mcp-use.com/typescript/server/deployment/self-hosted.md (build, then `mcp-use start` serves
  `.mcp-use/build`; `HOST=0.0.0.0`, `PORT`; "Terminate TLS at your platform or reverse proxy"; secrets from
  the platform's secret manager). mcp-use v2 servers are stateless per request, so no sticky sessions are needed.
- AWS (ECS Fargate) and Azure (Container Apps) run Docker images. That is the supported route: the same server
  and code, a different host. You take over what Manufact did for you: TLS, the URL, restarts, logs and deploys.

**Not suitable:** AWS Lambda, AWS App Runner (CPU is throttled between requests, which stalls the 30-second tick),
Amazon Bedrock AgentCore Runtime (it hosts stateless per-session MCP servers with no always-on process), Azure
Functions, and any setup with scale-to-zero. The next section explains why.

## What Haggle needs from any host (read first)

1. **Exactly one instance, always.** The live server advances every open deal every 30 s, recovers stuck jobs and
   checks for stalls in-process (`apps/mcp/src/live.ts`). There is no lock across processes, so two instances would
   advance the same deals twice (duplicate follow-ups). Run one instance, use **stop-then-start** deploys (no
   overlap), and never run Manufact and the new host live at the same time.
2. **Always-on CPU.** No scale-to-zero and no "CPU only during requests".
3. **Public HTTPS URL** and an idle timeout of **at least 120 s** at the load balancer or ingress (MCP streamable HTTP;
   `wait_for_update` holds a request for up to 60 s).
4. **Health checks:** liveness `GET /health` (always 200 while the process is up). Readiness `GET /ready` (503 when
   the database, migrations or providers are unhealthy). Never use `/ready` for liveness: a database blip would then
   restart the container.
5. **Region near Supabase and the web app.** Vercel runs in `cle1` (Ohio, AWS `us-east-2`). Pick the AWS/Azure region
   closest to the Supabase project's region (Supabase dashboard → Project settings).
6. **Outbound internet:** Supabase pooler (port 5432), Inkbox, Anthropic, Stripe, Amazon Location. No fixed outbound IP
   is needed unless Supabase network restrictions are turned on.
7. **Size:** 1 vCPU, 2 GB memory is plenty (the database pool is 4 connections).
8. **The same environment variables as Manufact,** from your secret store. Generate the list exactly as for Manufact:
   from the repo root, run `node .haggle-data/prod.mjs env` → `.env.deploy` (gitignored). Then change:
   - `HAGGLE_WEBHOOK_BASE_URL` → the new public origin (per-workspace mailboxes' webhooks go to
     `<origin>/webhooks/inkbox/<handle>`)
   - `MCP_URL` / `PUBLIC_BASE_URL` (if set) → the new origin
   - keep `HAGGLE_ENV=production`, `HAGGLE_MODE=live` and every secret unchanged

**Strong recommendation:** give the server its own domain, e.g. `mcp.tryhaggle.tech` (Cloudflare, DNS-only/grey
cloud like the apex). Clients, Inkbox and Vercel then point at a name you own, and any later move is only a DNS change.

## Step 0: build and test the image locally

From the repo root, at the commit you want live:

```sh
docker build -f deploy/Dockerfile -t haggle-mcp .
docker run --rm -p 3000:3000 -e HAGGLE_MODE=mock haggle-mcp      # mock: no secrets, no real database
curl http://localhost:3000/health                                 # {"ok":true,...}
curl -o /dev/null -w '%{http_code}\n' http://localhost:3000/ready # 200
npx mcp-use client connect local http://localhost:3000/mcp && npx mcp-use client local tools list
```

Pass `-e HAGGLE_BUILD_SHA=<sha>` (or set it in the cloud's env) so `/health` reports the release. The image is about
1.3 GB because it carries the whole monorepo's dependencies. That works; slimming it is optional.
**Never run the image with the production env locally while Manufact is live** (rule 1).

## Option A: AWS (ECS on Fargate behind an Application Load Balancer)

Assumes the AWS CLI is logged in, a VPC with two public subnets, and region `us-east-2` (change to match Supabase).

1. **Registry, then push the image**
   ```sh
   aws ecr create-repository --repository-name haggle-mcp
   aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-2.amazonaws.com
   docker tag haggle-mcp <acct>.dkr.ecr.us-east-2.amazonaws.com/haggle-mcp:<sha>
   docker push <acct>.dkr.ecr.us-east-2.amazonaws.com/haggle-mcp:<sha>
   ```
2. **Secrets.** Create one Secrets Manager secret per variable in `.env.deploy` (or one JSON secret, referenced by
   key). Grant the ECS task execution role `secretsmanager:GetSecretValue` on them. Never put secret values in the task
   definition's plain `environment`.
3. **Logs:** create the CloudWatch log group `/ecs/haggle-mcp`.
4. **Task definition** (Fargate, `cpu 1024`, `memory 2048`, Linux/x86_64): container `haggle-mcp`, image `:<sha>`,
   port 3000/tcp, `secrets` mapping each variable to its Secrets Manager ARN, `awslogs` to the log group, and a
   container health check `CMD-SHELL, node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`.
5. **Load balancer:** an internet-facing ALB with a target group of type `ip`, port 3000, health check path `/health`.
   Set the ALB **idle timeout to 300 s** (the default 60 s is too short for long MCP requests). HTTPS listener on 443
   with an ACM certificate for `mcp.tryhaggle.tech`; HTTP 80 redirects to 443. Security groups: the ALB accepts 443
   from anywhere; tasks accept 3000 only from the ALB.
6. **Service:** `desiredCount 1`, launch type Fargate, public IP on (or private subnets + NAT), attached to the target
   group, with `deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100 }`. That is stop-then-start:
   never two tasks (rule 1). Turn on the deployment circuit breaker with rollback. Create it with `desiredCount 0`
   until the cut-over.
7. **DNS:** Cloudflare CNAME `mcp` → the ALB's DNS name (DNS-only).
8. **Redeploy later:** build, push `:<newsha>`, register a new task definition revision with that image, then
   `aws ecs update-service --cluster haggle --service haggle-mcp --task-definition haggle-mcp:<rev>`.
   Restart: `aws ecs update-service --cluster haggle --service haggle-mcp --force-new-deployment`.
   Logs: `aws logs tail /ecs/haggle-mcp --follow`.

## Option B: Azure (Container Apps)

Assumes the Azure CLI (`az login`) and the `containerapp` extension (`az extension add -n containerapp`).

1. **Resource group and registry; build in the cloud** (no local push needed):
   ```sh
   az group create -n haggle -l eastus2
   az acr create -g haggle -n hagglemcp --sku Basic
   az acr build -r hagglemcp -t haggle-mcp:<sha> -f deploy/Dockerfile .
   ```
2. **Environment:** `az containerapp env create -g haggle -n haggle-env -l eastus2` (Log Analytics is created with it).
3. **App, exactly one replica, always on:**
   ```sh
   az containerapp create -g haggle -n haggle-mcp --environment haggle-env \
     --image hagglemcp.azurecr.io/haggle-mcp:<sha> --registry-server hagglemcp.azurecr.io \
     --ingress external --target-port 3000 --transport auto \
     --min-replicas 1 --max-replicas 1 --cpu 1.0 --memory 2.0Gi --revisions-mode single
   ```
   Creating the app starts it. Create it with the **mock** env first (`HAGGLE_MODE=mock`) and switch to the live env
   only at the cut-over (rule 1).
4. **Secrets:** `az containerapp secret set -g haggle -n haggle-mcp --secrets supabase-db-url=<value> ...` (or Key
   Vault references), then `az containerapp update -g haggle -n haggle-mcp --set-env-vars
   SUPABASE_DB_URL=secretref:supabase-db-url ...` for each variable in `.env.deploy`. Plain values (e.g.
   `HAGGLE_ENV=production`) can be set directly.
5. **Probes:** liveness HTTP `GET /health`, readiness `GET /ready`, port 3000 (`az containerapp update --yaml` with a
   `probes:` block). Container Apps' default request timeout (240 s) already exceeds rule 3.
6. **Custom domain:** `az containerapp hostname add`, then `az containerapp hostname bind --validation-method CNAME`
   for `mcp.tryhaggle.tech` (managed certificate); Cloudflare CNAME `mcp` → the app's default FQDN (DNS-only).
7. **Deploys overlap briefly.** In single-revision mode, Container Apps starts the new revision before it stops the old
   one, so for a few seconds two processes may tick. To avoid any overlap, first stop the running revision
   (`az containerapp revision list -g haggle -n haggle-mcp -o table`, then `az containerapp revision deactivate -g
   haggle -n haggle-mcp --revision <name>`), then update the image. Inbound email that arrives meanwhile is
   recovered on start (the server sweeps for anything missed while it was down).
8. **Redeploy later:** `az acr build -r hagglemcp -t haggle-mcp:<newsha> -f deploy/Dockerfile .`, then
   `az containerapp update -g haggle -n haggle-mcp --image hagglemcp.azurecr.io/haggle-mcp:<newsha>`.
   Restart: `az containerapp revision restart -g haggle -n haggle-mcp --revision <name>`.
   Logs: `az containerapp logs show -g haggle -n haggle-mcp --follow`.

## Cut-over from Manufact (either cloud)

Plan about 15 minutes. Deals keep their state in Supabase; nothing is lost while the server is down.

1. **Prepare the new host completely, but not live.** AWS: the service at `desiredCount 0`. Azure: the app on the mock
   env. Confirm every secret is set.
2. **Stop Manufact:** `npx mcp-use deployments list --json` for the running deployment's id, then
   `npx mcp-use deployments stop <deployment-id>`. Confirm `https://wild-forge-smbdu.run.mcp-use.com/health` no longer
   answers.
3. **Start the new host live** at exactly 1 instance. AWS: `desiredCount 1`. Azure: switch the env to the live values
   (step 4 of Option B). Check `https://mcp.tryhaggle.tech/ready` → `"ready": true` with `migrations.ok` and
   `database.ok`, and that `/health` shows the expected `build_sha`.
4. **Inkbox webhooks → the new URL.** The buyer mailbox: from the repo root, run
   `node .haggle-data/prod.mjs finish https://mcp.tryhaggle.tech/mcp`. It subscribes `<origin>/webhooks/inkbox`,
   redeploys the Vercel web app with the new `HAGGLE_MCP_URL`, re-applies Supabase sign-in and runs the checks.
   If it reports that Inkbox issued a NEW signing key, update the server's `INKBOX_WEBHOOK_SECRET` and restart.
   Then delete the old buyer subscription to `https://wild-forge-smbdu.run.mcp-use.com/webhooks/inkbox`
   (`subscriptions.delete(id, { scope: "identity" })`).
5. **Per-workspace mailboxes** (`HAGGLE_MAILBOX_PER_WORKSPACE`): each has its own subscription to
   `<old origin>/webhooks/inkbox/<handle>`. Change each URL **in place**, which keeps its signing key: for every
   subscription from `inkbox.webhooks.subscriptions.list({ agentIdentityId, scope: "identity" })` whose URL starts with
   the old origin, call `inkbox.webhooks.subscriptions.update(sub.id, { scope: "identity", url:
   sub.url.replace(OLD_ORIGIN, NEW_ORIGIN) })`, using the org admin key (`INKBOX_ADMIN_API_KEY`). List them again
   afterwards to confirm.
6. **Vercel:** `prod.mjs finish` already set `HAGGLE_MCP_URL`. Confirm `https://tryhaggle.tech/api/health` shows
   `mcp.reachable: true`. The web cron (`/api/cron/tick`) calls the server through that URL and needs nothing else.
7. **Clients:** update the claude.ai / ChatGPT connectors and any `.mcp.json` to `https://mcp.tryhaggle.tech/mcp`.
8. **Smoke test:** in the web app, start a small deal with a vendor that agreed to it; watch the email go out and the
   reply land on the board.
9. **Keep the Manufact server stopped, not deleted, for a week** as the rollback.

**Rollback:** stop the new host (AWS `desiredCount 0`; Azure deactivate the revision), restart Manufact
(`npx mcp-use deployments restart <deployment-id>`), re-run `prod.mjs finish https://wild-forge-smbdu.run.mcp-use.com/mcp`,
and point the per-workspace subscriptions back (step 5 reversed).

## Day-to-day operations after the move

| Task | Manufact today | AWS ECS | Azure Container Apps |
| --- | --- | --- | --- |
| Deploy | `mcp-use deploy --json` | push image, `ecs update-service` | `acr build`, `containerapp update` |
| Set env | `mcp-use servers env set` | Secrets Manager + new task revision | `containerapp secret set` / `--set-env-vars` |
| Restart | `mcp-use deployments restart` | `ecs update-service --force-new-deployment` | `containerapp revision restart` |
| Logs | `mcp-use deployments logs` | `aws logs tail /ecs/haggle-mcp` | `containerapp logs show` |
| TLS + URL | provided | ACM + ALB + DNS | managed cert + DNS |

Once a move actually happens, update `CHECKLIST.md`, `docs/deployment.md` and the prod deployment notes.
