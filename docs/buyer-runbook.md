# Haggle buyer runbook (Yash's lane)

> **Superseded (2026-10-22).** This predates the move to Inkbox and Stripe and still mentions Primitive, x402 and pnpm. Kept as history. Current docs: `README.md`, `docs/deployment.md`, `docs/staging-handoff.md`.

## What runs today

| Capability | Mock mode (default) | Live mode |
|---|---|---|
| `deal` → per-job inbox, RFQ text + `rfq.json`, idempotent | ✅ tested E2E | code ready, **not exercised live** |
| Inbound: signed webhook → match → trust → store | ✅ (simulated mail) | ✅ chain tested on SDK-signed events; **no live webhook yet** |
| Parse: `quote.json` exact, text/PDF via Claude | ✅ (sim extractor) | Claude path unit-tested with a fake client; **no live call yet** |
| Follow-up for vague quotes, seller questions, `answer_seller` | ✅ | same code |
| Honest negotiation (real quotes only), ranking, rejections | ✅ | same code |
| Approval: MCP form / verified email / DEMO simulated | ✅ simulated; form path built | email path tested on signed events |
| x402 payer: guard → sign → in-thread send → receipt | ✅ DEMO (real SDK step building, stub signer) | **blocked**: no `x402_payments`, 0 test USDC |
| Deal board MCP App | ✅ screenshots in `docs/screenshots/` | same view |
| Persistence | in-memory | Postgres (`100_engine_core.sql`), suite passes on Postgres 17 |
| Brain (`ask`, `check_price`, `discover`, learning) | engine `StubBrain` (honest empty answers) | same stub until `@haggle/brain` lands |

## Commands

```bash
corepack pnpm demo            # golden scenario in the terminal, real engine, DEMO-labelled
corepack pnpm demo:server     # MCP server on :3000 in mock mode + Inspector (/inspector)
corepack pnpm verify          # typecheck + tests + build + DB assertions + Postgres suite (needs Docker)
corepack pnpm test:pg         # engine suite against a throwaway Postgres with migrations
```

Connect Claude Code to the mock server: `claude mcp add --transport http haggle http://localhost:3000/mcp`,
then: *"Book lunch for 40 on Thu Oct 22 in SF, at least 12 vegetarian, delivery included, budget $1,200.
Find the caterers yourself, pick the cheapest that meets everything, and get my approval before paying."*

## Live mode (each step needs your go-ahead; nothing below has been run)

1. **DB:** apply the migration to the hosted project (changes production state):
   `PGURL="$(node --env-file=.env -p process.env.SUPABASE_DB_URL)" docker run --rm -i -e PGURL postgres:17-alpine sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -q' < supabase/migrations/100_engine_core.sql`
2. **Push** the branch (GitHub mode deploy needs it), then **deploy a preview**:
   `cd apps/mcp && ./node_modules/.bin/mcp-use deploy --root-dir apps/mcp --branch yash/integrate-quote-broker`
   and set env with `mcp-use servers env set <server> KEY=VALUE` for: `HAGGLE_MODE=live`, `PRIMITIVE_API_KEY`,
   `PRIMITIVE_WEBHOOK_SECRET`, `HAGGLE_INBOX_DOMAIN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `ANTHROPIC_MODEL`,
   `SUPABASE_DB_URL`, `HAGGLE_PAYER_PRIVATE_KEY` (testnet), `HAGGLE_GLOBAL_PAYMENT_CAP_CENTS=500`, `HAGGLE_DEMO_FLEET`.
3. **Webhook:** create the one Primitive endpoint → `https://<preview>/inbound` (`email.received`, `email.bounced`),
   then set `PRIMITIVE_WEBHOOK_ENDPOINT_ID`. `/inbound` verifies the raw-body signature first.
4. **First live deal** only to Partner's fleet addresses or an inbox you own (`HAGGLE_DEMO_FLEET="Bay Catering <…>; …"`).
5. **Payment** stays refused (SIGNING_REFUSED / feature_disabled) until `x402_payments` is granted and
   `0x81E8…2AB9` holds ≥ 5 test USDC.

Live mode refuses to start partially: `/health` → 503 and every tool → `CONFIG_MISSING` naming the variables.

## Safety properties (tested)

- Seller mail is data: the LLM gets no tools; scam links and injected instructions are flagged and excluded.
- Mail failing DKIM/DMARC as the business's pinned address never becomes a quote (and can't knock out the real one).
- Replies to a business always go to its pinned address with explicit threading, never to a Reply-To.
- Negotiation cites only quotes the ranker accepts; competitors are never named.
- Approval is a human decision (form the model can't fill, or `APPROVE <code>` from the verified approver);
  a quote revision voids it; simulated approval is impossible on live jobs (code and DB trigger).
- Payment: guard + DB constraints (base-sepolia only, exact base units, cap ≤ 10 USDC, one active payment per job,
  signing only for an approved approval and a trusted in-thread invoice); only a receipt marks it settled;
  simulated receipts are labelled DEMO and never get an explorer link.
