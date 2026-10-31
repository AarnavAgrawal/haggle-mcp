# Haggle: state of things and what to fix next

Written 2026-10-31. Line numbers are from commit `1506744` plus the uncommitted vendor-category change described in §2. They drift, so search for the quoted code if a number doesn't match.

**Contents**
1. State of things
2. Done in code, not deployed: vendors by kind of work, and the information floor
3. Haggle finds the businesses itself
4. You can change your settings
5. The spending limit belongs to the deal
6. Emails businesses will answer (length, sender, wording, footer)
7. Stripe: what exists and what production needs
8. A new color scheme
9. Suggested order

---

## 1. State of things

### What is live

| Piece | Where | Version |
| --- | --- | --- |
| Web app | https://tryhaggle.tech (Vercel `haggle-prod`, region `cle1`) | `25ce3ec`: the full redesign |
| MCP server | https://wild-forge-smbdu.run.mcp-use.com/mcp (Manufact `haggle-prod`) | `1506744`: database hang fix |
| Database | Supabase `rroubbymqdeiapnogdtg` (us-east-2) | 30 migrations applied |
| Branch | `aarnav-prod` on origin | `1506744` |

**Production settings:**
- live mode;
- **manual payment** (no money moves through Haggle);
- email on, calls on (consenting businesses only), iMessage on;
- SMS off (10DLC isn't verified);
- Amazon Location discovery on;
- one Inkbox mailbox per workspace.

### Done today

- **Web redesign (all pages):**
  - new tokens and type;
  - shared UI primitives;
  - a persistent left rail;
  - loading skeletons and transitions everywhere;
  - quicker session checks.
- **Chat:**
  - deal cards;
  - a composer that grows as you type;
  - streaming that survives a refresh.
- **Deal board:**
  - a quote sheet;
  - a docked approval bar;
  - a plain activity feed.
- **Vendors, settings, account:** rebuilt.
- **Outage fixed:** the MCP server's 4 database connections hung for hours, and every page said "couldn't load… answered 500".
  - Restarted the server first.
  - Shipped a guard: a database call that holds a connection for more than 30 seconds now fails as retryable, and the server replaces its connections. Each reset is logged as `db_pool_reset`, and `hung` is counted in `/ready`.

### Known loose ends

- **Stuck job:** `job_25a323a8451d46789617` has been in `paying` since this morning (`/ready` shows `stuck_paying`). Finish or cancel it with `apps/mcp/scripts/job-ops.ts`.
- **Browser test coverage:** the demo-deal browser test (`apps/web/e2e/guest-deal.spec.ts`) now ends at the booking step, so the payment step after booking isn't covered.
- **Vitest picks up the Playwright specs:** in `apps/web`, vitest loads `e2e/*.spec.ts` and `tests/approval.e2e.test.ts`, which show as 3 "failed to load". Exclude them.
- **Local `apps/mcp/.env` points at the production database:**
  - Local MCP tests and `e2e/tier2.ts` only run with `HAGGLE_ENV=development` and a local `SUPABASE_DB_URL` override. Two `opsReadiness` tests fail locally because of it.
  - Point that file at a development database.
- **Unmerged agent worktrees:** 5 remain under `.claude/worktrees/`. Check whether their commits are already in `aarnav-prod`, then delete them.
- **UI polish:**
  - `.status-words` cuts long text off with "…";
  - the `Field` label splits mixed text;
  - must-haves on the deal board look clickable;
  - confirm that a deal started in chat appears in the rail;
  - cache `listTools` in the chat agent.

---

## 2. Done in code, not deployed: vendors by kind of work, and the information floor

### The bug: "despite having plumbing vendors, it said it couldn't find any"

**Cause:**
- `deal` only used a workspace's own vendors by default when the request was **catering**: `ownDefault = own.length > 0 && category === "catering"` in `apps/mcp/index.ts`.
- Vendors had no category at all, so the code assumed every vendor was a caterer.
- A plumbing request ("fix a leaking pipe", classified as `plumbing` in `apps/mcp/src/businesses.ts`) skipped your plumbers and stopped with "this workspace's vendors are listed as caterers… nothing was sent".

**Fix (uncommitted, all tests pass):**
- **Migration `127_engine_vendor_category.sql`:** `workspace_vendors.category`, nullable and additive.
- **How Haggle decides what a vendor does** (`vendorCategory` in `apps/mcp/src/businesses.ts`):
  - its stored category;
  - else what its name clearly says ("Bay Plumbing" counts as plumbing);
  - else, for vendors an operator added before categories existed, catering (the pilot's scope);
  - else **unknown**.
- **`deal` with no businesses named** uses the workspace's vendors whose kind serves the request:
  - plumbers for plumbing;
  - a general "repairs" business also takes plumbing and electrical jobs;
  - **unknown vendors are never contacted by default**.
- **Vendors are tagged automatically and editable:**
  - A vendor added from **Find businesses** is tagged with the search ("plumber" becomes plumbing).
  - The **Add a vendor** form has a "What they do" field.
  - Each row on the Vendors page shows what the vendor does, with an editor in the expanded row.
  - Wiring: `/api/vendors/category` calls the new service route `POST /internal/vendors/category`.
- **"None of your vendors do this" message:** when none of your vendors match, the deal says so and lists what your vendors do, e.g. "catering (3), not set (2)", so you can fix the right thing.

### Rule: never email a business about work it doesn't do

- **Default selection:** only the workspace's vendors whose kind serves the request (above).
- **Named vendors:** if the agent or the user names a vendor whose kind is known and unrelated (a caterer for a plumbing job), the deal stops with `vendor_unrelated`: "Casa Lunch is listed as catering, not plumbing. Nothing was sent." This applies even on a dry run.
  - If the business really does that work, change what it does on the Vendors page.
  - A business named with a brand-new contact (no category yet) is allowed, because the user named it explicitly.
- **Discovered businesses** carry the category they were found under, and the same check applies.

### Rule: never contact a business without adequate information

- **Before:** `deal` asked the user for each category's essentials (catering: headcount, date, where; a repair: what's wrong, where, when). But `proceed_anyway: true` skipped all of them.
- **Now:** `proceed_anyway` still skips timing and the optional details, but **never the floor**: what the job is, and where. `FLOOR_KEYS` in `packages/engine/src/intake/intake.ts` lists these:
  - `where`, for every category;
  - `problem`, for a repair;
  - `scope`, for a general request;
  - `spec`, for printing;
  - `route`, for moving;
  - `headcount`, for catering.

  Without them the deal returns `needs_info` with only those questions, and nothing is sent.

### To ship it

1. Apply migration 127 to production by hand, then record it with `migrations.ts record`.
   - The code also works before the migration: setting a category just won't stick.
2. Rebuild the MCP server (Manufact).
3. Redeploy the web app (Vercel).
4. On the Vendors page, check what each existing vendor is listed as, and fix any that say "isn't set".

### Tests added

- **`apps/mcp/tests/vendorCategory.test.ts`:**
  - name inference;
  - stored category wins;
  - the operator fallback;
  - unknown serves nothing;
  - the engine stores and clears categories.
- **`apps/mcp/tests/serviceVendors.e2e.test.ts`:**
  - a plumbing deal picks only the plumbers;
  - naming the caterer is refused;
  - setting and clearing a category over HTTP.
- **`apps/mcp/tests/mcp.e2e.test.ts` and `packages/engine/tests/intake.test.ts`:** `proceed_anyway` can't skip what or where.
- **`apps/web/tests/vendors.routes.test.ts` and `vendors.form.test.ts`:** the category route and the form field.

---

## 3. Haggle finds the businesses itself

### The problem

A workspace with no vendors for a request can't run a deal. You have to go to Vendors, search, add businesses one by one, and only then can Haggle contact them. The whole point is that Haggle finds the businesses.

### How it works today

- **Live workspace with no matching vendors:** `deal` stops with "NOT STARTED: none of this workspace's vendors do <category>" or "no vendors yet" (`apps/mcp/index.ts`, search for `NOT STARTED`). It points at the Vendors page.
- **`discover`** (`apps/mcp/index.ts`, `export const discover`) already finds real businesses, with published emails and opening hours (Amazon Location is on in production).
  - Every result comes back `contact_found`, meaning not authorized: `discoveredRoutes` in `apps/mcp/src/businesses.ts` asks `engine.canContact`, which is false until the business is a workspace vendor.
- **The permission already exists:** consent basis `public_listing_email` (`apps/mcp/src/service/vendors.ts`). It means the business published this email, so Haggle may email it but never call or text it. The Vendors page's one-click add from search uses it.

### Target flow

```
you: "Fix a leaking pipe under my kitchen sink, Oakland, this week"
 → intake checks what, where, when (the floor can't be skipped)
 → Haggle uses your plumbers, and if you have fewer than 3, finds more near Oakland with a published business email
 → the preview card lists them: name, where the email came from, today's hours, "will email"
 → you press "Start the deal" (or remove some first)
 → each found business is saved to your vendors as public-listing (email only), category plumbing, with who confirmed and when
 → the quote requests go out
```

The human's confirmation of the preview is the authorization. It's the same act as pressing "Add" on the Vendors page, done in one step.

### Steps

1. **Discovery inside `deal`:** when no businesses are named and fewer than 3 of the workspace's vendors serve the request's category, call `rt.listing.discover(category, area, DISCOVER_COUNT)` (the `discover` tool's path). Then:
   - keep results with a published business email;
   - drop suppressed contacts (`vendor_suppressions`) and existing vendors;
   - add the rest as kind `discovered`, with `send = { channel: "email" }`, marked as needing confirmation.
2. **Dry run shows them:** `deal(dry_run: true)` returns them in `preview` with `contact_state: "will_authorize_on_start"` and `found_via`. The chat preview card (`apps/web/lib/chat/cards.ts`, `components/chat/`) lists them, each with a remove control.
3. **Starting authorizes them:** a real `deal` with `confirm_discovered: [business_ref…]` (only refs from the dry run) saves each one through the existing vendor-add path with:
   - consent `public_listing_email`;
   - category = the request's category;
   - `added_by` = the confirming user (web) or `"agent:<client> on the user's yes"` (MCP clients);
   - the listing ref as evidence.

   Then it sends.
4. **Dead ends become a last resort:** remove the "add vendors first" dead ends, and keep them only when discovery is off or finds nothing; then say why (no area, nothing nearby, listings down).
5. **Area:** use the request's area, else the workspace's default area (§4), else intake asks.
6. **Vendors page** becomes **Saved businesses**: optional, for favorites and for businesses that agreed to calls or texts.
7. **Safety (CLAUDE.md §7):**
   - discovered businesses get **email only**;
   - at most 6 per deal;
   - the daily add limit (25 per workspace) applies;
   - opening hours gate follow-ups;
   - the §2 rules (related work only, the information floor) apply;
   - an opt-out line feeds `vendor_suppressions`.
8. **Words:** update `deal`'s description and the server instructions ("contacts the configured, authorized vendors", "Haggle already holds every configured vendor's contact details"), `CONTRACTS.md` and `apps/mcp/SKILL.md`.

### Tests

- **`apps/mcp/tests`:** with a listing fixture (`HAGGLE_PLACES_FIXTURE`):
  - a workspace with no vendors previews found businesses and sends nothing;
  - `confirm_discovered` saves them as `public_listing_email` + category and emails only them;
  - phone-only results are never called;
  - suppressed addresses never appear.
- **Web:** the preview card lists found businesses and can remove one.
- **e2e:** a guest with no vendors starts a plumbing deal.

---

## 4. You can change your settings

### Today

- Settings is read-only. `docs/web-app.md` says "Changing the approver or raising the cap is the operator's job" (`apps/mcp/scripts/workspace-admin.ts`).
- `engine.updateSettings(patch, workspaceId, by)` (`packages/engine/src/workflow/engine.ts`, search `updateSettings(`) refuses approver changes and cap raises when `by === "agent"`, so that a model can't approve its own purchases.
- The MCP service API (`apps/mcp/src/service/`) has no settings route.

### Fix: a third actor, the signed-in workspace owner

1. **Engine:** `by: "owner"` may change what the operator can, within the server ceiling (`HAGGLE_SPENDING_CAP_CEILING_CENTS`). Approver changes go through verification (step 4). Write an audit row per change: who, when, field, and old and new values (masked).
2. **MCP service:** `POST /internal/workspaces/settings` in `apps/mcp/src/service/workspaces.ts`.
   - Requires the service token, `x-haggle-workspace` and `x-haggle-actor`.
   - Body: `{ name?, default_area?, timezone?, approver_email?, approver_phone?, default_deal_limit_usd? }`.
3. **Web:**
   - **API route:** `app/api/settings/route.ts` checks `verifiedSessionUser()` (not the cached claims), that the user is an owner (`membership().role === "owner"`), and a rate limit. Guests can't change settings.
   - **Page:** the settings page (`app/(app)/settings/page.tsx`) gets an Edit button per group, turning rows into `Field`s with Save and Cancel, `useTransition` and `router.refresh()`.
4. **Approver changes are verified before they take effect:**
   - **New phone:** a 6-digit code by iMessage, typed back.
   - **New email:** a confirm link.
   - Until then the old approver stays, so a stolen session can't quietly redirect approvals.
5. **The native MCP settings panel** (`server.settings` in `apps/mcp/index.ts`) stays `by: "agent"`: it may lower limits and set the area, but never change the approver.
6. **Docs:** remove "Workspace settings are read-only in the app" from `docs/web-app.md`, and document the route in `CONTRACTS.md`.

### Tests

- **Engine:**
  - an owner can raise the cap up to the ceiling;
  - an agent can't;
  - an approver change waits for verification.
- **Service:** refuses non-owners, foreign workspaces and bad input.
- **Web:** form validation and pending state; guests refused.

---

## 5. The spending limit belongs to the deal

### Today

- **One workspace-wide cap:** `settings.spending_cap_cents`, $1,500 by default (`defaultSpendingCapCents ?? 150_000` in `engine.ts`).
- **On create:** the job's `payment_cap_cents` is `min(global, workspace cap)` (`engine.ts`, search `paymentCapCents =`).
- **Every check takes the minimum again:**
  - approvability: `Math.min(job.payment_cap_cents, globalPaymentCapCents, settings.spending_cap_cents)`;
  - the payment step (`spendCapCents:`);
  - approval creation (`const cap = Math.min(ceiling, settings.spending_cap_cents)`).

A $90 locksmith and a $4,000 event can't share one limit. The per-deal column already exists; it just isn't set from the deal.

### Target

- **Each deal has its own spending limit:** set when it starts from the budget the user gave. With no budget, it's left open and decided at approval.
- **The human sees and changes it:** on the preview card and on the deal board.
- **Pay requires all of:**
  - a stored human approval for that exact quote;
  - amount ≤ approved ≤ **the deal's limit** ≤ the server ceiling (an operator safety net, e.g. $10,000).
- **The model can never raise a deal's limit:**
  - `deal` only proposes it, from the stated budget;
  - raising it is a human action (web route with a verified session, or the approval card's "Raise this deal's limit to $X and approve");
  - lowering is always allowed.

### Steps

1. **Engine:**
   - **On create:** `payment_cap_cents = min(server ceiling, spend_limit_usd ?? budget_usd)`; `null` means decided at approval.
   - **The three checks above:** drop `settings.spending_cap_cents`.
   - Add `setDealLimit(jobId, cents, by)`, where the agent may only lower. Audit every change.
   - **Migration `128_engine_deal_limit.sql`:** `payment_cap_cents` nullable, plus `cap_set_by` and `cap_set_at`.
2. **Approval over the limit:** "This is $X over the limit you set for this deal. Raise it to $Y and approve?" One human action. Done in `ApprovalPanel.tsx` plus a service route `/internal/approvals/raise-limit`.
3. **Workspace cap becomes a default:** "Default limit for new deals" (optional), only used when a deal has no budget. It isn't checked at payment.
4. **Contracts (same change, CLAUDE.md §4 rule 1):**
   - `packages/core/views.ts` Approval: `cap` → `deal_limit`;
   - `CONTRACTS.md`: the payment gate;
   - **CLAUDE.md §7:** "amount ≤ approved ≤ the deal's limit ≤ the server ceiling";
   - `fixtures/views/*.json`;
   - every caller.
5. **UI:**
   - chat preview: "Spending limit $1,200 (from your budget)", editable;
   - board header: "Limit $1,200";
   - settings: shows the default.

### Tests

- **Engine payment gate:**
  - pay above the deal limit is refused;
  - pay above the old workspace cap but within the deal limit succeeds;
  - an agent can't raise the limit;
  - the human can raise it at approval;
  - the ceiling still refuses.
- **Plus:** update `packages/engine/tests/e2ePurchase.test.ts` and `apps/web/tests/approval.flow.test.ts`.

---

## 6. Emails businesses will answer

### 6.1 The first email is too long and asks for too much

**Today:**
- **Built in:** `packages/engine/src/outbound/rfq.ts` (`buildRfqEmail`, `quoteRequestSubject`), called from `engine.ts` (`rfqEmail()`) with `vendorAsks: vendorAsksFor(r)` from `intake/intake.ts`.
- **Size:** for a 40-person lunch it renders **29 lines, 187 words and 10 asks**: an itemized all-in total, menu, what's included (asked twice in different words), price per person, deposit and terms, availability, cancellation policy, how long the quote is valid, and how each must-have is met.
- **Other problems:**
  - the reply-by time is in UTC;
  - every email carries an `rfq.json` attachment, which looks like spam to a small business.

**Target: one short paragraph and two asks.**

```
Subject: Quote for lunch for 40 – Thu Nov 12

Hi Mission Eats,

Could you quote drop-off lunch for 40 on Thursday, Nov 12 at 12:00 PM, delivered to
123 Market St, San Francisco? We need 12 vegetarian meals.

If you can do it, please reply with your all-in price (including delivery, tax and fees)
and any deposit you need. A photo or PDF of your quote is fine.

Thanks,
Priya at Acme Labs
```

**Steps:**
1. **Rewrite `buildRfqEmail`:**
   - one sentence carrying what, when (local time), where, headcount and must-haves;
   - then **only** the all-in total and the deposit;
   - availability is implied by "If you can do it"; ask for it explicitly only for flexible date ranges;
   - a local reply-by day ("by Thursday"), or none.
2. **Move the other asks to follow-ups:** menu or what's included, price per person, cancellation policy. Ask them **only if the reply leaves them out and they matter**, using the existing missing-terms follow-up (`engine.ts`, search `Could you also tell us`).
   - Drop "how long the quote is good for" entirely.
   - Drop "how you meet each must-have"; must-haves are already confirmed at booking.
   - Consider taking catering's `cancellation` out of `critical` (`intake.ts`, the catering profile), so a complete quote doesn't trigger a second email.
3. **Drop `rfq.json` from email;** keep it for A2A only. Same for `counter.json` on counteroffers.
4. **Trim the chase emails** (`engine.ts`): no-reply reminder, firm-total chase, missing terms. Make each 2 to 3 lines.
5. **Update tests and fixtures that pin today's text:**
   - `packages/engine/tests/rfqAndRanking.test.ts`, `channels.test.ts`, `generalPurpose.test.ts`, `quoteIntegrity.test.ts`, `sameChannel.test.ts`, `evalCorpus.test.ts`, `realClientReplies.test.ts`, `sms.test.ts`, `callBrief.test.ts`;
   - about 13 fixtures in `packages/engine/tests/fixtures-email/*.json`.

### 6.2 The sender address has random characters

**Why:**
- `packages/engine/src/live/workspaceMailboxes.ts` builds each workspace's mailbox handle as `hg-<workspace slug>-<6 hex of a hash>`. Web workspace ids are `ws_u_<24 hex>`.
- So businesses see something like `hg-u-3f9a1c2b4d5e6f7a8b-abc123@inkboxmail.com`.
- The identity is created with no display name (`inkbox.createIdentity(handle)`), so the From name is the same string.

**Can mail go through the user's own Gmail with Inkbox? No.**
- Inkbox has no Gmail or Google Workspace connection (no OAuth or connected accounts in the SDK `@inkbox/sdk` 0.7.19 or the docs). Its IMAP/SMTP feature lets a mail client read an Inkbox inbox, not send as Gmail.
- Sending from Gmail would mean a separate Gmail API integration:
  - Google's send scopes are restricted (OAuth verification plus a yearly security assessment);
  - it would break CLAUDE.md §3 ("all channels through Inkbox") and the reply webhooks.
- **Not recommended now.**

**Stay on Inkbox and make the address look human (supported):**
1. **Custom sending domain:** register one in the Inkbox Console or REST API (`POST /api/v1/domains/`).
   - Use `tryhaggle.tech` if its apex has no MX records, otherwise a subdomain like `mail.tryhaggle.tech`.
   - Publish SPF, DKIM, DMARC and MX in Cloudflare (DNS-only, grey cloud).
   - About $4 a month per domain, on a paid plan (see 6.4).
2. **Readable addresses:** create identities with `sendingDomain`, `emailLocalPart` and `displayName` (`CreateIdentityOptions` in the SDK).
   - **Local part:** the company or person, e.g. `priya.acme@mail.tryhaggle.tech` or `acme-labs@…`, with a short suffix only on a collision. This only works on a custom domain; on `inkboxmail.com` the local part is forced to the handle.
   - **Display name:** "Priya at Acme Labs" (or the workspace name). Check with one test send to your own Gmail that it shows as the From name.
   - The internal handle can stay hashed.
3. **Re-provision workspaces:** handles and addresses can't be renamed after creation, so create new identities. Open deals keep their old `jobs.inbox` until they finish; the reconciler already sweeps every active mailbox.
4. **Code:** change `workspaceMailboxes.ts` (`inboxFor`, `inkboxAdminApi.createIdentity`) to pass the three options, taken from the workspace name (add a `sender_name` setting in §4).
5. **Deliverability:** a brand-new domain sending first-contact mail needs warming. Keep volume low for the first weeks, and watch bounces (`vendor_suppressions`).

### 6.3 Remove "AI assistant for a customer"

**Where it appears in email:**
- `rfq.ts`: "I'm an AI assistant reaching out on behalf of …" and the sign-off; update its header comment too, which says to keep it;
- `engine.ts`: `signOff()` (`Thank you!\nAI assistant for ${customer}`), used by every follow-up;
- the counteroffer sign-off;
- the A2A request, which reuses the email body.

`customer` defaults to "a customer" (`HAGGLE_CUSTOMER_NAME`).

**Change (email only):**
- Sign as the real customer: "Thanks,\nPriya at Acme Labs", or just the company.
- Take the name from the workspace or sign-in profile, with the user's consent at onboarding.
- Never invent a human name.
- If a business asks whether it's a person, answer truthfully; the reply drafting must keep that rule.

**Calls and texts keep the disclosure:**
- CLAUDE.md §7 requires the call's `reason` to say it's an AI assistant.
- California's bot-disclosure law (Bus. & Prof. Code §17940–17943) forbids using a bot to mislead someone about its artificial identity to sell goods or services.
- Dropping the "AI" label from a factual quote request is much lower risk than posing as a human, but it is a policy change. **Update CLAUDE.md §7 and CONTRACTS.md:** "email: no AI self-label, never a fake human, truthful if asked; calls: disclose".
- **Have counsel confirm before launch.**
- **Keep an opt-out line** in follow-ups ("Reply STOP and we won't email again"), for CAN-SPAM-style compliance.

### 6.4 Remove "Sent via Inkbox"

- **Our code never adds it; Inkbox does.** Outbound mail gets a "Sent via Inkbox" footer on the **Free plan** (Inkbox docs: capabilities/email). Our only mention is `inbound/emailBody.ts`, which strips it from replies.
- **To remove it:**
  1. Upgrade the production Inkbox org to **Developer** ($25/month: 10 identities, 10 custom domains, signatures) or **Startup** ($167/month: 100 identities) if workspaces will exceed 10.
  2. Set `remove_branding_footer: true`, either with `PUT https://inkbox.ai/api/v1/billing/settings` using the admin key, or on the Console's Email page. On Free it returns 403.
- **Identity limit:** Free allows only 3 identities. Today's per-workspace mailboxes fall back to the shared `haggle-buyer` mailbox after 3, so the upgrade also fixes that.
- **Two more emails to clean up:** booking and payment emails say "Haggle never takes or sends money" (`engine.ts`, the booking handoff). Reword them so the business sees the customer's name, not "Haggle".

**One account change, the paid plan plus a custom domain, fixes 6.2 and 6.4 together.**

---

## 7. Stripe: what exists and what production needs

### What exists

- **Code:** `packages/engine/src/payments/stripe.ts`, the REST API via fetch with no SDK.
  - `stripeTestPayments` makes an off-session PaymentIntent on **one operator-owned test customer and saved card** (`STRIPE_CUSTOMER_ID`, `STRIPE_PAYMENT_METHOD_ID`).
  - It uses an idempotency key per approval, and retries on 429, 5xx and 409.
  - `verifyCharge` reads the charge back (amount, currency, customer, metadata, `livemode: false`) and keeps the `receipt_url`.
  - Also: `simulatedStripe` for mock mode, and a setup check (`packages/engine/scripts/stripe-setup.ts`).
- **Guards:**
  - `payments/guard.ts` and `payments/purchase.ts`;
  - `processStripePayment` in `engine.ts`;
  - a stored human approval for the exact quote and amount within the caps.
- **Live keys are refused in three places:** `stripe.ts`, `apps/mcp/src/config.ts`, and the `livemode` check.
- **Env:** `HAGGLE_PAYMENTS` (manual, stripe or disabled), `HAGGLE_ENABLE_PAYMENTS`, `HAGGLE_GLOBAL_PAYMENT_CAP_CENTS`, `STRIPE_SECRET_KEY` (`sk_test_` only), `STRIPE_CUSTOMER_ID`, `STRIPE_PAYMENT_METHOD_ID`.
- **Production runs `manual`:**
  - no money moves through Haggle;
  - the business is asked how it takes payment;
  - the human pays it directly and confirms with `PAID <code>`.
  - Stripe is not used in production.
- **`apps/web` has no Stripe code.** CONTRACTS.md §6 still describes "Stripe test mode charges the deposit".

### What's missing for real money

1. **Nothing pays the business.** Test-mode charges land in Haggle's own Stripe account. Choose a model first:
   - **Stripe Connect** (Express accounts, destination charges, `application_fee_amount`): each business onboards with Stripe (KYC). It's a poor fit for small businesses contacted cold, but it's the clean way to move money to them.
   - **Stripe Issuing** (single-use virtual cards): Haggle creates a card for the approved amount and the human or business uses it. Needs Stripe approval.
   - **Keep manual payment** (today), and use Stripe only for Haggle's own fee or subscription. **The simplest launch path.**
2. **No card per user.** Today it's one global test customer. Production needs:
   - a Stripe customer per workspace;
   - card collection with Checkout or a SetupIntent and Elements (PCI SAQ-A: the card never touches our servers);
   - 3-D Secure handling, since `requires_action` is currently a hard failure with no recovery.
3. **Live keys:** a separate, explicit live-key path (`sk_live_`, restricted keys), kept apart from test.
4. **Webhooks:** none today. Add `POST /webhooks/stripe` with signature checks (`whsec_`) for:
   - `payment_intent.succeeded` and `payment_intent.payment_failed`;
   - `charge.refunded`;
   - `charge.dispute.*`.

   Payment status shouldn't depend only on the synchronous read-back.
5. **Refunds and disputes:** there are no refund calls, and the docs say Haggle "can't refund". Add refund (full or partial) as a human-approved action, plus dispute handling and evidence.
6. **Receipts:** email the user a receipt and set a clear statement descriptor. Only the `receipt_url` is stored today.
7. **Business and legal:**
   - activate the Stripe account (KYC);
   - terms of service and a refund policy (still drafts in `docs/production-deploy.md` §11);
   - money-transmission exposure if Haggle ever holds funds (Connect avoids it);
   - tax and 1099-K reporting under Connect.
8. **Docs:** update CONTRACTS.md §6 and the env docs for the chosen model.

**Recommendation:**
- Launch with `HAGGLE_PAYMENTS=manual`, as today.
- Decide Connect vs Issuing vs fee-only before writing Stripe code.
- If Stripe is used, the minimum is:
  - a customer per workspace with Checkout or SetupIntent card collection;
  - live keys;
  - a signed webhook;
  - refunds;
  - reviewed terms.

---

## 8. A new color scheme

### What's wrong

The palette is navy ink (`#15203A`) and a royal-blue accent (`#2346D8`) on cool grey (`#EEF0F3`), with a near-black navy dark mode (`#0C1220`). Blue on grey with black-navy for dark is the default look of AI-generated SaaS pages, and nothing in it comes from what Haggle does.

### Where the new direction comes from

Haggle's world is quotes, line items and totals, with prices crossed out and written lower: the material of a **ledger book**.
- pale green paper ruled into columns;
- totals in dark ink;
- corrections in red ink;
- the best number marked with a highlighter.

Every color then has a reason, and the result isn't cream with terracotta, navy with blue, or neon on black. The pen-mark idea in `apps/web/DESIGN.md` stays and gets sharper:
- **red ink** strikes the superseded price;
- **green ink** circles the recommendation;
- **yellow highlighter** marks the savings.

### Recommended palette: "Ledger"

Light (default):

| Token (keep the names) | New | Role |
| --- | --- | --- |
| `--desk` | `#ECF1E8` | Page: pale ledger green |
| `--sheet` | `#FBFCF9` | Cards and sheets: near-white paper |
| `--ink` | `#1A2920` | Text: green-black ink |
| `--ink-2` | `#46564B` | Secondary text |
| `--ink-3` | `#5A695F` | Hints (check ≥ 4.5:1 on `--desk`) |
| `--rule` / `--rule-strong` | `#CFDCC9` / `#A8BCA2` | Ledger rules |
| `--pen` / `--pen-strong` | `#17603D` / `#0F4A2E` | Actions, links, focus ring, the recommendation circle |
| `--pen-wash` | `#DCEBDD` | Selected row, hover |
| `--red-ink` (new) | `#C0271E` | The strike through an old price, savings deltas |
| `--highlight` | `#EEF03A` | Highlighter on the best saving |
| `--signed` | `#2C7A3F` | Done (always with a check and words) |
| `--hold` | `#8A5A00` | Waiting on you |
| `--risk` | `#B3261E` | Problems (red always means "look here") |

Dark: "Ledger at night". Bottle green, not navy and not black:

| Token | New |
| --- | --- |
| `--desk` / `--sheet` | `#14211A` / `#1B2B22` |
| `--ink` / `--ink-2` / `--ink-3` | `#E4ECE3` / `#AEBDB1` / `#8A9A8E` |
| `--rule` / `--rule-strong` | `#2A3D31` / `#3A5243` |
| `--pen` / `--pen-strong` / `--pen-wash` | `#8FD6A8` / `#B4E6C5` / `#213A2B` |
| `--red-ink` / `--risk` | `#FF8A7A` |
| `--highlight` | `#D9E23A` |
| `--hold` | `#F0B54A` |

### Principles

- **Spend the boldness in one place:** the pen marks on the quote sheet (landing hero, deal board). Everything else stays quiet: paper, ink, rules.
- **Color carries meaning, never decoration:**
  - green = act or recommended;
  - red = superseded or a problem;
  - yellow = money saved;
  - amber = waiting on you.

  No gradients, tinted shadows or colored status borders.
- **Ledger rules only where they're information:** the quote rows are line items, so they get faint rules and right-aligned totals in tabular figures. No ruled backgrounds elsewhere.
- **Buttons:**
  - primary: solid ledger green with paper-white text, 4px radius;
  - secondary: ink outlines;
  - no pills, and no blue anywhere.
- **Keep the type:** Bricolage Grotesque (display and prices) and Schibsted Grotesk (UI). Re-check the landing headline in green-black; it may want one weight lighter.

### Alternative if Ledger feels too green: "Counter"

The hardware-store trade counter:
- concrete grey paper `#E9EAE6`;
- warm black ink `#24221E`;
- safety-orange actions `#D9480F`;
- kraft-tag price labels `#C8A26B`.

Watch out: orange that drifts toward terracotta reads as an AI tell, so keep it yellow-red, saturated, and only on actions.

### How to apply it

1. **Swap the token values:** every color is a token in `apps/web/app/globals.css` (light block near the top, dark block under `prefers-color-scheme: dark`). No other web CSS file hard-codes a color (checked), so it's a contained change.
2. **Add `--red-ink`:** point the strike mark (`Struck` in `components/ui/`) and the landing's animated strike at it. The circle stays on `--pen`, and the highlighter on `--highlight`.
3. **Update `apps/web/DESIGN.md`:** the tokens table and this reasoning.
4. **Add a contrast test** (`apps/web/tests/tokens.contrast.test.ts`): parse the tokens and assert AA for text on `--desk` and `--sheet`, and for button text on `--pen`, in light and dark.
5. **Screenshot every page** at 1366 and 390 px, light and dark: landing, sign-in, chat, deals, deal board (quotes, approval, paid), vendors, settings, account. Look for leftover blue, and for red that reads as an error where it means "old price".
6. **The MCP views** (`apps/mcp/views/**`, inside ChatGPT and Claude): give them the same tokens.

---

## 9. Suggested order

1. **Ship §2:** done in code.
   - Apply migration 127, then one Manufact build and one Vercel deploy.
   - Fixes the plumbing bug and adds the two safety rules.
2. **Inkbox account (§6.2, §6.4):** no code.
   - Upgrade the plan;
   - remove the footer;
   - register the sending domain.
3. **Shorter emails and the sign-off (§6.1, §6.3):** engine only, with the tests and fixtures updated. Needs the policy decision on the AI label for email.
4. **Colors (§8):** web only, contained.
5. **Readable sender addresses (§6.2 code):** after the domain is verified.
6. **Settings (§4):** needed for the default area, sender name and approver changes.
7. **Deal limits (§5):** touches the payment gate and contracts; tests first.
8. **Discovery in deals (§3):** the biggest change; builds on §2 categories and §4 area.
9. **Stripe (§7):** only after choosing the payment model; manual payment until then.

**Deploys:**
- §3 and §5 change the MCP server (a Manufact build) and add migrations.
- Apply migrations by hand and record them: `prod.mjs migrate` skips files on an existing schema.
- Then redeploy the web app.
- Every push and deploy needs the go-ahead.
