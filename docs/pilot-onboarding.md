# Pilot onboarding (operator guide)

How an operator sets up one pilot customer: a catering or small-events buyer in the SF Bay Area,
vendors who agreed to be contacted, a human who approves every purchase by text, and payment made
by the customer directly to the vendor. Haggle never takes or sends money on a pilot server
(`HAGGLE_PAYMENTS=manual`).

Server setup (environment, migrations, deploy) is in `docs/deployment.md`. This guide starts once a
live server is running with migrations 100–113 applied.

Everything here runs on the operator's machine with direct database access. None of it goes through
an MCP tool: a model that could set who approves, or how much may be spent, could approve its own
purchases.

## 1. What the server needs for a pilot

| Setting | Pilot value | Why |
| --- | --- | --- |
| `HAGGLE_MODE` | `live` | real email and texts |
| `HAGGLE_ENV` | `staging` or `production` | `docs/deployment.md` §1 |
| `HAGGLE_PAYMENTS` | `manual` | no money moves through Haggle |
| `HAGGLE_ENABLE_SMS` | `true` | approval texts to the approver; vendors on the text channel |
| `HAGGLE_EXTERNAL_SENDERS` | `reply_token` | vendors on Gmail or Outlook (outside Inkbox) |
| `HAGGLE_ENABLE_CALLS` | only for vendors who agreed to Voice AI calls | |
| `PUBLIC_BASE_URL` | the server's public URL | goes into the connection details below |

The scripts read `SUPABASE_DB_URL` (and `HAGGLE_DB_SCHEMA` if set). They refuse a production database
unless `HAGGLE_ENV=production` (`apps/mcp/scripts/dbGuard.ts`). Run them from `apps/mcp`:

```
cd apps/mcp
node --env-file=<operator env file> scripts/workspace-create.ts ...
```

Never point an env file at production from a laptop except for a deliberate operator task
(`docs/deployment.md` §1, "Overriding the guard").

## 2. Create the workspace

```
node --env-file=<env> scripts/workspace-create.ts \
  --name "Bay Events Co" \
  --approver-phone +14155550123 \
  --cap 2500 \
  --timezone America/Los_Angeles \
  --area "San Francisco, CA" \
  [--approver-email ops@bayevents.example] [--id ws_bay_events] [--base-url https://<server>]
```

- `--approver-phone` is the one human whose texted `YES <code>` approves a purchase. Without it,
  nothing in the workspace can be approved on a live server. A phone that already approves for
  another workspace is refused unless you pass `--allow-shared-approver`. Texts from a shared number
  are held until the human adds the deal code.
- `--cap` is the most any one payment may be, in USD. Approvals above it carry a caveat, and the
  agent can only lower it.
- `--area` is the default "where" for requests that don't say.

The script prints the credentials once. Only their SHA-256 hashes are stored, so they can't be
shown again:

```
  MCP endpoint:   https://<server>/mcp
  Bearer token:   hgw_...
  Connector URL:  https://<server>/c/hgc_.../mcp

  Claude Code:    claude mcp add --transport http haggle https://<server>/mcp --header "Authorization: Bearer hgw_..."
```

It ends with the readiness check, which shows FAIL until vendors are added (§3).

Send the customer one of these through a channel you'd trust with a password:
- the Claude Code command;
- the connector URL;
- or the endpoint and the token.

### Which clients can connect

| Client | How | Status |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http haggle <endpoint> --header "Authorization: Bearer <token>"` | Bearer auth over HTTP is tested in this repo (`apps/mcp/tests/security.e2e.test.ts`, `acceptancePilot.test.ts`). The `claude mcp add --header` syntax is Claude Code's documented form. **Unverified** against a deployed pilot server. |
| Any MCP client that can send headers (streamable HTTP) | the endpoint plus `Authorization: Bearer <token>` | tested over HTTP in this repo |
| Claude (web/desktop) custom connector | the connector URL `/c/<secret>/mcp` | The server route is tested (a wrong secret is refused: `mcp.e2e.test.ts`). **Unverified**: whether a given Claude plan accepts an authless custom connector. |
| ChatGPT custom connector / developer mode | the connector URL | **Unverified** (needs a public HTTPS URL; acceptance depends on the ChatGPT plan's connector policy) |

The connector URL is a bearer secret embedded in a URL. Anyone with it acts as the workspace (they
still can't approve: only the approver's text does). Rotate it if it leaks (§5).

## 3. Add vendors, each with its consent

```
node --env-file=<env> scripts/workspace-admin.ts add-vendor --id ws_bay_events \
  --contact events@harbortable.example --name "Harbor Table" \
  --consent "Maria (owner) agreed by phone 2026-10-20 to get quote requests by email"

node --env-file=<env> scripts/workspace-admin.ts add-vendor --id ws_bay_events \
  --contact +14155550177 --name "Sunset Kitchen" --channel text \
  --consent "Dev agreed in person 2026-10-21 to get quote requests by text"
```

- `--consent` is required. Record who agreed, how and when; it is stored with the vendor and shown by
  `show`. What counts as enough consent is still an open decision (`docs/overnight-sprint-report.md` §10).
- `--channel` is `email` (the default for an address), `text` (SMS from Haggle's number, or iMessage
  when enabled), or `phone` (a Voice AI call; only vendors who agreed to AI calls, and only with
  `HAGGLE_ENABLE_CALLS=true`).
- One vendor can have an email row and a phone row under the same name. They are treated as one vendor.
- The agent can name a vendor (`deal(businesses=['Harbor Table'])`). It can also name none, and then
  every vendor of the workspace is contacted. Workspace vendors count as catering vendors (the
  pilot's scope); for any other kind of request the agent must name them.
- A vendor that opted out or bounced is never contacted, whatever its row says. `remove-suppression`
  is the escape hatch for a wrong one. It applies to every workspace and records who removed it and why.

Other vendor commands: `list-vendors --id`, `remove-vendor --id --contact`.

## 4. Check readiness

```
node --env-file=<env> scripts/workspace-admin.ts show --id ws_bay_events
```

This prints the settings, credential state and vendors (contacts masked, never a secret or hash),
then the readiness check:

```
  Readiness: PASS (5/5 checks)
    [PASS] credentials: active (bearer token + connector URL)
    [PASS] approver: texts to +14155550123 (only their YES <code> approves)
    [PASS] spending cap: $2500.00 per payment
    [PASS] vendors: 3 with recorded consent
    [PASS] suppressions: no vendor opted out or bounced
    [WARN] no approver email: receipts go by text only
```

Each FAIL line gives the exact command that fixes it. The script exits with status 1 on FAIL, so
you can run it in a checklist or a CI step. WARN lines don't fail the check.

The check can't see the server's channel switches. A text vendor needs `HAGGLE_ENABLE_SMS` (or
iMessage), and a phone vendor needs `HAGGLE_ENABLE_CALLS`. If a channel is off, the vendor shows up
as a setup blocker when a deal starts, and nothing is sent to it.

## 5. Change, rotate, revoke

| Task | Command |
| --- | --- |
| New approver | `set-approver --id <ws> --phone +1... [--email ...]` (`--phone none` clears it) |
| New cap | `set-cap --id <ws> --usd 1500` |
| Leaked or lost credentials | `rotate --id <ws> [--base-url https://<server>]`: new token and connector URL, printed once; the old ones stop working at once |
| Stop a customer | `revoke --id <ws>`: every request with its credentials is refused (401) until `rotate` |

## 6. What the customer's human does

There are three things, all on their own phone or in their own chat:

1. **Answer a vendor's question** if the agent asks: in chat, or by replying to Haggle's text.
2. **Approve** by replying `YES <code>` to Haggle's text (or `NO <code>`). The agent never sees the code.
3. **Pay the vendor directly**, only after Haggle texts that the vendor confirmed the booking and
   sent payment instructions. Then reply `PAID <code>`. Haggle records that the customer *reports*
   paying. The money counts as received only when the vendor confirms it.

If the vendor's payment details came only through the email thread or by SMS, Haggle's text says to
confirm them with the vendor by phone before paying. Haggle never opens links in vendor messages.

## 7. When something stalls

- **No booking confirmation within 24 hours:** Haggle reminds the vendor once, texts the human
  "don't pay", and records `operator_attention: booking_unconfirmed`.
- **No payment instructions within 48 hours:** the same, as `payment_instructions_overdue`.
- **A cancellation after the customer reported paying:** Haggle can't refund it. The operator is
  flagged (`cancel_after_reported_payment`) and the human is told to contact the vendor.

Operator review and retries are covered in `apps/mcp/scripts/job-ops.ts` (workstream F's
`docs/operator-recovery.md`).

## 8. Rehearse without real vendors

`apps/mcp/tests/acceptancePilot.test.ts` runs this whole flow end to end. It is SIMULATED: in-memory
store, fake email and SMS ports, no provider. It covers onboarding, three vendors, a plain-language
request, a vendor question, approval by text, booking, handoff and PAID, over the real MCP endpoint.
Run it with `npx vitest run apps/mcp/tests/acceptancePilot.test.ts`.
