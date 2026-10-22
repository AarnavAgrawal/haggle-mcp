# Aarnav handoff (sprint 5)

What the engine side (`yashnil`, draft PR #1) now needs from the brain, the views and the shared contracts. Nothing here was edited in your folders or in `packages/core`; each item is a request or a proposal. Earlier detail: `docs/sprint-4-report.md` §9; security context: `docs/security-review-s5.md` (H5, F15).

## 1. Brain tenant isolation (blocks a multi-customer pilot)
Today `brain_profiles` is one profile per business shared by every workspace. `ask`, `check_price`, the board's price check, negotiation hints and `business_profile` therefore mix customers' data.
- **Engine-side mitigation already in place:** `business_profile` now shows only menu items and areas backed by this workspace's history rows (`apps/mcp/src/brain.ts` `historyOnly` exact mode, F15), and the brain is taught only from trusted, non-heuristic replies (below). Neither fixes `ask` / `check_price` / hints.
- **Proposal (needs both of us, `contracts.ts`):** add `workspaceId: string` as the first argument of `learnFromReply`, `estimate`, `checkPrice`, `negotiationHints` and `getProfile`. The engine already knows the workspace on every call and will pass it.
- **Storage, your choice:** (a) `brain_profiles` keyed `(workspace_id, business_id)` in a 2xx migration, or (b) per-workspace profiles plus a numbers-only cross-workspace aggregate used only when at least 3 workspaces contribute. (a) is simpler and enough for the pilot.
- **Done when:** a test with two workspaces shows `ask` / `check_price` / `getProfile` for workspace B returning nothing learned from workspace A. `pilot-preflight` then stops warning about tenancy (change `apps/mcp/scripts/pilot-preflight.ts` brain-tenancy check from WARN to a real check; I'll do that side).

## 2. Simulated-data exclusion
- The engine calls `learnFromReply` only when the sender is trusted, the reading came from Claude (not the keyword fallback), and the reply isn't simulated on a live job (`engine.ts`, "teaches").
- **Gap on your side:** on a **mock** job, simulated replies still teach the brain. If mock and live share one Supabase (the demo server does), demo-fleet prices end up in profiles a real customer sees. Please either skip `meta`/replies from simulated businesses (`Business.simulated`, `*.sim.haggle.dev`, fleet ids) or store them under a separate mode. The rule the metrics use (`packages/engine/src/ops/metrics.ts` `classifyJob`) is the reference for "real": live mode, workspace and job not test-marked, at least one non-simulated vendor.
- Please also honour `ReplyMeta.extraction` once it exists (§4) so a heuristic reading never updates a price model.

## 3. Views (approval card, deal board)
The engine already returns all of these in `structuredContent`; the views don't render them yet, so humans only see them through the agent's text.
- **Stages** (approval card): `awaiting_vendor_confirmation` ("waiting for the vendor's written confirmation"; for phone/A2A vendors and thread-only confirmations: "confirm with the vendor directly, then reply BOOKED <code>"), `order_confirmed`, `handoff_refused`, `human_reported_paid` ("customer reports paying, not verified"), `settled_verified`. Show `purchase.booked_by_human` when the booking was attested by the approver.
- **Purchase details:** `purchase.order`, `purchase.must_haves`, `purchase.confirm_only`.
- **Comparison:** per-quote `selection.reason` (and `value.explanation.others` for selectable quotes in the compact board); `vendor_contact` per business with the statuses `bounced`, `failed`, `opted_out`, `quarantined_reply`, `scheduled`, and new in sprint 5: `declined`, `unreachable`, `asked_question`, `reply_unreadable`, `no_reply`; the "Not compared: …" line in `next`.
- **Flags:** `date_mismatch`, `delivery_window_mismatch`, `identity_mismatch`, `fees_unclear`, `tax_excluded`.
- **Refresh:** call `get_quotes({ job_id, detail: true })` from the view; don't depend on `freshness.valid_until` (optional).
- **Suspended workspace:** every tool returns HTTP 403 `WORKSPACE_SUSPENDED` with a fix line; the view should show it as an error state, not a spinner.

## 4. Shared-contract changes needing both founders' approval (`packages/core`)
| Change | Why | Engine status |
| --- | --- | --- |
| `ApprovalStatus` += `awaiting_vendor_confirmation`, `order_confirmed`, `handoff_refused` | Booking needs the vendor's (or attesting human's) confirmation before payment | Returned as strings today |
| DealBoard += `selection`, `vendor_contact`, `purchase.{order, must_haves, confirm_only, booked_by_human}` | Comparison and booking state the human must see | Returned via `DealBoardPlus` (`apps/mcp/src/views.ts`) |
| `vendor_contact` status enum (list in §3) | Plain-language exclusion reasons | Returned |
| `QUOTE_FLAGS` += `date_mismatch`, `delivery_window_mismatch`, `identity_mismatch`, `fees_unclear` | Approval blocks and caveats | Returned |
| `ReplyMeta.extraction: "claude" \| "heuristic"` | Brain ignores keyword-fallback readings | Engine already withholds them |
| Brain methods take `workspaceId` (§1) | Tenant isolation | Ready to pass it |
| Optional `BookingRow.human_attested_at` mirror, only if `contracts.ts` mirrors bookings | Migration 118 | DB column exists |
| Compact board: allow omitting per-quote `job_id`, or shortening `contact_learning` for always-replying vendors | One history-heavy 6-vendor board measured 10,851 chars vs the 10,000 budget | Needs a schema/view decision |

## 5. Smaller items
- `README.md` line 11 still says "pays, in Stripe test mode"; the pilot pays the vendor directly (manual).
- Demo fleet dates are fixed on the engine side (quotes valid 14 days from when given); `fixtures/views/*.json` dates may need a refresh for screenshots.
