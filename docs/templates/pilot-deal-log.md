# Pilot deal log (template)

The two KPIs Haggle can't measure itself, quote accuracy and founder time, plus the milestone times, one row per deal. Keep the filled copy at `~/haggle-pilot-private/pilot-deal-log.csv` (or a private spreadsheet), never in the repo. Use workspace and job ids, not customer or vendor names.

```csv
job_id,workspace_id,intake_signed_at,deal_sent_at,first_contact_sent_at,first_quote_at,vendors_contacted,vendors_replied,vendors_quoted,quotes_checked,quotes_accurate,inaccuracies,approval_requested_at,approval_decision,booked_at,paid_reported_at,payment_confirmed_by_vendor,founder_minutes,customer_actions,notes
```

| Column | How to fill it |
| --- | --- |
| `first_contact_sent_at` | The first "contacted" event on the board. It differs from `deal_sent_at` when the contact-hours window held the first send. |
| `quotes_checked` / `quotes_accurate` | Compare each priced quote on the board with the vendor's original message: total, deposit, date, headcount, and each must-have. It's accurate only if all match. |
| `inaccuracies` | Field and kind only, e.g. `deposit:missed; total:tax not included`. No vendor wording. |
| `approval_decision` | `yes` / `no` / `expired` / `none requested` |
| `founder_minutes` | Every minute on this deal after onboarding: intake, relaying answers, updates, checks, recovery. |
| `customer_actions` | Answers given plus texts sent (YES / BOOKED / PAID / CANCEL). |

Cross-check against `metrics.ts --workspace <id> --json` weekly: response rate, timings and the funnel should agree with the log.
