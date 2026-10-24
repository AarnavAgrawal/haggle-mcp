# Founder-operated pilot: readiness report (2026-10-23)

Can the founder serve 3–5 real event organizers by hand while staging waits on Manufact and Inkbox? This report says which of it is possible now, which part needs the first real-mailbox trial, and which needs production. How to run it: `docs/pilot-operator-playbook.md`.

**Evidence rule:** everything verified here is from tests and simulated runs. **No real vendor, reply, approval or payment has gone through Haggle.**

## 1. Verdict

- **The process and tooling for a first pilot are ready.** Intake, vendor consent, workspace setup, approver verification, the outreach gate, monitoring, comparison, approval by text, booking confirmation and the manual payment handoff all exist and are tested end to end in simulation (`acceptancePilot`, 6/6 pilot-path deals settled in the scorecard).
- **No real customer can be served yet.** A deal needs a live server, and none is deployed: staging is blocked on Aarnav's Inkbox identity and Manufact link. The first real deal also depends on real mail threading and real SMS approvals, which have never been exercised.
- **Doing intake now is safe and useful:** customer conversations, vendor consent, filled intakes. None of it contacts anyone through Haggle.

## 2. Fixed in this pass

**Outreach before verification (safety).** A live pilot workspace emailed real vendors for quotes even when nobody had verified its approver phone. The preflight script noticed this, but the server didn't enforce it.

Now `Engine.deal` refuses before any job or message exists, with `approver_unverified` or `approver_missing` and the exact operator command. It applies to live mode, for workspaces with their own vendor roster.

| Where | Change |
| --- | --- |
| `deal(dry_run=true)` | says `NOT READY` |
| `workspace-admin show` | its approver check now fails until the phone is verified, so `show` and the server agree |
| Unchanged | mock mode, and live workspaces without their own roster (for example the staging email trial) |

Tests:
- new: `packages/engine/tests/outreachGate.test.ts`;
- extended: `apps/mcp/tests/acceptancePilot.test.ts` (refused over MCP, nothing sent, then passes after `verify-approver`) and `pilotOnboarding.test.ts`.

No migration, env, shared-contract or Aarnav-owned file changed.

## 3. Outreach is never triggered early: verification

| Precondition | Enforced by | Verified by |
| --- | --- | --- |
| Live server config valid | startup throws `ConfigError`; `launch-gate.ts` in the release | `config*`, `launchGate` tests |
| Approver phone set and verified | `Engine.outreachBlock` (new) | `outreachGate.test.ts`, `acceptancePilot` |
| Workspace not suspended | MCP gate `WORKSPACE_SUSPENDED`; suspended deals don't advance | `lifecycleControls`, `operatorActions` |
| Recipient on the roster or allowlist, not suppressed | `Engine.deal` `recipient_not_allowed`; suppressions | `security*`, `workspaceVendors` |
| Named vendors only, never substituted | `deal` resolves exactly the named businesses | `mcp.e2e`, `businesses` |
| Contact hours | `contactWindow` | `contactWindow` tests |
| **Buyer sign-off of this request and vendor list** | **Procedure only** (playbook §3: signed intake, dry-run preview, `client_request_id`) | Not enforceable without a migration (operator-log action types are fixed by migration 119) |

Anyone holding the workspace credentials can still start a deal once the server-side checks pass. In the founder-operated model that's only the founder.

## 4. What can be done now (no live server needed)

- Recruit 3–5 organizers with real upcoming events (2+ weeks out, to leave room for the staging trial).
- Intake calls with `docs/templates/pilot-intake.md`, customer sign-off, saved privately.
- Vendor consent conversations, with who, how and when recorded, ready for `add-vendor`.
- Write the pilot terms: no money through Haggle, the customer pays the vendor directly, and who bears a no-show. Settle the vendor consent wording.
- Rehearse the playbook against the simulated pilot (`npx vitest run apps/mcp/tests/acceptancePilot.test.ts`), using the comparison and status templates on its board.
- Set the KPI targets (playbook §6) and create the private deal log.

## 5. What needs the first real-mailbox trial (staging)

These are unverified and would change the pilot if they fail:
1. **Gmail and Outlook replies thread back to the deal** (reply tokens), and real replies become token-verified quotes (`docs/staging-email-trial-runbook.md`).
2. **Claude reads real vendor mail** as well as the recorded synthetic corpus (322/328 fields, 0 incorrect financial quotes approvable). Check every quote by hand against the original in the deal log until accuracy is proven.
3. **The real SMS line:** approval texts arrive, and `YES`/`BOOKED`/`PAID <code>` from the approver phone are matched.
4. **A bounce** marks the vendor bounced.
5. **The founder's own client connects** to the deployed server (Claude Code `--header`, unverified against a deployed server).
6. **One reply whose figures don't add up** is held, and one clarification email reads correctly (`docs/release-delta-staging-rc.md` §5).

Prerequisites: Aarnav's Inkbox staging variables and Manufact `link.json`, migrations through 122 on staging, deploy, then `pilot-preflight --check-webhooks` PASS (`docs/staging-handoff.md` from G1).

## 6. What needs production readiness

- Production backup verified, then migrations 103–122 through the ledger; `launch-gate --target production`, `smoke --live-readonly` (`docs/pilot-launch-checklist.md` E).
- **Brain tenancy (Aarnav), before customer 2.** Learning is shared across workspaces, so one customer's vendor prices could inform another's estimates. Until it lands, the founder doesn't use `ask` or `business_profile` for pilot customers, and the preflight shows this as WARN.
- Branch protection on `main` and both owners' sign-off on the merge (release delta §4: brain input, the deal-board label for `numbers_dont_add_up`, `.env.example`).
- Alert webhook owner agreed (`HAGGLE_ALERT_WEBHOOK_URL`), so stuck deals page someone.
- Legal: commercial-email requirements (`docs/manual-actions.md` §5) and signed pilot terms.

## 7. Known product limits a pilot customer may hit

- "Delivery included" is judged unmet when delivery costs extra. This needs a product decision; meanwhile say in the comparison what the vendor actually offered.
- Discounts have no field. Vague pricing ("around $X") is shown as no new price.
- Requests made outside Mon–Sat 08:00–19:00 Pacific go out the next business morning, which counts against time to first quote.
- Real tax under 2% hidden in a "tax included" total gets held for clarification.

## 8. Gaps not fixed (deliberately)

- **Buyer sign-off stored in Haggle:** a new operator-log type needs a migration. The private intake plus the `client_request_id` covers it for 3–5 customers.
- **Founder time and quote accuracy aren't instrumented:** they're logged by hand (`docs/templates/pilot-deal-log.md`). It's cheaper than code at this scale, and accuracy needs a human comparison anyway.
- **No customer-facing portal:** the founder sends updates from the templates. A frontend or self-service onboarding would be premature before the first real deal.
