# v3 pre-kickoff readiness (handoff for the 10:30 contracts hour)

Prepared 2026-10-17 08:55–09:40 PDT by Yash's agent. Supersedes the status rows in
`docs/preflight-readiness.md` and the open questions in `docs/v3-kickoff-prep.md`. The proposed
contract is in `docs/v3-contract-freeze-proposal.md`.

## 1. Executive summary

- **Ready to start:** credentials work for Primitive (buyer org), Anthropic and Supabase. Tests
  pass (40 core + 1 engine), the build works, and migrations pass on a throwaway Postgres.
  The engine package skeleton exists. A private GitHub repo exists.
- **Blocked:** x402 (`x402_payments` missing; spend policy 403) and the buyer wallet holds
  **0 test USDC**. Payment uses the fake gateway (labelled DEMO) until both are fixed; the
  Stripe test fallback has no key yet.
- **Not verified:** webhook delivery (no endpoint yet), Manufact hosting (no servers or
  deployments), long-poll `since`/`wait` behaviour, Anthropic structured output and PDF input
  in practice (the Models API reports both as supported; neither was exercised).
- **Must decide at 10:30:** the contract (D1–D12). The most consequential are the 9th tool
  `answer_seller`, sender-trust wording, no FK across migration lanes, the money convention,
  and the new `accept.json` part that triggers the invoice.

## 2. Completed actions (this session, before kickoff)

| Commit | What |
|---|---|
| `7c11990`, `b3296c0`, `3932bb0`, `1193cd2` | Read-only preflight script; `.env` setup (Supabase ref typo fixed, DB password URL-encoded); redaction hardening; Anthropic workspace-header finding; readiness doc |
| `2a5909f` | v3 kickoff gap analysis |
| `216e60b` | `packages/engine` skeleton (manifest, tsconfig, smoke test, folder `CLAUDE.md`), `apps/mcp/CLAUDE.md`; preflight now also checks entitlements, long-poll reachability, webhook endpoints, routes, Anthropic capabilities, wallet (read-only RPC) and Stripe presence |
| (this commit) | This doc + contract freeze proposal + x402 request drafts |

Nothing was sent, signed, paid, deployed, pushed or migrated on the hosted project.

## 3. Service preflight (run 09:00 PDT, `corepack pnpm --filter @haggle/spikes preflight`)

Summary: 27 PASS, 3 BLOCKED, 2 NOT VERIFIED.

| Service | Check | Result | Evidence |
|---|---|---|---|
| Primitive | API key | PASS | `GET /whoami` 200, org `ae53e147…`, plan `developer` |
| Primitive | Buyer domain / sender | PASS | `brave-dog.primitive.email` in `/domains` (verified, DNS healthy); `/outbound/status` lists it in `sendable_domains`; `send_mail` entitlement |
| Primitive | Job inbox creation | PASS by doc, NOT VERIFIED in practice | Managed domain accepts any local part (Pass 1 docs reading); no resource needs creating; proven by the first real send/receive |
| Primitive | Reply-only scope | PASS for the fleet | `send_to_primitive_managed_domains`, `send_to_known_addresses`, … present; no `any_recipient`. Arbitrary external addresses are restricted |
| Primitive | Webhook | NOT VERIFIED | `/endpoints` = [] (1 allowed per org); `/routes` = []; secret matches org (SHA-256) |
| Primitive | Long-poll | PASS (reachable) / NOT VERIFIED (behaviour) | `GET /emails` 200, `meta.cursor` null (no mail yet); `since`, `wait`, `recipient` params exist in the SDK's OpenAPI |
| Primitive | Sender-auth signals | Present in SDK | `email.auth` (SPF/DKIM/DMARC) + `validateEmailAuth` + `isTrustedSender`; **no** `sender_verified` and **no** `analysis.sender.authenticated` in SDK 2.4.0 |
| Primitive | `interactions_enabled` | PASS | `/account` entitlements |
| Primitive | `x402_payments` | **BLOCKED** | missing; `/x402/spend-policy` and `/x402/payout-addresses` → 403 `feature_disabled` |
| Wallet | Payer address | PASS | derived locally: `0x81E813E63F22C4Be2332D25b1deA60fc72e62AB9` (no signing) |
| Wallet | Network / funds | PASS chain / **BLOCKED** funds | `sepolia.base.org` chainId 84532; 0 ETH (not needed for EIP-3009 payer); **0** USDC at `0x036C…CF7e` |
| Anthropic | Key + model | PASS | `GET /v1/models/claude-sonnet-5-5` 200 with `anthropic-workspace-id` |
| Anthropic | Structured outputs, PDF input | PASS as reported, NOT VERIFIED in use | `capabilities.structured_outputs/pdf_input.supported = true` |
| Supabase | Project / connection / role | PASS | ref `behfuaxftitnzkkbnaia`, Postgres 17.11, `postgres` has BYPASSRLS, `sb_secret_` key → `/rest/v1/` 200 |
| Supabase | Engine / brain tables | PASS (none yet, expected) | 0 public tables; no `supabase_migrations` table |
| Manufact | CLI + auth | PASS | `mcp-use whoami` → Yashnil Mohanty's Projects |
| Manufact | Servers / deployments / previews | NOT VERIFIED | `servers list` → 0 items; nothing deployed |
| Manufact | Custom routes for webhooks | PASS locally / NOT VERIFIED hosted | `mcp-use start` served `/health` + `tools/list`; `server.post()` is a Hono route |
| Stripe | Test key | NOT VERIFIED | `STRIPE_SECRET_KEY` not configured; the check refuses non-`sk_test_` keys and only calls `GET /v1/balance` |
| GitHub | Repo / access | PARTIAL | `yashnil/haggle` private, `viewerPermission: ADMIN`; only `yash/buyer-foundation` pushed (at `2a5909f`, local is ahead); **`main` not pushed; default branch is `yash/buyer-foundation`; partner not a collaborator** |

## 4. Repo / git state

- Branch `yash/buyer-foundation` tracks `origin/yash/buyer-foundation`; local is ahead (not pushed).
- **Root `CLAUDE.md` (v3, +166/−21 lines) is uncommitted.** It's shared; Yash's edit; left untouched.
- Present: `packages/core` (Pass 1 buyer logic, now shared territory), `packages/engine` (skeleton),
  `apps/mcp` (scaffold + `/health`), `fixtures/buyer/` (Pass 1, now Partner-owned folder),
  `supabase/migrations/20261016000000_buyer_core.sql` (v2 naming). Absent: `packages/brain`,
  `apps/sellers`, `apps/bench`, `PLAN.md` (the PDF is the plan; `*.pdf` is git-ignored).
- v2 leftovers that conflict with v3: `CONTRACTS.md` (v2 contract, buyer-authoritative sections);
  `docs/buyer-implementation-plan.md` (7 tools, v2 seller names); `fixtures/buyer` seller names
  (Golden Gate Kitchen, Fog City Deli, Sunset Bistro, Hayes Valley Kitchen); migration table set
  (`sellers`, 14 tables); Pass 1 job states (15) vs CLAUDE.md's 9.

## 5. Tests

| Command | Result |
|---|---|
| `corepack pnpm typecheck` | clean (core, engine, mcp, spikes) |
| `corepack pnpm test` | core 40/40, engine 1/1 |
| `corepack pnpm build` | `apps/mcp` built |
| `scripts/verify-migrations.sh` | all assertions passed (throwaway Postgres 17) |
| lint | no lint scripts defined |

## 6. Proposed shared-contract changes

See `docs/v3-contract-freeze-proposal.md` (full TypeScript + D1–D12). Shared-file patches to
apply **only after approval**:

- `CLAUDE.md` §6: add a row `answer_seller(job_id, question_id, answer)` → "Sends the buyer's
  answer in the business's thread; only for a pending question" → engine.
- `CLAUDE.md` §8 item 4: "all tools stubbed" → "all nine tools"; item 12: "…and back in-thread via
  `answer_seller`".
- `CLAUDE.md` §3 Primitive bullet, replace the trust sentence with: *"Trust a sender only when
  `isTrustedSender(event, { domain, sender })` returns `trusted: true` on the signed webhook
  event (Primitive's SPF/DKIM/DMARC verdict anchored to the expected domain and address). There
  is no `sender_verified` field. `retryable` (DMARC temperror) means answer 5xx and let delivery
  retry."*
- `CLAUDE.md` §7 Approval bullet: *"…or an email reply in the approval thread from
  `approver_email` for which `isTrustedSender` is `trusted`, whose first line is `yes` or
  `APPROVE <code>`, before the approval expires. Anything else is not an approval."*
- PDF/PLAN tool table: add `answer_seller`; "sender_verified" → as above.
- `CONTRACTS.md`: mark superseded by `packages/core/contracts.ts` (buyer-authored, v2).

## 7. Design decisions

### A. Tool inventory: nine tools

`ask`, `discover`, `check_price`, `deal`, `wait_for_update`, `get_quotes`, `answer_seller`,
`approve`, `pay`.

- `answer_seller(job_id, question_id, answer)`: accepted only when `question_id` is a pending
  question on that job that came from a business on the job. It replies in that business's
  thread from the job inbox with an idempotency key `answer:<question_id>`. A second call with
  different text is rejected (`already_answered`). The answer is stored with who and when.
  Description: "Use when `wait_for_update` or `get_quotes` shows a pending question you can
  answer. Don't use it to negotiate or to contact a business that hasn't asked anything."
  I used `question_id` rather than the brief's `message_id` because one message can carry
  several questions, and the id is what `JobUpdate` exposes.
- `cancel` stays internal: deadline expiry, approval decline and operator cleanup call
  `engine.cancelJob(job_id, reason)`. It's idempotent, notifies contacted businesses once, and
  refuses to touch a settled payment. Agent-facing `cancel` is **not** in v3; revisit only if
  Manufact suite runs show agents need it.
- Places to change: CLAUDE.md §6 and §8 items 4/12, PDF/PLAN tool table, the contract (D1), the
  Manufact suite task prompts (Partner, item 32), `docs/buyer-implementation-plan.md`.

### B. Sender trust and approval

Facts (SDK 2.4.0, the latest): webhook `email.received` events carry `email.auth`.
`validateEmailAuth(auth)` returns legit/suspicious/unknown, and
`isTrustedSender(event, { domain, sender? })` returns `{ trusted, retryable, reason, auth }`. It
anchors DMARC to the expected domain, strict-parses From (rejecting display-name spoofs and
multi-address From), and has a rule for direct children of `primitive.email`. It warns that
`normalizeReceivedEmail().sender` and Reply-To are **not** safe anchors. There's no
`sender_verified` and no `analysis.sender.authenticated`.

Adapter (engine, `primitive/trust.ts`):

```ts
type TrustVerdict =
  | { trusted: true;  address: string; domain: string; reason: "trusted"; evidence: AuthEvidence }
  | { trusted: false; retryable: boolean; reason: TrustReason | "not-webhook-source" | "no-event"; evidence?: AuthEvidence };
function senderTrust(event: EmailReceivedEvent, expected: { domain: string; sender?: string }): TrustVerdict
```

- It's the only place the engine asks "is this really X?". Evidence (DMARC result, policy,
  aligned DKIM domain, SPF) is stored on the message row for audit.
- Businesses: expected `{ domain: emailDomain(snapshot), sender: snapshot }`. Untrusted replies
  are stored and parsed for display, but flagged `unverified_sender` and **cannot** win, be
  approved or be paid.
- Payment challenges: the trusted sender must equal the quoting business's snapshot and the
  thread must be the business's job thread.
- Email approval: (1) the reply is in the thread of the approval-request email Haggle sent
  (binds the request id); (2) `senderTrust(event, { domain: approverDomain, sender: approver_email })`
  is trusted; (3) the first non-quoted line is exactly `yes` or `APPROVE <code>`, where the code
  is a 6-character nonce in the request email and anything else counts as ambiguous; (4) the
  request is unexpired (30 min) and unused (one-shot; replays rejected by a unique constraint);
  (5) the quote revision and amounts are unchanged since the request was sent (otherwise the
  approval is void and a new request is needed).
- Trust is computed only from **signed webhook events**. Long-poll results don't have the event
  shape `isTrustedSender` takes. Rebuilding one from `GET /emails/{id}` is NOT VERIFIED, so
  polled mail is stored with `trust = unknown` until a webhook copy or a verified mapping
  arrives. If webhooks aren't working, **email approval is disabled** and only elicitation
  approves; nothing gets weaker.
- Elicitation is host-attested (the model can't fill the form). It's stored as channel
  `elicitation` along with the MCP client info. If the host doesn't support elicitation and
  email approval is disabled, `approve` returns `pending_human` with the reason. It never
  approves.

### C. Migration ordering

`supabase/migrations/100_engine_core.sql` (Yash) runs before any `2xx_brain_*`. Engine tables
carry `business_id text not null` as a **logical** reference with **no FK** to brain tables. Brain
migrations never alter engine tables.

```sql
create table public.job_businesses (
  job_id text not null references public.jobs(id) on delete cascade,
  business_id text not null,                 -- logical ref to brain businesses(business_id); no FK by design
  business_name_snapshot text not null,
  email_snapshot text not null check (email_snapshot = lower(email_snapshot)),
  source text not null check (source in ('fleet','web','agent')),
  simulated boolean not null,
  thread_id text,                            -- Primitive thread of the RFQ
  rfq_message_id text unique,
  state text not null default 'pending',
  contacted_at timestamptz,
  primary key (job_id, business_id),
  unique (job_id, email_snapshot)
);
create trigger job_businesses_snapshot_immutable before update of business_id, business_name_snapshot, email_snapshot
  on public.job_businesses for each row execute function public.haggle_reject_update();
```

Tables: `jobs, job_businesses, messages, quotes, approvals, payments` (CLAUDE.md item 5) plus
two engine-internal ones: `inbound_events` (dedupe) and `ingest_cursors` (long-poll), and the
existing append-only `audit_events`. All Pass 1 DB invariants carry over: RLS forced with no
policies, one current quote per (job, business), counters cite a real quote, one active payment
per job, base-sepolia only, amount ≤ approved. `business_id` is deterministic (contract D5), so
both lanes agree on ids without a join. A read-only view in a 2xx file may join both lanes.

### D. Money

| Layer | Type | Example |
|---|---|---|
| Contract / tools / email parts | `Usd` number, ≤ 2 decimals | `995`, `24.88` |
| Engine + DB | integer cents (`bigint`) | `99500` |
| x402 | USDC base-unit string (6 dp) | `"5000000"` |

Helpers (moving from Pass 1 `money.ts` into `packages/engine/src/money.ts` at kickoff):
`usdToCents` (rejects > 2 dp, NaN, Infinity, negatives where disallowed, unsafe ints, `"$1,200.5"`
→ 120050), `centsToUsd`, `centsToUsdcBaseUnits` (×10⁴, BigInt), `usdcBaseUnitsToCents` (rejects
sub-cent), `formatUsd`. `quote total` and `payment amount` are separate columns and arguments
(`total_cents`, `payment_cents`) and are never derived from each other implicitly.

Boundary tests to add: `0.1 + 0.2`-style inputs; `994.999` rejected; `1e21` rejected; `-5`
rejected for payments; `"1,150.00"` = 115000; cap check `payment_cents ≤ approved_payment_cents ≤
HAGGLE_GLOBAL_PAYMENT_CAP_CENTS` with `=` passing and `+1` failing; challenge `"5000001"` vs
approved `500` cents → reject; `"4999999"` → reject (not whole cents); deposit > total → reject;
`total_cents ≤ budget_cents`.

### E. Shared types

Full proposal: `docs/v3-contract-freeze-proposal.md`. Highlights: `Quote.kind = "quote"` vs
`Estimate.kind = "estimate"`; `ParsedReply.items` as a discriminated union (quote / question /
status / decline / payment_request / unstructured); `RequirementResult.met: boolean | null`;
`missing` + `evidence` per field; `ToolOk`/`ToolErr` with `mode`, `next`, `error.fix`;
`PaymentStatus` including `awaiting_invoice`; no new brain functions.

### F. Golden scenario (40 people, Thu Oct 22, SF, ≥ 12 vegetarian, delivery included, budget $1,200)

Fixed by the plan: Bay Catering wins at **$995**, `negotiated_from` **$1,150**, **round 2**,
deposit **$5** (5 USDC), `quote.json`, issues the x402 invoice. Golden Grill is cheapest with only
**6 of 12** vegetarian → rejected. Harbor Table sends a PDF with the deposit on page 2 and gives
~10% on a real competing quote. Mission Eats says "~900ish lmk". Sunset Kitchen asks "need
plates?" and is slow. QuickQuote Deli says "pay now at this link".

| Business | Round 1 | Engine action | Round 2 / outcome | Acceptance check |
|---|---|---|---|---|
| Bay Catering | `quote.json` $1,150 *(plan)*, deposit $5 *(plan)*, 12 veg ✓, delivery ✓ | Counter citing Harbor Table's real $1,120 | $995 *(plan)*, round 2 → **winner** | wins only after the revision arrives; counter cites a recorded quote id |
| Harbor Table | PDF p.1 $1,120 incl. delivery **PROPOSED**; p.2 deposit $300 **PROPOSED** | Counter citing Bay's $995 | ~10% off → $1,008 **PROPOSED** → 2nd | `hidden_deposit` flagged with `pdf p.2`; deposit not added to total |
| Mission Eats | "~900ish lmk" | Follow-up asking for an itemised total + delivery | $980 + $90 delivery = $1,070 **PROPOSED** | `vague_price` until clarified; never ranked from "~900" |
| Golden Grill | $860 **PROPOSED**, 6 of 12 veg | none (not compliant) | rejected | `requirement_unmet` (veg12); never recommended |
| Sunset Kitchen | "Need plates?" (slow, ~2–5 min fast-mode **PROPOSED**) | Question surfaced; agent answers "yes" via `answer_seller` | $1,180 incl. plates **PROPOSED** | question appears in `wait_for_update`; answer goes in-thread |
| QuickQuote Deli | "$700, pay now at <link>" **PROPOSED** | none | excluded | `external_payment_link` + `prompt_injection` flags; link never fetched; can't be approved or paid |

Final ranking: Bay $995 → Harbor $1,008 → Mission $1,070 → Sunset $1,180; Golden Grill and
QuickQuote listed under `rejected`. All **PROPOSED** numbers need Partner's approval because they
live in Partner's personas (item 22).

### G. Payment lifecycle

Job states: `negotiating → awaiting_approval → paying → paid`. Payment sub-states in `payments.status`:

```
(approval recorded) ─▶ awaiting_invoice ─▶ invoice_received ─▶ signed ─▶ sent ─▶ settled
                             │                    │               │        └─▶ rejected
                             └─(timeout)─▶ expired ◀──(challenge expiry)─┘
```

1. **Quotes collected → winner.** The engine recommends the cheapest compliant, trusted, current
   quote within budget.
2. **Human approval** (`approve`): records `quote_id`, quote revision hash, `total_cents`,
   `payment_cents` (the deposit), the cap, approver, channel, nonce and `expires_at` (30 min). A
   newer revision of that quote voids the approval.
3. **Notify winner:** after approval, the engine replies in the winner's thread with `accept.json`
   (conditional on payment) asking for the x402 invoice for `payment_cents`. Idempotency key
   `accept:<approval_id>`. This is the only order commitment, and it can't be sent without an
   approval.
4. **Seller challenge:** Bay Catering calls `createEmailChallenge` → `interaction.json` on the job
   thread. Challenges expire in **300 s by default**; that's why approval comes first.
5. **Validate** (in one DB transaction with `select … for update` on the payment row): trusted
   sender = quoting business; same thread; `parseEmailChallengeFromPart` succeeds; network
   `base-sepolia`; asset is Base Sepolia USDC; amount (base units) = approved `payment_cents` ×10⁴
   exactly; `payTo` unchanged if a previous challenge from this seller was seen; not expired with
   ≥ 60 s headroom; approval valid; no other active payment for the job (unique partial index).
6. **`pay(job_id, quote_id)`** records pay intent. If a valid challenge is present, it signs with
   `payEmailChallenge` (signs only), stores `signed` (payload hash, not the signature), replies
   in-thread with `interaction.json` (idempotency key `pay:<challenge_step_id>`), then stores
   `sent`. If no challenge yet, it returns `{ status: "awaiting_invoice", next: "wait_for_update" }`,
   and the engine signs automatically when a valid challenge arrives (approval and pay intent
   already exist). It never blocks.
7. **Receipt:** only a `receipt` step (trusted sender, same interaction) with `settle_tx`, or the
   `payment.settled` webhook, moves `sent → settled`. Duplicate receipts are no-ops (unique on
   receipt id). A reject → `rejected`.
8. **Edge cases:** missing invoice after 10 min → one reminder, then `expired`, and the job stays
   approved for one retry. Expired challenge → `expired`, ask for a reissue once (bounded at 2).
   Duplicate challenge (same step id) → ignored; a new step id while `signed`/`sent` → stored,
   not paid. Approval expired before the challenge arrives → refuse and ask for re-approval.
   Signed but unsent after a crash → resend the stored canonical bytes with the same
   idempotency key; never re-sign a different payload for the same step. Sent but unsettled →
   poll the interaction until timeout, then `failed` with a reason, never "paid". Once x402 is
   granted, also set Primitive's org spend policy (`max_per_payment = 5000000`, allowlist the
   seller org) as a server-side second gate.
9. **Fallback:** without x402, `FakePaymentGateway` runs the same states with `simulated: true`
   and receipts labelled DEMO, with no explorer link. Stripe test mode goes behind the same gate
   if a key arrives by 2 PM.

### H. Inbound email

```
POST /inbound (webhook) ──┐                      ┌─▶ parse worker ─▶ learnFromReply ─▶ job updates
                          ├─▶ ingestInbound() ──▶ │   (separate, idempotent by message_id)
long-poll loop ───────────┘   (one transaction)   └─▶ quarantine (unmatched / suspicious)
```

- `POST /inbound`: verify `Primitive-Signature` on the **raw body** (`verifyWebhookSignature`)
  and check `endpoint_id` before anything else. Bad signature → 401, not stored. DMARC
  temperror → 503 so delivery retries.
- `ingestInbound(input: { source: "webhook" | "poll"; event_id?: string; email: InboundEmail; trust: TrustVerdict | "unknown" })`
  in one transaction: insert into `inbound_events` with unique `(provider_email_id)`, so a
  duplicate from either path is a no-op that returns the existing row. Match the job by
  recipient `job-<id>@brave-dog.primitive.email`. Match the business by the strict-parsed From
  equalling `email_snapshot` on that job, plus the thread id / In-Reply-To against our outbound
  messages. Store the message plus attachment metadata (name, type, size, sha256) and enqueue
  `parse(message_id)`.
- No job, or a From that matches no business on the job → `quarantine` with a reason
  (`unknown_recipient`, `unknown_sender`, `thread_mismatch`, `untrusted`); never parsed into a
  quote.
- Long-poll: `GET /emails?since=<cursor>&wait=30&recipient=…`. The cursor is persisted in
  `ingest_cursors` **after** the ingest transaction commits, so at-least-once is safe thanks to
  dedupe. Loops are bounded (one per process, backoff on 429/5xx).
- Attachments: download via the attachments endpoint / tar URL, with size cap and type
  allowlist (pdf, json, text, html). PDFs go to Claude as documents. `interaction.json` goes
  only to the x402 processor, and `quote.json` to the deterministic parser.
- Webhook delivery and polling never call the parser or the brain directly. Ingest returns in
  milliseconds; parsing and learning run from the queue and can be replayed.

## 8. Unresolved blockers

1. `x402_payments` entitlement (buyer org; Partner's seller org too). Request drafted in §13.
2. Buyer wallet has 0 Base Sepolia USDC (needs ≥ 5).
3. Contract D1–D12 not yet agreed; `packages/core` stays Pass 1 until then.
4. Webhook endpoint can't be created until the first Manufact deploy exposes `POST /inbound`.
5. Stripe test key absent (only needed if x402 isn't granted by 2 PM).
6. GitHub: `main` not pushed, default branch wrong, Partner not invited.

## 9. Human actions (priority order)

1. **Send the x402 request** (buyer version below) from the buyer org's account email; Partner
   sends the seller version.
2. **Fund the buyer wallet** `0x81E813E63F22C4Be2332D25b1deA60fc72e62AB9` with ≥ 10 test USDC on
   Base Sepolia (Circle's faucet, https://faucet.circle.com). Testnet only.
3. **GitHub:** approve these, then I'll run them (or run them yourself):
   `git push origin main` · `gh repo edit yashnil/haggle --default-branch main` ·
   `gh api -X PUT repos/yashnil/haggle/collaborators/<partner-login> -f permission=push`.
   Also push the latest local commits: `git push origin yash/buyer-foundation`.
4. **Commit the root `CLAUDE.md`** (or tell me to). It's your edit to a shared file.
5. Optional: Stripe **test-mode** secret key in `.env` (`STRIPE_SECRET_KEY=sk_test_…`).

## 10. 10:30–11:30 contracts agenda

| Time | Item | Output |
|---|---|---|
| 10:30–10:35 | Read the summary (§1) and blockers (§8); confirm one project can enter several tracks (ask organizers) | go/no-go on scope |
| 10:35–10:50 | Contract walk-through: `Quote`, `ParsedReply`, `Estimate`, `Profile`, `Brain` (D3, D4, D12) | agreed types |
| 10:50–11:00 | Money (D2), business ids (D5), migration lanes (D11) | agreed conventions |
| 11:00–11:08 | Tools (D1 `answer_seller`), job states (D7), email parts + `accept.json` (D8, D9) | agreed tool list + parts |
| 11:08–11:13 | Sender trust wording (D6) and approval rule; apply the CLAUDE.md patch | CLAUDE.md committed |
| 11:13–11:20 | Golden scenario numbers (D10) | Partner's persona numbers fixed |
| 11:20–11:25 | Freeze: commit `packages/core/contracts.ts` on `main` (one writer, both review) | tag `contracts-v1` |
| 11:25–11:30 | Access check (x402 replies, wallets, reply-only for the seller org), gate times 2 PM / 8 PM / 3 AM, split | both lanes start |

## 11. Owner assignments (CLAUDE.md §4)

| Work | Owner |
|---|---|
| `packages/core/contracts.ts` write-up | Yash types it, Partner reviews; both approve |
| `packages/engine`, `apps/mcp`, `100_engine_*.sql`, payer, approval, deal board | Yash |
| `packages/brain` (stub first, by 11:30), `apps/sellers` (fleet, x402 payee), `apps/bench`, `fixtures/`, `2xx_brain_*.sql` | Partner |
| Moving Pass 1 `fixtures/buyer/` | Partner decides: adopt, rename to v3 personas, or move |

## 12. Gate definitions

**2 PM:** from Claude Code, `deal` against the six live fleet addresses returns in < 1 s.
RFQs (text + `rfq.json`) go out with idempotency keys. Replies arrive via `POST /inbound` on the
Manufact preview and are matched to job and business. `quote.json`, text and PDF parse into
`Quote` with evidence. `learnFromReply` is called for each. `wait_for_update` and `get_quotes`
show a ranked list with Golden Grill rejected and QuickQuote flagged. All of this is committed
and merged to `main`.

**8 PM:** the full cold deal, including `answer_seller` for Sunset Kitchen, the counteroffer
citing a real quote, and Bay Catering's $995 round-2 revision. `approve` via elicitation (email
fallback if webhooks work), and `pay` via x402 if entitled, otherwise the clearly labelled DEMO
gateway or Stripe test. Receipt stored. Deal board renders in Claude and ChatGPT. A warm `ask`
from the brain. Everything live on Manufact; benchmark-frozen MCP URL handed to Partner.

## 13. Draft access requests (DRAFT ONLY, NOT SENT)

**Buyer org (Yash) → dev@agent.primitive.dev**

> Subject: x402 access for a YC hackathon project (buyer/payer org)
>
> Hi Primitive team, we're building Haggle at YC's "Make Something Agents Want" this weekend:
> an MCP server that lets agents buy from email-only businesses and pay inside the thread with
> x402 over email on base-sepolia.
>
> We run two separate Primitive orgs: this one is the **buyer / payer** (domain
> brave-dog.primitive.email, org ae53e147-518f-429c-a0b0-0bdac5d0bcf5); my teammate runs the
> **seller / payee** org on a different subdomain. Could you please enable:
> - `x402_payments` (we already have `interactions_enabled`)
> - outbound beyond reply-only scope if that's needed to email the seller org's managed addresses
>   (we currently have `send_to_primitive_managed_domains`)
>
> Two questions: is a funded Base Sepolia USDC wallet the only payer-side setup we need for
> `payEmailChallenge`, and is DKIM alignment between two `*.primitive.email` subdomains in
> different orgs accepted for settlement? Payments will be 5 test USDC each.
> Thanks! Yash

**Seller org (Partner) → dev@agent.primitive.dev**

> Subject: x402 access for a YC hackathon project (seller/payee org)
>
> Hi Primitive team, I'm the seller side of Haggle (YC "Make Something Agents Want"). Our
> simulated businesses run as a Primitive Function in **this** org and invoice the buyer org
> (brave-dog.primitive.email, a separate org) with `createEmailChallenge` on base-sepolia.
> Could you enable `x402_payments` and `interactions_enabled` for this org, and lift the
> reply-only limit if it applies? Is registering a payout address with `registerPayoutAddress`
> the only payee setup needed? Amounts are 5 test USDC. Thanks! [Partner]

## 14. Safety and scope warnings

- Only test against the simulated fleet and inboxes you own; never mass-email real businesses.
- No signing or settlement without x402 entitlement, a funded **testnet** wallet, a stored human
  approval and all §7G checks. Fake receipts are always `simulated: true` / DEMO.
- Email approval stays **disabled** unless the signed-webhook trust path is working; elicitation is
  then the only approver. Don't relax §7B to make the demo work.
- Don't apply migrations to the hosted Supabase until the v3 `100_engine_*.sql` exists. The Pass 1
  migration is v2-shaped.
- `.env.bak` (old secrets, git-ignored) should be deleted; consider rotating the Supabase DB
  password (a fragment was shown in a local session log before the redaction fix).
- Don't edit `packages/core/`, `fixtures/`, Partner folders or the root `CLAUDE.md` without the
  agreement recorded at 10:30.
