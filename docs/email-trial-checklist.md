# Email trial checklist (real Gmail / Outlook replies)

The first real-world email test: one clearly labelled TEST email from the Inkbox buyer mailbox to
mailboxes **you own**, replied to from real mail clients, then collected and checked against the
engine's real inbound pipeline. Nothing is bought, no business is contacted, no database is touched,
and Claude is never called. Script: `apps/mcp/scripts/email-trial.ts` (logic in `email-trial-lib.ts`,
offline replay in `email-trial-replay.ts`).

Run every command from `apps/mcp/`. Keep the run directory **outside the repository** (the script
refuses one inside it): it will hold raw copies of real mail.

## 0. Before you start

- [ ] Pick the trial mailboxes: one Gmail and one Outlook/Hotmail address that you personally own
      and can reply from on web, phone (Gmail app, Outlook app) and iOS Mail. Ask nobody else to
      take part. A second address of yours is needed for the "forward" scenario.
- [ ] Pick a run directory outside the repo, e.g. `~/haggle-trials/2026-10-23-gmail`. Use a new one
      per send (the script refuses to send twice into the same run).
- [ ] The buyer identity is `haggle` unless `INKBOX_IDENTITY` says otherwise.

## 1. Add `message.bounced` and `message.failed` to the buyer's webhook subscription

The live subscription (inspected 2026-10-22) covers `message.received`, `call.ended`,
`imessage.received` and `a2a.sent_task.updated` only, so Inkbox bounces never reach the server
(the reconciler's outbound status sweep is the only safety net). Do this once, by hand.

Check first (read-only; prints which required mail events are missing):

```
HAGGLE_EMAIL_TRIAL=1 node --env-file=.env scripts/email-trial.ts check-subscription
```

It lists the buyer identity's subscriptions with `scope: "identity"`. The buyer's subscription is
identity-owned and **mixed** (mail + call + iMessage + A2A events); in SDK 0.7.19 a plain
`subscriptions.list()` leaves mixed rows out, which is why the check asks for the identity scope.

**Dashboard:** Inkbox dashboard → the buyer identity (`haggle`) → Webhooks → its subscription →
event types → add `message.bounced` and `message.failed` (optionally `message.delivered`). Keep
every existing event type. Save. The signing key does not change.

**SDK (instead of the dashboard), method names from the installed `@inkbox/sdk` 0.7.19; not run by
any script here:**

```ts
const inkbox = new Inkbox({ apiKey });
const me = await inkbox.getIdentity("haggle");
const [sub] = await inkbox.webhooks.subscriptions.list({ agentIdentityId: me.id, scope: "identity" });
// eventTypes REPLACES the stored list: pass every existing type plus the new ones.
await inkbox.webhooks.subscriptions.update(sub.id, {
  scope: "identity", // required for a mixed subscription
  eventTypes: [...new Set([...sub.eventTypes, "message.bounced", "message.failed"])],
});
```

- [ ] Re-run `check-subscription`: `"ok": true`, `missing_required: []`.
- [ ] Same output, `buyer_mail_inbound_filter`: the buyer identity's inbound mail filter
      (`AgentIdentity.mailInboundFilterMode`). `whitelist` means only allowed senders' mail is
      delivered: add the trial mailboxes (and, later, every pilot vendor) to the identity's allow
      list, or replies silently never arrive. `blacklist` accepts everyone not blocked.
- [ ] Ask Inkbox (open question): is `message.bounced` permanent bounces only, or also soft ones?
      The engine treats a bounce as permanent unless the business has replied from that address.

## 2. Validate (no network, nothing written)

```
HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me@outlook.com \
  node --env-file=.env scripts/email-trial.ts validate --run ~/haggle-trials/t1 --to me@gmail.com --i-own-this-mailbox
```

It prints one line per check: `INKBOX_API_KEY` set (the value is never shown), `INKBOX_IDENTITY`,
`HAGGLE_EMAIL_TRIAL`, the allowlist (and any malformed entries it ignored), whether `--to` is
listed, the ownership flag, the run directory (outside the repo, writable, already used?) and the
locally installed SDK version. Exit code 1 if anything blocking is wrong. Fix every `FAIL`.

## 3. Dry run (no network, nothing written)

```
node scripts/email-trial.ts dry-run --to me@gmail.com --run ~/haggle-trials/t1 --buyer <buyer mailbox>
```

- [ ] Read the printed email: subject starts `[HAGGLE TEST] [HG-TRIAL]`, body says THIS IS A TEST,
      lists the nine scenarios, and ends with `Reference: HGR-…`. (The token and run id shown are
      illustrative; `send` makes fresh ones.)
- [ ] The "Send gates" line shows what `send` still needs.

## 4. Send (the only step that sends mail)

All three gates are required, every time: `HAGGLE_EMAIL_TRIAL=1` for this one command, the
recipient listed in `HAGGLE_EMAIL_TRIAL_MAILBOXES`, and `--i-own-this-mailbox`.

```
HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me@outlook.com \
  node --env-file=.env scripts/email-trial.ts send --to me@gmail.com --run ~/haggle-trials/t1 --i-own-this-mailbox
```

- [ ] `run.json` (mode 600) now holds the run id, the run-local token secret and the **send-time
      Message-ID**. Don't share it.
- [ ] Repeat for the Outlook mailbox with a **new** `--run` directory.

## 5. Reply scenarios (from your own mail clients)

Reply to the test email once per scenario. Use the quote text it suggests ("We can do it: $1,150
total, delivered. $345 deposit.").

| # | Scenario | Expected verdict | Expected pipeline outcome |
|---|---|---|---|
| 1 | Gmail web, normal Reply | `ok:external-reply-token` | `stored`, quote $1150 (not approvable: offline keyword reader) |
| 2 | Edited subject | `ok` if the quote (with the reference) was kept, else `identity_unverified:token_missing` | same |
| 3 | Quote deleted, subject kept | `ok` (token in the subject) | `stored`, quote |
| 4 | Gmail app, Outlook app, iOS Mail | `ok` each; quoted history cut | `stored`, quote |
| 5 | Forward to your 2nd address, reply from there | `identity_unverified:from_mismatch` | `quarantined:sender_mismatch` |
| 6 | One-page PDF, one-line body | `ok`; attachment listed | `stored`; "attachment(s) not replayed offline" |
| 7 | Same reply twice | two messages, both `ok` | both `stored` (each is its own message; dedupe is per provider id) |
| 8 | New email (not Reply), token pasted | `identity_unverified:not_in_our_thread` | `quarantined:no_signal` (new subject, no deal tag) or `identity_unverified` (subject kept) |
| 9 | Reply all | `ok` | `stored` (Haggle in To **or Cc** is accepted) |

Optional, ask first: a bounce, to an address you own that rejects mail (or an SES mailbox-simulator
address, if Inkbox allows it). Watch for `message.bounced` in the server log or Inkbox's delivery log.

## 6. Collect

```
HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me@outlook.com \
  node --env-file=.env scripts/email-trial.ts collect --run ~/haggle-trials/t1 --i-own-this-mailbox
```

It reads (never sends): the outbound test email as the mailbox stores it, every inbound reply since
the run started from your trial addresses (and mailer-daemon), restoring each one's unread state.
It writes `report.json`, `report.md` (redacted: shareable) and `raw/<id>.json` (unredacted: keep
private). Each reply is evaluated twice: with the engine's pure inbound functions (the verdict
columns) and through the **real pipeline** offline (signed webhook → `webhook.ts` → engine matching,
reply-token verification, opt-out/bounce checks → parse): the `pipeline` column. That is the same
code path the live server runs.

Later, `dry-run --run <dir>` replays the saved captures through the pipeline again (e.g. after a fix).

## 7. Read the report

1. **Message-ID at send time vs stored: check this first.**
   - `OK: the Message-ID the engine stores at send time is the one replies reference` → good.
   - `MISMATCH: …` → the id `messages.send()` returned is not the one recipients see (SES assigns
     its own). Then **every** real reply fails `identity_unverified:not_in_our_thread` on the live
     server. Look at the `(any id: …)` note in the verdict column: if replies pass when the stored or
     SES id is known, the fix is to store that id after sending (re-list the outbound message, or
     use `sesMessageId`). Do not run a pilot until this is fixed; report it to the coordinator.
   - `outbound message not found when listing the mailbox` → re-run collect a minute later.
2. **Summary:** `verified` should equal the replies from scenarios 1–4, 6, 7 and 9. Any other
   `quarantined …` count tells you which scenario failed and why (see `quarantineReasons.ts`).
3. **Per reply:** `token subj/body/own` shows where the token survived; `cut quotes = yes` means
   Haggle's quoted email was removed before reading (it must be, or Haggle's own figures could be
   read as the vendor's); `body = html` marks an HTML-only reply; `CHECK: body looks quoted but
   nothing was cut` is a reader bug to report with the raw capture.
4. **Pipeline vs verdict must agree** on every reply (stored ⇔ `ok:`). A disagreement is a bug.
5. Save the redacted `report.md` with the sprint notes. Never commit `raw/` or `run.json`; turn a
   capture into a fixture only after replacing addresses and tokens with placeholders
   (`packages/engine/tests/fixtures-email/` shows the format).

## 8. Afterwards

- [ ] Delete the trial messages from your own mailboxes if you like; the buyer mailbox keeps them.
- [ ] If anything held real vendor mail in quarantine during a pilot, review it with
      `scripts/quarantine.ts list` / `show` and release only after verifying with the business on a
      number you already know (`release --verified-by … --how …`).
