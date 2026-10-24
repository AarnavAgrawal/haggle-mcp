// The email trial's two Inkbox flows, send and collect, with the mailbox injected (the shape
// connectInkboxTrial returns) so tests run them against a fake and a temporary directory. Called by
// email-trial.ts only after every gate passed (email-trial-lib.ts planTrial).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InkboxListedMessage, InkboxMessageDetail } from "@haggle/engine";
import {
  buildReport, checkSubscriptions, compareMessageIds, diagnoseWebhook, evaluateReply, newRun, plannedSend, renderMarkdown, scrubSecrets, strictAddress, withPipeline,
  type ReplyEvaluation, type TrialReport, type TrialRun,
} from "./email-trial-lib.ts";
import { replayCaptures } from "./email-trial-replay.ts";

/** The slice of connectInkboxTrial's result the flows use. */
export interface TrialMailbox {
  buyerMailbox: string;
  identityId: string | null;
  send(o: { to: string[]; subject: string; bodyText: string; idempotencyKey: string }): Promise<{ id: string; messageId: string; status: string; threadId?: string | null }>;
  list(o: { direction: "inbound" | "outbound"; startDatetime: string; pageSize?: number }): AsyncIterable<InkboxListedMessage & { isRead?: boolean }>;
  get(id: string): Promise<InkboxMessageDetail>;
  markUnread(id: string): Promise<void>;
  listSubscriptions(): Promise<{ id: string; url: string; eventTypes: string[]; status?: string; agentIdentityId?: string | null; ownerIdentityId?: string | null }[]>;
}

/** Write a file only its owner can read (the mode is applied even when the file already existed). */
export function writePrivate(path: string, data: string, flag: "w" | "wx" = "w") {
  writeFileSync(path, data, { mode: 0o600, flag });
  chmodSync(path, 0o600);
}
export function mkdirPrivate(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * One-shot send. run.json is created exclusively (flag wx) BEFORE the send call, so a second
 * invocation, a concurrent one, or a retry after a crash finds it and refuses without sending. A
 * failed call is recorded (sendState "failed"); collect then looks for the email in the outbound
 * mailbox rather than anyone sending again. The provider idempotency key is fixed per run.
 */
export async function sendOnce(ink: Pick<TrialMailbox, "buyerMailbox" | "send">, o: { to: string; runDir: string; now?: Date; scrub?: (s: string) => string }): Promise<TrialRun> {
  const scrub = o.scrub ?? ((s: string) => s);
  const to = strictAddress(o.to);
  if (!to) throw new Error("--to is not one plain address. Fix: give exactly one bare address.");
  if (to === ink.buyerMailbox) throw new Error("--to is the buyer mailbox itself. Fix: send to a trial mailbox you own.");
  const runFile = join(o.runDir, "run.json");
  mkdirPrivate(o.runDir);
  const run = newRun({ to, buyerMailbox: ink.buyerMailbox, now: o.now ?? new Date() });
  try {
    writePrivate(runFile, JSON.stringify({ ...run, sendState: "pending" }, null, 2), "wx");
  } catch {
    throw new Error(`${runFile} already exists: this directory holds a run, so nothing was sent. Fix: use a new --run directory (collect reads this one).`);
  }
  const mail = plannedSend(run);
  let sent: Awaited<ReturnType<TrialMailbox["send"]>>;
  try {
    sent = await ink.send({ to: mail.to, subject: mail.subject, bodyText: mail.bodyText, idempotencyKey: mail.idempotencyKey });
  } catch (e) {
    const why = scrubSecrets(scrub((e as Error).message ?? String(e)), [run.secret, run.token]).slice(0, 300);
    writePrivate(runFile, JSON.stringify({ ...run, sendState: "failed", sendError: why }, null, 2));
    throw new Error(`the send call failed (${why.slice(0, 200)}). It may or may not have gone out: don't send again from another directory yet. Fix: run collect on this --run directory; it finds the test email in the outbound mailbox if it was sent.`);
  }
  const done: TrialRun = { ...run, sendState: "sent", send: { id: sent.id, messageId: sent.messageId, status: sent.status, at: new Date().toISOString(), threadId: sent.threadId ?? null } };
  writePrivate(runFile, JSON.stringify(done, null, 2));
  return done;
}

export interface CollectResult { report: TrialReport; markdown: string; skipped: { not_allowlisted: number; bounces: number }; warnings: string[] }

/**
 * Read (never send) the run's replies: only mail FROM an allowlisted trial mailbox is opened
 * (delivery notices from mailer-daemon/postmaster only with includeBounces); every other message is
 * skipped unopened. Each opened message's unread state is restored. Writes raw/<id>.json, report.json
 * and report.md, all 0600 in a 0700 directory.
 */
export async function collectRun(ink: TrialMailbox, o: { runDir: string; allowed: string[]; includeBounces: boolean; now?: Date; scrub?: (s: string) => string }): Promise<CollectResult> {
  const scrub = o.scrub ?? ((s: string) => s);
  const runFile = join(o.runDir, "run.json");
  const run = JSON.parse(readFileSync(runFile, "utf8")) as TrialRun;
  if (run.buyerMailbox !== ink.buyerMailbox) throw new Error("this run was sent from another buyer mailbox. Fix: use the INKBOX_IDENTITY and key the run was sent with.");
  const allowed = new Set(o.allowed);
  if (!allowed.has(strictAddress(run.to) ?? "")) throw new Error("the run's recipient is no longer in HAGGLE_EMAIL_TRIAL_MAILBOXES. Fix: add it back exactly.");
  const warnings: string[] = [];

  // The outbound test email as the mailbox stores it now (listing marks nothing read). A send whose
  // result wasn't recorded is recovered here by its unique subject.
  let stored: string | null = null;
  for await (const m of ink.list({ direction: "outbound", startDatetime: run.startedAt, pageSize: 50 })) {
    if (!m.id || !(run.send ? m.id === run.send.id : m.subject === run.subject)) continue;
    stored = m.messageId;
    if (!run.send) {
      run.send = { id: m.id, messageId: m.messageId, status: m.status ?? "unknown", at: m.createdAt ? new Date(m.createdAt).toISOString() : new Date().toISOString(), threadId: null, recovered: true };
      run.sendState = "sent";
      writePrivate(runFile, JSON.stringify(run, null, 2));
      warnings.push("the send result wasn't recorded: the test email was found in the outbound mailbox and recorded now (its send-time Message-ID is unknown; the stored one stands in)");
    }
    break;
  }
  if (!run.send) throw new Error("no recorded send, and the test email isn't in the outbound mailbox: nothing was sent from this run. Fix: send again with a new --run directory.");
  let ses: string | null = null;
  if (stored !== null) {
    try { ses = (await ink.get(run.send.id)).sesMessageId ?? null; } catch (e) { warnings.push(`couldn't read the outbound message's SES id (${scrub((e as Error).message).slice(0, 120)})`); }
  }
  const ids = compareMessageIds(run.send.messageId, stored, ses);

  let subHas: boolean | null = null;
  let subLine: string;
  try {
    const s = checkSubscriptions(await ink.listSubscriptions(), ink.identityId);
    subHas = s.has_message_received;
    subLine = `${s.has_message_received ? "has message.received" : "NO message.received: Inkbox sends no webhook for replies"}; ${s.advice}`;
  } catch (e) {
    subLine = `couldn't be read (${scrub((e as Error).message).slice(0, 160)}); run check-subscription`;
  }

  mkdirPrivate(o.runDir);
  mkdirPrivate(join(o.runDir, "raw"));
  const evaluations: ReplyEvaluation[] = [];
  const captures: InkboxMessageDetail[] = [];
  const skipped = { not_allowlisted: 0, bounces: 0 };
  for await (const m of ink.list({ direction: "inbound", startDatetime: run.startedAt, pageSize: 50 })) {
    if (!m.id) continue;
    const from = strictAddress(m.fromAddress) ?? "";
    const dsn = /^(mailer-daemon|postmaster)@/.test(from);
    if (dsn && !o.includeBounces) { skipped.bounces++; continue; }
    if (!dsn && !allowed.has(from)) { skipped.not_allowlisted++; continue; } // never opened: not the trial's to read
    const detail = await ink.get(m.id);
    // get() marks it read: put it back unless the listing said it was already read.
    if (m.isRead !== true) {
      try { await ink.markUnread(m.id); } catch (e) { warnings.push(`couldn't restore ${m.id} to unread (${scrub((e as Error).message).slice(0, 120)})`); }
    }
    writePrivate(join(o.runDir, "raw", `${m.id}.json`), JSON.stringify(detail, null, 2));
    captures.push(detail);
    evaluations.push(evaluateReply(detail, run, { sendTime: run.send.messageId, stored, ses }, diagnoseWebhook({ subscriptionHasReceived: subHas, isRead: m.isRead, id: m.id })));
  }
  // Oldest first, through the real pipeline offline (what the server would have done with each).
  const replays = await replayCaptures(run, [...captures].reverse());
  const report = buildReport(run, ids, withPipeline(evaluations.reverse(), replays), o.now ?? new Date(), { subscription: subLine });
  const markdown = renderMarkdown(report);
  writePrivate(join(o.runDir, "report.json"), JSON.stringify(report, null, 2));
  writePrivate(join(o.runDir, "report.md"), markdown);
  return { report, markdown, skipped, warnings };
}

/** Read run.json if present (dry-run). */
export function readRun(runDir: string): TrialRun | null {
  const p = join(runDir, "run.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as TrialRun; } catch { return null; }
}
