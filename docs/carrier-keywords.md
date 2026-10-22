# Text commands and carrier opt-out keywords

Haggle's coded text commands share words with SMS carrier keywords. This page says which words collide, what Haggle does, and what depends on the provider (Inkbox) and must be confirmed on the real line.

## The words

| Haggle asks for | Carrier keyword? | Why it's safe |
| --- | --- | --- |
| `YES 4821` / `NO 4821` (approve / decline) | `YES` alone is a common **opt-in** keyword | Haggle always sends the code. A bare `YES` re-subscribes at worst; Haggle approves on a bare yes only when that approval was the last thing it texted that number. |
| `PAY 4821`, `PAID 4821`, `BOOKED 4821` | no | |
| `CALL 482913` (allow one callback) | no | |
| `CANCEL 482913` (cancel a vendor-confirmed booking, H3) | `CANCEL` alone is an **opt-out** keyword | Haggle only accepts it with the 6-digit code. Exact-match keyword handling (the usual provider behaviour) ignores `CANCEL 482913`. |
| "Text Haggle back (e.g. RESUME)" | no (`START`/`UNSTOP` are opt-in) | Any reply resumes. |
| Email footer "reply STOP" | email only | Not a text. |

Standard opt-out keywords (CTIA): STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE. Opt-in: START, UNSTOP, YES. Info: HELP, INFO.

## What Haggle does with a bare opt-out keyword (tested in `packages/engine/tests/carrierKeywords.test.ts`)

- **From a vendor's number (SMS or iMessage):** an opt-out, the same as STOP. The number is suppressed for every deal and channel, and the vendor is marked declined. If that vendor holds the deal's live approval, the human is told Haggle can't text them any more and not to pay before checking directly, and the operator is flagged (`booked_vendor_opted_out`). Before this change, CANCEL, END and QUIT were read as ordinary replies, and an iMessage STOP was not honoured.
- **From the approver's number:** Haggle texts nothing back. Every later text to them is held and re-sent when they text again (START or anything else). Each of their open deals records the event, so the agent sees it on `wait_for_update`, and the operator is flagged (`approver_carrier_opt_out`). Nothing is approved, cancelled or paid by the keyword. A bare `CANCEL` cancels nothing; the code is required.
- **Limitation:** "texts held after a keyword" is remembered in process memory, like Inkbox's unanswered-limit pause. After a restart, Haggle could try to text an opted-out approver. A provider that enforces opt-outs refuses that send, and Haggle logs and holds it.

## Provider-dependent (confirm with Inkbox before the pilot)

1. Does Inkbox (or its carrier) process opt-out keywords on Haggle's line, and does it match **only the exact keyword** (so `CANCEL 482913` is delivered and not treated as an opt-out)?
2. Does it send its own auto-reply to STOP, HELP or START, and does it deliver the inbound keyword to Haggle's webhook at all? If keywords are swallowed, Haggle never sees the opt-out. The provider still blocks sends, and Haggle sees send failures.
3. After an opt-out, what error does a send return (so it can be mapped like `unanswered_limit`)?
4. Does a texted START (or any reply) lift the block?

Until these are answered, tell pilot approvers: always include the code, and never text a bare STOP or CANCEL to Haggle's number unless they mean "stop texting me".
