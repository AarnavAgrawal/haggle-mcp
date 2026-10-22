// Controlled live test of real external replies (Gmail, Outlook, iOS Mail) against the Inkbox buyer
// mailbox. OPERATOR-RUN ONLY, against mailboxes the operator owns. Disabled unless HAGGLE_EMAIL_TRIAL=1,
// every address is listed in HAGGLE_EMAIL_TRIAL_MAILBOXES, and --i-own-this-mailbox is passed.
// It never touches the engine database, never contacts a business, and never parses with Claude:
// replies are evaluated with the engine's own pure inbound functions (inkboxToInbound, matchInbound,
// verifyExternalReply, cleanEmailBody, isOptOut, parseBounce).
//
//   HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me2@outlook.com \
//     node --env-file=.env scripts/email-trial.ts send --to me@gmail.com --run ~/haggle-trials/t1 --i-own-this-mailbox
//   ... reply from the mail clients following the printed checklist ...
//   HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=... node --env-file=.env scripts/email-trial.ts collect --run ~/haggle-trials/t1 --i-own-this-mailbox
//   HAGGLE_EMAIL_TRIAL=1 node --env-file=.env scripts/email-trial.ts check-subscription
//
// send: one clearly-labelled TEST email from the buyer mailbox, carrying a reply token made with a
//   run-local random secret; records the send-time Message-ID in <run>/run.json.
// collect: lists inbound mail since the run started from the trial addresses, fetches each (restoring
//   its unread state: messages.get marks it read), re-lists the outbound test email to compare the
//   send-time and stored Message-IDs, evaluates every reply, and writes <run>/report.json and
//   <run>/report.md (redacted) plus <run>/raw/<id>.json (unredacted captures for future fixtures;
//   the run directory must be outside the repository).
// check-subscription: read-only; reports mail event types the buyer's webhook subscription lacks.
//
// Needs INKBOX_API_KEY and INKBOX_IDENTITY (default "haggle").
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectInkboxTrial } from "@haggle/engine";
import { buildReport, checkSubscriptions, compareMessageIds, evaluateReply, newRun, planTrial, renderMarkdown, SCENARIOS, trialEmail, trialMailboxes, type ReplyEvaluation, type TrialRun } from "./email-trial-lib.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

async function main() {
  const plan = planTrial(process.argv.slice(2), process.env, REPO_ROOT);
  if (!plan.ok) throw new Error(plan.error);
  const apiKey = process.env.INKBOX_API_KEY;
  if (!apiKey) throw new Error("INKBOX_API_KEY is not set");
  const ink = await connectInkboxTrial({ apiKey, handle: process.env.INKBOX_IDENTITY?.trim() || "haggle" });
  const buyer = ink.buyerMailbox;
  const cmd = plan.cmd;

  if (cmd.kind === "check-subscription") {
    console.log(JSON.stringify(checkSubscriptions(await ink.listSubscriptions(), ink.identityId), null, 2));
    return;
  }

  const runFile = join(cmd.runDir, "run.json");
  if (cmd.kind === "send") {
    mkdirSync(cmd.runDir, { recursive: true });
    const run = newRun({ to: cmd.to, buyerMailbox: buyer, now: new Date() });
    const mail = trialEmail(run);
    const sent = await ink.send({ to: [cmd.to], subject: mail.subject, bodyText: mail.bodyText, idempotencyKey: `email-trial:${run.runId}` });
    run.send = { id: sent.id, messageId: sent.messageId, status: sent.status, at: new Date().toISOString(), threadId: sent.threadId ?? null };
    writeFileSync(runFile, JSON.stringify(run, null, 2), { mode: 0o600 });
    console.log(`Sent the TEST email to ${cmd.to} (Inkbox id ${sent.id}). Run state: ${runFile}\n\nAsk the tester to reply in each of these ways:\n${SCENARIOS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\nThen run collect.`);
    return;
  }

  const run = JSON.parse(readFileSync(runFile, "utf8")) as TrialRun;
  if (!run.send) throw new Error("this run has no recorded send");
  if (run.buyerMailbox !== buyer) throw new Error("this run was sent from another buyer mailbox");
  const allowed = new Set(trialMailboxes(process.env));
  if (!allowed.has(run.to)) throw new Error(`${run.to} is no longer in HAGGLE_EMAIL_TRIAL_MAILBOXES`);

  // The outbound test email as the mailbox stores it now (list doesn't mark anything read).
  let stored: string | null = null;
  for await (const m of ink.list({ direction: "outbound", startDatetime: run.startedAt, pageSize: 50 })) {
    if (m.id === run.send.id) { stored = m.messageId; break; }
  }
  const ses = stored !== null ? (await ink.get(run.send.id)).sesMessageId ?? null : null;
  const ids = compareMessageIds(run.send.messageId, stored, ses);

  mkdirSync(join(cmd.runDir, "raw"), { recursive: true });
  const evaluations: ReplyEvaluation[] = [];
  for await (const m of ink.list({ direction: "inbound", startDatetime: run.startedAt, pageSize: 50 })) {
    const from = (m.fromAddress ?? "").toLowerCase();
    if (!m.id || (!allowed.has(from) && !/^(mailer-daemon|postmaster)@/.test(from))) continue;
    const detail = await ink.get(m.id);
    if (m.isRead === false) await ink.markUnread(m.id); // get() marks it read: put it back for the live webhook/sweep
    writeFileSync(join(cmd.runDir, "raw", `${m.id}.json`), JSON.stringify(detail, null, 2), { mode: 0o600 });
    evaluations.push(evaluateReply(detail, run, { sendTime: run.send.messageId, stored, ses }));
  }
  const report = buildReport(run, ids, evaluations.reverse(), new Date());
  writeFileSync(join(cmd.runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(cmd.runDir, "report.md"), renderMarkdown(report));
  console.log(renderMarkdown(report));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/email-trial.ts")) {
  main().catch((e) => {
    console.error(`email-trial: ${(e as Error).message}`);
    process.exit(1);
  });
}
