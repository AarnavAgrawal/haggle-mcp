# Pilot intake (template)

Copy this file to `~/haggle-pilot-private/<customer>/intake-<YYYYMMDD>-<n>.md` and fill it in there. Never fill it in inside the repo. One intake per event.

When the customer replies "approved" in writing to the filled copy, that is their authorization to contact exactly the vendors in §6 for this request. Save the reply next to it.

---

**Intake id:** `<customer-short>-<YYYYMMDD>-<n>` (this becomes `client_request_id`)
**Workspace id:** `ws_…`
**Taken by / on:** <founder> / <date>
**Signed off by the customer on:** <date, channel>

## 1. The event

| Field | Value | `deal` field |
| --- | --- | --- |
| What (in the customer's words) | | `request.what` |
| Event date | YYYY-MM-DD (a range if flexible: first – last acceptable day) | `request.date` / `date_until`, or `when` in words |
| Serve / delivery time | HH:MM, and the latest acceptable | `request.time`; the latest time goes in `delivery` |
| Location | street address, city | `request.venue` / `where`; city goes in `area` |
| Delivery or pickup | delivered and set up / delivered / pickup | `request.delivery` |
| Headcount | number; say if it's an estimate and when it's final | `request.quantity` |

## 2. Budget

| Field | Value | `deal` field |
| --- | --- | --- |
| Budget for the whole order | $ | `budget_usd` |
| Target, or absolute maximum? | target / hard limit | `budget_is_hard_limit` |
| Includes tax, delivery, gratuity? | yes / no / unsure | note in `requirements` if it matters |
| Most the customer will pay in one payment (deposit) | $ (the workspace cap; operator sets it) | `workspace-create --cap` / `set-cap` |

## 3. Dietary and must-haves

Must-haves are checked against every quote; a quote that misses one is never recommended.

| Need | Count or detail | Must-have or nice-to-have? |
| --- | --- | --- |
| Vegetarian | | |
| Vegan | | |
| Gluten-free | | |
| Allergies (nuts, shellfish, …) | | |
| Halal / kosher | | |
| Other (setup, serving staff, utensils, labels) | | |

## 4. Deadlines

| Field | Value | Use |
| --- | --- | --- |
| Quotes needed by | date and time | `deadline` (ISO) |
| Customer decides by | date | when to send the comparison |
| Vendor's latest booking / payment date the customer can meet | date | flag quotes with an earlier deposit date |

## 5. Preferences

- Priority: lowest price / balanced / quality (`preferences.priority`)
- Vendors to avoid, and why:
- Anything the vendors should know (parking, floor, contact on site); **no competitor prices**, which Haggle refuses:

## 6. Authorized vendors (contacted only after sign-off)

| Vendor | Contact channel | Vendor consent recorded? (who, how, when) | On the roster (`add-vendor`)? |
| --- | --- | --- | --- |
| | email / text | | |
| | | | |
| | | | |

Haggle contacts exactly these, never a substitute. A vendor without recorded consent is not contacted.

## 7. Approval and payment (read back to the customer)

- Approver phone (the customer's own, verified by the operator): `+1…`. Only a text from it approves, books or reports payment.
- The customer pays the vendor directly, after the vendor confirms the booking in writing and after confirming the payment details by phone. Haggle never takes or moves money.
- Pilot terms sent and accepted on: <date>

## 8. Operator checklist before `deal`

- [ ] Customer sign-off saved
- [ ] `pilot-preflight.ts --workspace <id>` exit 0 today
- [ ] `deal(…, dry_run=true)` lists exactly §6, and has no `NOT READY` line
- [ ] `deal(…, client_request_id=<intake id>)` sent at <time>; job id: `job_…`
