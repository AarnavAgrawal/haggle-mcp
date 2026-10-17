# Haggle contracts

The only surfaces shared between the buyer side (Yash) and the seller side (Partner) are
**the email thread** and **the Supabase schema**. This file records both.

| Section | Owner | Status |
|---|---|---|
| 1. Database schema | Buyer (Yash) | **Authoritative** — `supabase/migrations/` |
| 2. Core TypeScript types | Buyer (Yash) | **Authoritative** — `packages/core/src/` |
| 3. Job states | Buyer (Yash) | **Authoritative** |
| 4. Haggle Quote Protocol v0 | Seller (Partner) | **PROPOSED by buyer — awaiting Partner sign-off** |
| 5. Payment (x402 over email) | Shared | **PROPOSED — awaiting Partner sign-off** |
| 6. Environment variables | Each side for its own app | Buyer section authoritative |

Changes to an authoritative section must stay backward compatible unless both sides agree.
Partner requests changes to `packages/core` / `supabase/` instead of editing them.

---

## 1. Database schema (buyer-owned)

Migration: `supabase/migrations/20261016000000_buyer_core.sql`. Verified by
`scripts/verify-migrations.sh` (applies to a fresh Postgres 17 and runs
`supabase/tests/buyer_core_assertions.sql`).

- Money: `bigint` cents. USDC: `numeric(78,0)` base units (6 decimals; `5000000` = 5 USDC).
- RLS is enabled and forced on every table with **no policies**: `anon`/`authenticated` get
  nothing. Only `service_role` (server-side) reads or writes. The seller side must not write
  buyer tables.
- Tables: `jobs`, `sellers`, `seller_conversations`, `webhook_events`, `email_messages`,
  `quotes`, `seller_questions`, `negotiation_rounds`, `approval_requests`, `approval_records`,
  `payment_challenges`, `payment_attempts`, `payment_receipts`, `audit_events`.
- Safety constraints enforced in the database (not only in code):
  - webhook dedupe on `(provider, provider_event_id)`; email dedupe on `provider_message_id`
  - at most one `current` quote per (job, seller)
  - counteroffers must reference a real `basis_quote_id`
  - one pending approval per job; approved max ≤ quoted total
  - payment attempts: `network = 'base-sepolia'` only; one attempt per challenge; one
    active-or-settled payment per job; one non-failed payment per approval
  - `audit_events` is append-only with a gap-free per-job `seq` (`haggle_append_event`)

**Seller-side tables** (personas, menus, floor prices) are Partner's and are not defined here.
If the market wall needs read access to buyer data, we will add a narrow read-only **view**
with an explicit policy — ask, don't query base tables.

## 2. Core TypeScript types (buyer-owned)

`@haggle/core` (`packages/core/src/index.ts`): Zod schemas + inferred types for `Job`,
`Requirement`, `SellerContact`, `SellerConversation`, `EmailMessage`, `EmailAuth`, `Quote`
(every field carries `stated | derived | missing | ambiguous` + provenance), `SellerQuestion`,
`NegotiationRound`, `ApprovalRequest`, `ApprovalRecord`, `PaymentChallenge`, `PaymentAttempt`,
`PaymentReceipt`, `AuditEvent`.

## 3. Job states

```
created → dispatching → collecting_quotes ⇄ clarifying ⇄ negotiating → comparing
  → awaiting_approval → approved → payment_pending → settled
side exits: rejected, payment_failed, cancelled, expired, failed
```
Full table: `packages/core/src/domain/state-machine.ts`. Notable rules: `payment_pending` is
reachable only from `approved` (or retry from `payment_failed`); an in-flight payment cannot be
cancelled; a quote revision during `awaiting_approval`/`approved` returns to `comparing`.

Per-seller pipeline: `pending → contacted → replied → clarifying → negotiating → quoted → won/lost`,
plus `declined`, `unresponsive`, `withdrawn`, `blocked` (unsafe; never paid).

---

## 4. Haggle Quote Protocol v0 — PROPOSED (Partner owns; not frozen)

Schemas: `packages/core/src/protocol/quote-protocol.ts`. Every message is a readable email;
agents additionally attach a JSON part (`application/json` attachment).

| Part | Direction | Required keys |
|---|---|---|
| `rfq.json` | buyer → seller | `protocol:"haggle.v0"`, `type:"rfq"`, `job_id`, `what`, `requirements[{id,label,mandatory}]`, `reply_by`; optional `quantity{amount,unit}`, `date`, `location`, `budget_hint_usd` |
| `quote.json` | seller → buyer | `protocol`, `type:"quote"`, `job_id`, `total_usd`; optional `items[{description,quantity,unit_price_usd,total_usd,tags[]}]`, `subtotal_usd`, `delivery_usd`, `delivery_included`, `tax_usd`, `tax_included`, `fees[{label,amount_usd}]`, `per_head_usd`, `deposit_usd`, `payment_terms`, `fulfillment_date`, `meets{req_id:bool}`, `valid_until`, `round`, `revision` |
| `counter.json` | buyer → seller | `protocol`, `type:"counter"`, `job_id`, `round`, `target_total_usd`, `basis` (cites a real competing quote), `respond_by` |

Wire amounts are decimal USD with ≤ 2 decimals. Unknown keys are tolerated; known keys are
type-checked. A malformed part is not trusted at all — Haggle falls back to text extraction
and flags the quote. **Seller claims (`meets`) are re-checked** against `items[].tags`.

Open questions for Partner: see `docs/integration-handoff.md`.

## 5. Payment: x402 over email — PROPOSED

Uses Primitive's own `interaction.json` (`protocol:"x402.payment"`), not a Haggle format.
1. Seller (payee org) calls `x402.createEmailChallenge({ from: <seller address that quoted>, to: <job inbox>, amountUsdc: "5", network: "base-sepolia" })` **as a reply on the job thread**.
2. Buyer holds the challenge until a human approval exists for that exact quote.
3. Buyer gates: approval for (job, seller, quote revision); amount ≤ approved max ≤ job cap;
   challenge `from` = quoting seller address, sender authenticated; network `base-sepolia`;
   unexpired; not previously consumed.
4. Buyer: `parseEmailChallengeFromPart` → `x402.payEmailChallenge(challenge, { signer })` →
   reply in-thread from the job inbox with the signed `interaction.json` attachment.
5. Primitive settles and replies with a `receipt` step carrying `settle_tx`.

## 6. Environment variables (buyer app)

See `.env.example`. Never commit `.env`.
