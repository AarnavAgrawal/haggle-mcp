# Email trial checklist (real Gmail / Outlook replies, staging only)

The first real-world email test: one clearly labelled TEST email from a **staging** Inkbox buyer
mailbox to mailboxes **you own**, replied to from real mail clients, then collected and checked
against the engine's real inbound pipeline. Nothing is bought, no business is contacted, no database
is touched, and Claude is never called. Script: `apps/mcp/scripts/email-trial.ts` (gates and report in
`email-trial-lib.ts`, the send/collect flows in `email-trial-io.ts`, offline replay in
`email-trial-replay.ts`).

Run every command from `apps/mcp/`. The two questions it answers: **is the Message-ID the engine
records at send time the one real clients put in In-Reply-To/References** (Inkbox may rewrite it
via SES), and **does the reply token survive** Gmail/Outlook/iOS replies.

## 0. Before you start

- [ ] A **staging Inkbox identity** with its own mailbox (not `haggle`, the production buyer: the
      script refuses it). Note its handle.
- [ ] A staging env file (e.g. `~/haggle-staging.env`, never committed) with `HAGGLE_ENV=staging`,
      `INKBOX_API_KEY=<staging org key>`, `INKBOX_IDENTITY=<staging handle>`.
- [ ] Trial mailboxes you personally own (at most 5, bare ASCII addresses, matched exactly: no
      plus-tag or look-alike matching): one Gmail, one Outlook/Hotmail, a second address for the
      "forward" scenario. Ask nobody else to take part.
- [ ] A new run directory **outside the repository** per send, e.g. `~/haggle-trials/2026-10-23-gmail`.
      The script creates it 0700 and refuses an existing one that others can read (`chmod 700`), one
      inside the repo (also through a symlink), or one that already holds a run.

## Gates (checked before any network call)

| Gate | send | collect | check-subscription |
|---|---|---|---|
| `HAGGLE_EMAIL_TRIAL=1` (prefix the one command; never in an env file) | yes | yes | yes |
| `HAGGLE_ENV=staging` (`production` FAILs; unset BLOCKED) | yes | yes | yes |
| `INKBOX_API_KEY` set | yes | yes | yes |
| `INKBOX_IDENTITY` set, not `haggle` | yes | yes | yes |
| `@inkbox/sdk` installed | yes | yes | yes |
| `HAGGLE_EMAIL_TRIAL_MAILBOXES`: 1-5 plain addresses, none malformed | yes | yes | - |
| `--i-own-this-mailbox` | yes | yes | - |
| `--to` exactly one allowlisted address (not the buyer mailbox) | yes | - | - |
| `--run` outside the repo, private; send: no `run.json` yet; collect: `run.json` whose recipient is still allowlisted | yes | yes | - |

`INKBOX_WEBHOOK_SECRET` is reported but not required (the replay signs with a local key; the staging
*server* needs it). A failed gate prints `FAIL` (set but wrong/unsafe) or `BLOCKED` (missing) with a
`fix:` line, and the command exits 1 having contacted nothing.

## 1. Webhook subscription (`message.received`, `message.bounced`, `message.failed`)

```
HAGGLE_EMAIL_TRIAL=1 node --env-file=$HOME/haggle-staging.env scripts/email-trial.ts check-subscription
```

Read-only. Lists the staging identity's subscriptions (`scope: "identity"`: the buyer's mixed
subscription is left out of a plain `subscriptions.list()` in SDK 0.7.19) and the missing event
types. Add missing ones in the Inkbox dashboard → identity → Webhooks → event types (keep the
existing ones), or with `subscriptions.update(sub.id, { scope: "identity", eventTypes: [...all
existing, "message.bounced", "message.failed"] })` (eventTypes replaces the list).

- [ ] `"ok": true`, `has_message_received: true`.
- [ ] `buyer_mail_inbound_filter`: `whitelist` means only allowed senders' mail arrives: add the trial
      mailboxes to the identity's allow list, or replies silently never arrive.

## 2. Validate (no network, nothing written)

```
HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me@outlook.com \
  node --env-file=$HOME/haggle-staging.env scripts/email-trial.ts validate --run ~/haggle-trials/t1 --to me@gmail.com --i-own-this-mailbox
```

Checks every gate of the next command for that directory (send if it holds no run, else collect),
one line each: `ok` / `FAIL` / `BLOCKED` / `info`, with `fix:` lines. Secret values are never shown.
Expected: `send: all gates pass (nothing was contacted).` With no configuration it lists 7 problems
and exits 1.

## 3. Dry run (no network, nothing written)

```
node scripts/email-trial.ts dry-run --to me@gmail.com --run ~/haggle-trials/t1 --buyer <staging mailbox>
```

- [ ] Prints which send gates still fail, then the exact email: subject `[HAGGLE TEST] [HG-TRIAL] …`,
      body THIS IS A TEST, the nine scenarios, `Reference: HGR-…` (illustrative: send makes fresh ones).

## 4. Send (the only step that sends mail)

```
HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me@outlook.com \
  node --env-file=$HOME/haggle-staging.env scripts/email-trial.ts send --to me@gmail.com --run ~/haggle-trials/t1 --i-own-this-mailbox
```

- [ ] `run.json` (0600) is created exclusively **before** the send call, then holds the run id, the
      run-local token secret and the **send-time Message-ID**. Running send again into the same
      directory refuses without contacting Inkbox. Don't share `run.json`.
- [ ] If the send call errors, `run.json` records `sendState: "failed"`. Don't send again elsewhere:
      run collect on this directory: it finds the email in the outbound mailbox by its subject if it
      did go out (`send_recovered` in the report).
- [ ] Repeat for the Outlook mailbox with a **new** `--run` directory.

## 5. Reply scenarios (from your own mail clients)

Use the quote text it suggests ("We can do it: $1,150 total, delivered. $345 deposit.").

| # | Scenario | Expected verdict | Expected engine match |
|---|---|---|---|
| 1 | Gmail web, normal Reply | `ok:external-reply-token` | `header+token` |
| 2 | Edited subject | `ok` if the quote was kept (token in quoted text), else `token_missing` | `header+token` / `header` |
| 3 | Quote deleted, subject kept | `ok` (token in subject) | `header+token` |
| 4 | Gmail app, Outlook app, iOS Mail | `ok` each; quoted history cut | `header+token` |
| 5 | Forward to your 2nd address, reply from there | `identity_unverified:from_mismatch` | `sender_mismatch` |
| 6 | One-page PDF, one-line body | `ok`; attachment listed (not replayed offline) | `header+token` |
| 7 | Same reply twice | two messages, both `ok` | `header+token` |
| 8 | New email (not Reply), token pasted | `identity_unverified:not_in_our_thread` | `token` |
| 9 | Reply all | `ok` (Haggle in To **or Cc**) | `header+token` |

Optional, ask first: a bounce to an address you own that rejects mail; collect reads delivery
notices only with `--include-bounces`.

## 6. Collect

```
HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me@outlook.com \
  node --env-file=$HOME/haggle-staging.env scripts/email-trial.ts collect --run ~/haggle-trials/t1 --i-own-this-mailbox
```

Reads, never sends. It opens **only** inbound mail from the allowlisted addresses (everything else is
skipped unopened and counted), restores each opened message to unread unless it was already read,
re-lists the outbound test email (stored and SES Message-IDs) and reads the webhook subscription.
Writes `report.json`, `report.md` (redacted: shareable) and `raw/<id>.json` (unredacted: keep
private), all 0600. Every reply is evaluated with the engine's pure inbound functions and replayed
through the real pipeline offline (signed webhook → `webhook.ts` → matching, token verification →
keyword reader). Later, `dry-run --run <dir>` repeats the replay and diagnosis offline (e.g. after a
fix), using the ids and webhook facts collect saved in `report.json`.

## 7. Read the report

**Overall verdict (first line), from the replies sent by the trial recipient itself:**

| Verdict | Meaning | Action |
|---|---|---|
| `READY: replies match by Message-ID` | Replies name the send-time id the engine records; held ones are listed with reasons | Check held replies are only the expected scenarios (2/3 stripped, 5, 8) |
| `ID MISMATCH` | Replies name the stored or SES id, never the send-time one: every real reply would be quarantined `not_in_our_thread` | Engine fix before any pilot: record the id named in `engine_should_record`; tell the coordinator |
| `TOKEN ONLY` | No Haggle id survives in headers, but the token does: quarantined `not_in_our_thread` | Inspect `raw/` In-Reply-To/References per client; report |
| `NOT MATCHED` | Neither a Haggle id nor the token survives | Check the replies were made with Reply to the test email |
| `NO REPLIES` | Nothing from the recipient yet | Wait a minute, re-run collect; check the inbound filter (section 1) |

**Message-IDs section:** send-time vs stored (`OK` / `MISMATCH`), the SES id, how many replies named
each id, and `the engine should record: …`.

**Per reply:**
- **Message-ID chain:** which of send-time / stored / SES appear in In-Reply-To and References, and
  which id this reply proves the engine must record (Outlook often sends In-Reply-To only: fine).
- **Reply token:** found in subject / own words / quoted text / not found, and the engine match:
  `header+token` (accepted), `header` (token_missing), `token` (not_in_our_thread), `none`,
  `sender_mismatch`.
- **Webhook:** subscription has `message.received`; the read state before collect. *read* = something
  fetched it via the API (the live webhook handler or reconciler, or the Inkbox console): probable,
  not proof; *unread* = nothing fetched it, so the staging server did not process it; *unknown* = the
  listing had no read flag. Confirm in the staging server log (`mail:<id>`).
- **Held:** the quarantine reason in plain English and the next step.
- **Extraction (keyword reading, offline heuristic, not Claude):** total, deposit, flags, approvable
  (never approvable offline; the live server reads with Claude).

Also: `CHECK: body looks quoted but nothing was cut` is a reader bug to report with the raw capture;
the pipeline column must agree with the verdict (stored ⇔ `ok:`). Save the redacted `report.md` with
the sprint notes. Never commit `raw/` or `run.json`; turn a capture into a fixture only after
replacing addresses and tokens with placeholders (`packages/engine/tests/fixtures-email/`).

## 8. Afterwards

- [ ] Delete the trial messages from your own mailboxes if you like; the staging mailbox keeps them.
- [ ] If anything held real vendor mail in quarantine during a pilot, review it with
      `scripts/quarantine.ts list` / `show` and release only after verifying with the business on a
      number you already know (`release --verified-by … --how …`).
