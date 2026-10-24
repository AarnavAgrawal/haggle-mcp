# Pilot operator playbook (founder-operated, first 3–5 customers)

How a founder runs Haggle by hand for the first real event organizers, with no self-service onboarding. It links to the detailed guides instead of repeating them:
- `docs/pilot-onboarding.md`: the workspace scripts;
- `docs/first-user-guide.md`: what the customer reads;
- `docs/operator-recovery.md`: stuck deals;
- `docs/pilot-metrics.md`: how the numbers are computed.

Readiness: `docs/pilot-readiness-report.md`. Templates: `docs/templates/`.

## 0. The operating model

| Role | Who | Does |
| --- | --- | --- |
| **Operator** | the founder | Takes the intake and sets up the workspace and vendors. Runs the agent: Claude Code connected with the customer's workspace credentials. Sends the customer the status updates and comparisons (§5) and records KPIs. |
| **Customer** | the event organizer | Signs off the intake and answers vendor questions, through the operator. Approves by text from their own phone. Pays the vendor directly. |
| **Approver phone** | the customer's own phone | It's the only thing that can approve, book or report payment: `YES`/`NO`/`BOOKED`/`PAID`/`CANCEL <code>`. **Never the founder's phone.** |
| **Vendors** | businesses that agreed to hear from Haggle | Reply by email or text as usual. |

Haggle never moves money in the pilot (`HAGGLE_PAYMENTS=manual`).

The founder holding the agent credentials is deliberate. It keeps the customer's effort to answering and approving, and the founder sees every message. The founder still can't approve: approval comes only from the customer's phone, by a code the agent never sees.

**Customer information stays out of the repo.** Keep each customer's intake, consent records, updates and KPI log under `~/haggle-pilot-private/<customer>/` (mode 0700), never in `fixtures/`, tests, docs or commit messages. Workspace ids and vendor names go in the operator log (database) only.

## 1. The journey, stage by stage (audit, 2026-10-23)

| # | Stage | How it works today | Operator action | Gap / risk |
| --- | --- | --- | --- | --- |
| 1 | **Intake** | Intake template (`templates/pilot-intake.md`) → `deal`'s request fields. `deal` reads plain words (headcount, date, time, venue, dietary, budget) and refuses with "Nothing was sent" if one is unreadable or the date is past. | Fill the template on a call with the customer, then send it back for written sign-off. | None blocking. Haggle never guesses a missing headcount or date. |
| 2 | **Requirements clarification** | Must-haves become checkable requirements. A vendor's question reaches the agent (`wait_for_update`), and `answer_business` relays an answer in that vendor's thread. | Ask the customer; relay **their words** only. Never answer for them about money, dietary needs or dates. | The customer's answer goes through the founder (adds latency; it's logged in the KPI sheet). |
| 3 | **Vendor selection** | The workspace roster (`workspace-admin add-vendor --consent`). `deal` contacts every roster vendor, or exactly those named, never a substitute. | Add only vendors with recorded consent. Name the intake's authorized vendors in `deal(businesses=[…])`. | Consent wording is still an open decision (`pilot-launch-checklist` A). A vendor that consented for one customer is a separate roster row and consent per workspace. |
| 4 | **Outreach authorization** | Server: contact allowlist, suppression list, contact hours, approval only from the verified phone. **New:** a live pilot workspace contacts nobody until its approver phone is verified (`approver_unverified`/`approver_missing`, nothing sent). | §3 gate, every deal. `deal(dry_run=true)` first; the customer approves the exact vendor list. | Buyer sign-off isn't stored in Haggle. The operator log only accepts fixed action types (migration 119), so a new type needs a migration. Keep the signed intake in the private folder and use its id as `client_request_id`. |
| 5 | **Quote monitoring** | `wait_for_update` (cursor), `get_quotes`, `list_deals`; `ops-report` and alerts for stuck jobs; reminders and follow-ups are automatic. | Check twice a day (§4) and send a status update (`templates/pilot-customer-updates.md` A). | Vendors are contacted only Mon–Sat 08:00–19:00 Pacific; an evening request goes out the next morning. |
| 6 | **Comparison** | `get_quotes` ranks on requirements, budget, price, deposit and terms. Held quotes (figures that don't add up, another date, options) are shown with the reason and are never approvable. | Send the comparison (`templates` B), built only from `get_quotes`, never from memory or vendor emails directly. | "Delivery included" is judged unmet when delivery costs extra (product decision open). Discounts have no field. |
| 7 | **Human approval** | `approve` → Haggle texts the customer a summary and code; `YES <code>` approves. | Tell the customer the text is coming and what it should say (amount, vendor). Never ask them to forward the code. | The real SMS line is untested (first-trial item). |
| 8 | **Vendor confirmation** | After YES, Haggle asks the vendor to confirm in writing. An unverifiable "confirmed" (Gmail or Outlook) needs the customer's `BOOKED <code>` after they check with the vendor. Reminders at 24 h. | Prompt the customer to call the vendor before `BOOKED`. | Real-mailbox threading is unverified (staging email trial). |
| 9 | **Manual payment handoff** | The vendor's payment instructions are passed on with "confirm by phone before paying". The customer pays directly and texts `PAID <code>`, which is recorded as *reported* until the vendor confirms. | Make sure the customer confirms the payment details by phone with the vendor. Haggle never opens links. | Pilot terms aren't written yet (who bears a vendor no-show). Legal item, before customer 1. |

## 2. Onboarding one customer (about 45 minutes, once)

1. **Intake call:** fill `templates/pilot-intake.md` together. Send it back; the customer replies "approved" in writing. Save both in the private folder.
2. **Vendors:** for each vendor the customer wants (and any the founder suggests and the customer accepts), get the vendor's own agreement to receive quote requests from Haggle. Record who, how and when.
3. **Workspace** (`docs/pilot-onboarding.md` §2–5): `workspace-create` (dry run, then `--apply`) with the customer's phone as approver and their cap. Then `add-vendor --consent` for each vendor, and `verify-approver` after an out-of-band code read-back.
4. **Preflight:** `pilot-preflight.ts --workspace <id>` must exit 0. With it, `workspace-admin show` reads `Readiness: PASS`.
5. **Credentials:** keep them in the founder's password manager; the founder runs the agent. Give the customer `docs/first-user-guide.md` §3–5 (what texts to expect, how to pay) and the pilot terms.

## 3. The outreach gate: before every `deal`

Vendor communication starts only when **all** of these hold. The first three are enforced by the server; the founder checks the last three.

| Check | Enforced by | If it fails |
| --- | --- | --- |
| Server is live with its launch gate passed (config, migrations, prod-DB guard) | startup config check, `launch-gate.ts` in the release | Server doesn't start; nothing sent |
| Workspace not suspended; its approver phone set **and verified** | MCP gate (`WORKSPACE_SUSPENDED`), `Engine.outreachBlock` (`approver_unverified`/`approver_missing`) | `deal` refused, no job, nothing sent |
| Every contacted vendor is on the workspace roster or the server allowlist, not opted out or bounced | `Engine.deal` (`recipient_not_allowed`), suppression list | Refused, nothing sent |
| `pilot-preflight --workspace <id>` exits 0 today | operator | Don't run `deal` |
| The customer signed off this intake, including the vendor list | operator (private folder) | Don't run `deal` |
| `deal(…, businesses=[authorized names], dry_run=true)` shows exactly the signed-off vendors, and no `NOT READY` line | operator | Fix, or re-confirm a shorter list with the customer |

Then the same call without `dry_run`, with `client_request_id: "<intake id>"`, so a retry never contacts anyone twice.

## 4. Daily routine while a deal is open

- **Morning and mid-afternoon:**
  - `wait_for_update(job_id, cursor)` and `get_quotes(job_id)`;
  - `ops-report` (stuck jobs, held mail and texts);
  - review quarantine (`quarantine.ts`) and release or reject; never edit rows.
- **Vendor question:** ask the customer the same day, then `answer_business` with their words.
- **Status update** to the customer when something changed: a quote, a question, quotes final, approval requested, booked or paid. Use template A, at most one a day otherwise.
- **First sign of a wrong message to a vendor:** `workspace-admin suspend --id <ws>`, then investigate (`docs/operator-recovery.md` §7).
- **Log** each deal's KPI row (`templates/pilot-deal-log.md`) as milestones happen, including the minutes you spent.

## 5. What the customer receives

- **Status update** (template A): what's happened, what's next, and whether anything is needed from them.
- **Comparison** (template B): every quote from `get_quotes`, held ones with their reason, the recommendation and why, and what approving means.
- **Before approval:** "You'll get a text from Haggle for $X with <vendor>; reply YES <code> only if that's right."
- **After booking:** the vendor's confirmation and payment instructions as Haggle passed them on, with the reminder to confirm by phone before paying.

## 6. Pilot KPIs

Measure per deal; report per customer and overall. `metrics.ts --workspace <id>` covers the database-backed ones. `--min-quotes` defaults to 3. Mark internal or demo workspaces as test first (`traction.ts mark-test`).

| KPI | Definition | Source |
| --- | --- | --- |
| **Time to first quote** | Deal created → first priced quote from a verified sender (median, p90). Also log "first contact sent → first quote", because the contact-hours window can delay the first send. | `metrics.ts` timings; the deal log for the contact-sent time (board `last_event`) |
| **Vendor response rate** | Contacted vendors that replied / that quoted, by channel | `metrics.ts` response by channel |
| **Accurate quotes** | Quotes whose total, deposit, date, headcount and must-haves on the board match the vendor's own message, checked by the operator against the original | Deal log (manual; Haggle can't grade itself) |
| **Human intervention time** | Founder minutes per deal (intake, relaying answers, updates, recovery) and customer actions per deal | Deal log minutes; `metrics.ts` manual interventions (counts) |
| **Approval rate** | Approvals approved / approval requests | `metrics.ts` funnel (approval requested → approved) |
| **Completed purchasing handoffs** | Deals reaching vendor-confirmed booking and `PAID` reported. Report "payment confirmed by the vendor" separately | `metrics.ts` funnel (booked, payment reported, completed) |

**Targets for the first 3–5 customers** (proposed, to revisit after the first deal):
- first quote within 4 business hours;
- 50% or more of vendors quote;
- 100% of shown totals accurate;
- under 60 founder minutes per deal after onboarding;
- 1 completed handoff per customer.

## 7. Stop conditions

Suspend the workspace and stop the pilot for that customer if any of these happens:
- a vendor receives a message they didn't consent to;
- a wrong amount or date reaches a vendor;
- an approval text has the wrong amount or vendor;
- anything is paid without a vendor-confirmed booking.

Record it in the private folder and in `CHECKLIST.md` Blockers (capability only, no customer details).
