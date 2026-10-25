# Pilot onboarding (operator guide)

How an operator sets up one pilot customer: a catering or small-events buyer in the SF Bay Area,
vendors who agreed to be contacted, a human who approves every purchase by text, and payment made
by the customer directly to the vendor. Haggle never takes or sends money on a pilot server
(`HAGGLE_PAYMENTS=manual`).

Server setup (environment, migrations, deploy) is in `docs/deployment.md`. This guide starts once a
live server is running with every engine migration applied, including `119_engine_pilot.sql` (the
operator log: suspension, approver verification and the roster history live there).

The whole path, in order:

1. `workspace-create.ts` (dry run, then `--apply`): the workspace, its approver and cap, credentials.
2. `workspace-admin.ts verify-approver`: you confirm the approver phone is really the approver's.
3. `workspace-admin.ts add-vendor` three or more times: real vendors, each with its recorded consent.
4. `pilot-preflight.ts --workspace <id>`: every deployment and workspace check, with the fix for each.
5. Hand the credentials over (§2) and send the customer `docs/first-user-guide.md`.

Every change these scripts make is recorded in the operator log (who: `--by`, why: `--reason`, when).
`workspace-admin.ts history --id <ws>` lists it.

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

First a dry run. It validates the arguments, checks the database (an existing id, an approver phone
already used by another workspace) and prints what it would do. Nothing is written and no secret is
shown:

```
node --env-file=<env> scripts/workspace-create.ts \
  --name "Bay Events Co" \
  --approver-phone +14155550123 \
  --cap 2500 \
  --timezone America/Los_Angeles \
  --area "San Francisco, CA" \
  [--approver-email ops@bayevents.example] [--id ws_bay_events] [--base-url https://<server>]
```

Then the same command with `--apply --by "<you>" --credentials-file <new file>`:

- The credentials go into the file, created with mode 0600. An existing file is never overwritten.
  Stdout shows where they are and how to hand them over, never the secrets themselves.
- `--print-credentials` (instead of `--credentials-file`) prints them once on stdout. Use it only on
  a terminal nobody records.
- Re-running for a workspace that already exists with the same settings changes nothing and issues
  no new credentials (`rotate` does that). Different settings are refused, with the
  `workspace-admin.ts` command that changes each one.
- On a staging or production database, a `localhost` base URL is flagged: the customer's client
  needs the server's public URL (`--base-url` or `PUBLIC_BASE_URL`).

- `--approver-phone` is the one human whose texted `YES <code>` approves a purchase. Without it,
  nothing in the workspace can be approved on a live server. A phone that already approves for
  another workspace is refused unless you pass `--allow-shared-approver`. Texts from a shared number
  are held until the human adds the deal code.
- `--cap` is the most any one payment may be, in USD. Approvals above it carry a caveat, and the
  agent can only lower it.
- `--area` is the default "where" for requests that don't say.

Only the credentials' SHA-256 hashes are stored, so they can't be shown again. The credentials file
holds:

```
  MCP endpoint:   https://<server>/mcp
  Bearer token:   hgw_...
  Connector URL:  https://<server>/c/hgc_.../mcp

  Claude Code:    claude mcp add --transport http haggle https://<server>/mcp --header "Authorization: Bearer hgw_..."
```

The output ends with the readiness check, which shows FAIL until vendors are added (§3).

**Handing the credentials over.** Send the customer the file's contents through a channel meant for
secrets (a password manager share), then delete the file. The customer needs one of:
- the Claude Code command;
- the connector URL, for Claude or ChatGPT custom connectors;
- or the endpoint and the token, for any client that can send a header.

The connector URL *is* the credential. It belongs only in the customer's connector settings: never in
a chat message, an email body, a ticket or a screenshot.

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

A pilot needs at least three real vendors who agreed to be contacted.

```
node --env-file=<env> scripts/workspace-admin.ts add-vendor --id ws_bay_events \
  --contact events@harbortable.example --name "Harbor Table" --by "<you>" \
  --consent "Maria (owner) agreed by phone 2026-10-20 to get quote requests by email"

node --env-file=<env> scripts/workspace-admin.ts add-vendor --id ws_bay_events \
  --contact +14155550177 --name "Sunset Kitchen" --channel text --by "<you>" \
  --consent "Dev agreed in person 2026-10-21 to get quote requests by text"
```

- `--consent` is required. Record who agreed, how and when. It is stored with the vendor, shown by
  `show`, and written to the operator log with `--by`. The preflight counts a vendor only when its
  consent is at least a short sentence (10 characters). What counts as enough consent is still an open
  decision (`docs/overnight-sprint-report.md` §10).
- Adding the same contact again replaces its consent; the log keeps the old text.
- `remove-vendor --id <ws> --contact <c> --by <you> --reason "<why>"` stops it being contacted. The
  removed vendor's consent stays in the log.
- On a live workspace the preflight rejects simulated contacts: the demo fleet (`*.sim.haggle.dev`),
  reserved test domains (`.example`, `.test`, `example.com`), fictional 555-01xx numbers, and anything
  configured in `HAGGLE_DEMO_VENDORS` or `HAGGLE_DEMO_FLEET`. The examples in this guide use
  `.example` addresses for that reason: replace them with the vendors' real contacts.
- `--channel` is `email` (the default for an address), `text` (SMS from Haggle's number, or iMessage
  when enabled), or `phone` (a Voice AI call; only vendors who agreed to AI calls, and only with
  `HAGGLE_ENABLE_CALLS=true`).
- One vendor can have an email row and a phone row under the same name. They are treated as one vendor.
- The agent can name a vendor (`deal(businesses=['Harbor Table'])`). It can also name none, and then
  every vendor of the workspace is contacted. Workspace vendors count as catering vendors (the
  pilot's scope); for any other kind of request the agent must name them.
- A vendor that opted out or bounced is never contacted, whatever its row says. `remove-suppression`
  is the escape hatch for a wrong one. It applies to every workspace and records who removed it and why.

Other vendor commands: `list-vendors --id`, `history --id` (the roster's changes, with who and why).

## 4. Verify the approver

The approver phone is the one number whose `YES <code>` text approves a purchase, so confirm it
belongs to the approver before the first deal. Haggle has no automatic check for this yet. Do it out of
band, for example:

1. Text a short code from your own phone to the approver number.
2. Call the approver on a number you already know for them, and have them read the code back.

Then record it:

```
node --env-file=<env> scripts/workspace-admin.ts verify-approver --id ws_bay_events \
  --phone +14155550123 --by "<you>" \
  --how "texted a code from my phone; Maria read it back on a call 2026-10-22"
```

`--phone` must be the workspace's current approver phone. Any approver change (`set-approver`) needs a
new verification, even a change back to the old number. `unverify-approver --id <ws> --by <you>
--reason "<why>"` withdraws one, for example if the phone is lost.

## 5. Check readiness

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
you can run it in a checklist or a CI step. WARN lines don't fail the check. `show` also prints whether
the workspace is suspended and whether the approver is verified.

The check can't see the server's channel switches. A text vendor needs `HAGGLE_ENABLE_SMS` (or
iMessage), and a phone vendor needs `HAGGLE_ENABLE_CALLS`. If a channel is off, the vendor shows up
as a setup blocker when a deal starts, and nothing is sent to it.

### The full pilot preflight

`show` checks one workspace's own rows. Before the first real deal, run the pilot preflight, which
also checks the deployment:

```
npx tsx scripts/pilot-preflight.ts --target staging --env-file <staging env file> \
  --db-url-env SUPABASE_DB_URL --workspace ws_bay_events [--json]
```

It reads the env file and the database only. Each check is PASS, WARN, FAIL or BLOCKED, with a `fix:`
line. BLOCKED means the fix is outside the session: a provider dashboard, or the approver verification.

- **Deployment:** everything `launch-gate.ts` checks (configuration, the migration ledger, the
  production-database guard), plus:
  - `HAGGLE_PAYMENTS=manual`;
  - a vendor-contact window (`HAGGLE_CONTACT_HOURS` not `off`);
  - the webhook signing secret and the Inkbox key are present (Inkbox isn't called);
  - `HAGGLE_ALLOWED_RECIPIENTS` has no whole-domain entries;
  - an alert webhook is set;
  - no demo vendors are configured;
  - brain tenancy (PASS: learned profiles are scoped per workspace; apply `202_brain_tenancy.sql` before deploying, which this check can't see).
- **Each workspace:**
  - credentials active, and not suspended;
  - an approver phone, and that phone verified;
  - a spending cap;
  - at least 3 usable vendors: a valid contact, recorded consent, not suppressed, not simulated;
  - a default area and an approver email (WARN when missing).

The Inkbox webhook subscription stays BLOCKED unless you ask for the read-only listing with
`--check-webhooks --webhook-url https://<server>/webhooks/inkbox`.

Exit codes: 0 ready (warnings allowed), 1 something failed, 3 only BLOCKED items remain, 2 usage
error. On `--target production` the contact window, allowlist, alert webhook and demo-vendor checks
fail instead of warning.

## 6. Change, rotate, revoke, suspend

Every change needs `--by "<you>"`, and most need `--reason "<why>"`. Both are written to the operator
log.

| Task | Command |
| --- | --- |
| New approver | `set-approver --id <ws> --phone +1... [--email ...] --by <you> --reason "<why>"` (`--phone none` clears it). Then verify it again (§4). |
| New cap | `set-cap --id <ws> --usd 1500 --by <you> --reason "<why>"` |
| Leaked or lost credentials | `rotate --id <ws> [--base-url https://<server>] --by <you> --reason "<why>"`: a new token and connector URL, printed once. The old ones stop working at once. |
| Stop a customer for good | `revoke --id <ws> --by <you> --reason "<why>"`: every request with those credentials is refused (401) on the next call, until `rotate` |
| Pause a customer | `suspend --id <ws> --by <you> --reason "<why>"`: the credentials still work, but every tool call gets `WORKSPACE_SUSPENDED`, and every open deal is held (nothing more is sent). Lift it with `resume --id <ws> --by <you> --reason "<why>"`. See `docs/operator-recovery.md` §7. |

## 7. What the customer's human does

There are three things, plus one when needed, all on their own phone or in their own chat:

1. **Answer a vendor's question** if the agent asks: in chat, or by replying to Haggle's text.
2. **Approve** by replying `YES <code>` to Haggle's text (or `NO <code>`). The agent never sees the code.
3. **Accept the booking** with `BOOKED <code>`, only when Haggle asks. It asks when the vendor's
   "confirmed" came from an email Haggle can't attribute to the vendor: outside mail proven only by
   Haggle's reply reference, which is usual for Gmail and Outlook vendors today. Check with the vendor
   first. For the same reason, a "payment received" from such a sender is passed on to the human,
   never recorded as verified.
4. **Pay the vendor directly**, only after Haggle texts that the vendor confirmed the booking and
   sent payment instructions. Then reply `PAID <code>`. Haggle records that the customer *reports*
   paying. The money counts as received only when the vendor confirms it.

If the vendor's payment details came only through the email thread or by SMS, Haggle's text says to
confirm them with the vendor by phone before paying. Haggle never opens links in vendor messages.

## 8. When something stalls

- **No booking confirmation within 24 hours:** Haggle reminds the vendor once, texts the human
  "don't pay", and records `operator_attention: booking_unconfirmed`.
- **No payment instructions within 48 hours:** the same, as `payment_instructions_overdue`.
- **A cancellation after the customer reported paying:** Haggle can't refund it. The operator is
  flagged (`cancel_after_reported_payment`) and the human is told to contact the vendor.

Operator review and retries are covered in `apps/mcp/scripts/job-ops.ts` (workstream F's
`docs/operator-recovery.md`).

## 9. Rehearse without real vendors

`apps/mcp/tests/acceptancePilot.test.ts` runs this whole flow end to end. It is SIMULATED: in-memory
store, fake email and SMS ports, no provider. It covers onboarding, three vendors, a plain-language
request, a vendor question, approval by text, booking, handoff and PAID, over the real MCP endpoint.
Run it with `npx vitest run apps/mcp/tests/acceptancePilot.test.ts`.

The onboarding steps above (provisioning, consent, verification, suspension, preflight) are covered,
also SIMULATED, by `apps/mcp/tests/operatorActions.test.ts`, `pilotPreflight.test.ts` and
`lifecycleControls.test.ts`.
