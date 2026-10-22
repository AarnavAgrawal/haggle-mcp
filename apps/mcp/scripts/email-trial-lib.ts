// Pure logic for scripts/email-trial.ts (a controlled, operator-run test of real Gmail/Outlook/iOS
// replies against the live Inkbox buyer mailbox): the safety gate, the test email, evaluation of each
// captured reply through the engine's real inbound functions, redaction, and the report. No I/O here,
// so tests/emailTrial.test.ts runs it with fakes.
import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  cleanEmailBody, inkboxToInbound, isOptOut, matchInbound, normalizeAddress, normalizeMessageId, parseBounce, replyToken, verifyExternalReply,
  type InkboxMessageDetail,
} from "@haggle/engine";

export const TRIAL_FLAG = "--i-own-this-mailbox";
/** Mail webhook event types the live subscription needs (received: replies; bounced/failed: delivery status). */
export const REQUIRED_EVENT_TYPES = ["message.received", "message.bounced", "message.failed"] as const;
export const OPTIONAL_EVENT_TYPES = ["message.delivered", "message.sent"] as const;

export const SCENARIOS = [
  "Normal reply: press Reply in Gmail web and write a short quote (e.g. \"$1,150 total, $345 deposit\").",
  "Edited subject: reply again but change the subject line completely.",
  "Short reply with the quote deleted: reply, delete all quoted history, keep the subject.",
  "Mobile clients: reply from the Gmail app, the Outlook app, and iOS Mail (one reply each).",
  "Forward then reply from another address: forward the test email to a second trial mailbox, and reply from there.",
  "PDF attachment: reply with a one-page PDF quote attached and a one-line body.",
  "Same reply twice: send the identical reply a second time.",
  "Fresh email with the token pasted: write a NEW email (not Reply) to the buyer address and paste the reference code.",
  "Reply-all: use Reply all (adds any Cc).",
] as const;

export type TrialEnv = { HAGGLE_EMAIL_TRIAL?: string; HAGGLE_EMAIL_TRIAL_MAILBOXES?: string };

export function trialMailboxes(env: TrialEnv): string[] {
  return (env.HAGGLE_EMAIL_TRIAL_MAILBOXES ?? "").split(",").map((s) => normalizeAddress(s)).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

export type Command =
  | { kind: "send"; to: string; runDir: string }
  | { kind: "collect"; runDir: string }
  | { kind: "check-subscription" };

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Parse and gate one invocation. Everything is refused unless HAGGLE_EMAIL_TRIAL=1. send and collect
 * also need --i-own-this-mailbox and every address they touch listed in HAGGLE_EMAIL_TRIAL_MAILBOXES.
 * check-subscription is read-only. A run directory inside the repository is refused (raw captures of
 * real mail must never be committed).
 */
export function planTrial(argv: string[], env: TrialEnv, repoRoot: string): { ok: true; cmd: Command } | { ok: false; error: string } {
  if (env.HAGGLE_EMAIL_TRIAL !== "1") return { ok: false, error: "email trial is disabled: set HAGGLE_EMAIL_TRIAL=1 for this one run" };
  const [sub] = argv;
  if (sub === "check-subscription") return { ok: true, cmd: { kind: "check-subscription" } };
  if (sub !== "send" && sub !== "collect") return { ok: false, error: "usage: email-trial.ts send --to <addr> --run <dir> --i-own-this-mailbox | collect --run <dir> --i-own-this-mailbox | check-subscription" };
  if (!argv.includes(TRIAL_FLAG)) return { ok: false, error: `${sub} needs ${TRIAL_FLAG}: only mailboxes you own may take part` };
  const allowed = trialMailboxes(env);
  if (!allowed.length) return { ok: false, error: "HAGGLE_EMAIL_TRIAL_MAILBOXES is empty: list the trial mailboxes you own (comma-separated)" };
  const runDir = arg(argv, "run");
  if (!runDir) return { ok: false, error: `${sub} needs --run <dir> (outside the repository)` };
  const rel = relative(resolve(repoRoot), resolve(runDir));
  if (!rel.startsWith("..") && !isAbsolute(rel)) return { ok: false, error: "--run must be outside the repository: raw captures of real mail must never be committed" };
  if (sub === "collect") return { ok: true, cmd: { kind: "collect", runDir: resolve(runDir) } };
  const to = normalizeAddress(arg(argv, "to") ?? "");
  if (!to) return { ok: false, error: "send needs --to <addr>" };
  if (!allowed.includes(to)) return { ok: false, error: `${to} is not in HAGGLE_EMAIL_TRIAL_MAILBOXES; refusing to email it` };
  return { ok: true, cmd: { kind: "send", to, runDir: resolve(runDir) } };
}

/** The persisted state of one run (run.json in the run directory; the secret never leaves it). */
export interface TrialRun {
  runId: string;
  startedAt: string;
  buyerMailbox: string;
  to: string;
  /** Run-local random secret for the reply token (not the server's HAGGLE_REPLY_TOKEN_SECRET). */
  secret: string;
  jobId: string;
  businessId: string;
  token: string;
  subject: string;
  send?: { id: string; messageId: string; status: string; at: string; threadId?: string | null };
}

export function newRun(o: { to: string; buyerMailbox: string; now: Date; random?: (n: number) => Buffer }): TrialRun {
  const rnd = o.random ?? randomBytes;
  const runId = `trial-${o.now.toISOString().slice(0, 10)}-${rnd(4).toString("hex")}`;
  const secret = rnd(32).toString("hex");
  const jobId = `job_${runId}`;
  const businessId = `biz_${rnd(4).toString("hex")}`;
  const token = replyToken(secret, jobId, businessId);
  return { runId, startedAt: o.now.toISOString(), buyerMailbox: normalizeAddress(o.buyerMailbox), to: o.to, secret, jobId, businessId, token, subject: `[HAGGLE TEST] Reply-handling trial (ref ${token})` };
}

/** The one clearly-labelled TEST email: no purchase, explains itself, carries the token like a real RFQ. */
export function trialEmail(run: TrialRun): { subject: string; bodyText: string } {
  return {
    subject: run.subject,
    bodyText: [
      "THIS IS A TEST from the Haggle operator. Nothing is being bought and no business is involved.",
      "",
      "It checks how real mail clients reply to Haggle's email. Please reply to this message in each of the ways listed below (one reply per scenario), then tell the operator you are done.",
      "",
      ...SCENARIOS.map((s, i) => `${i + 1}. ${s}`),
      "",
      "Example quote text to use in a reply: \"We can do it: $1,150 total, delivered. $345 deposit.\"",
      "",
      `Reference: ${run.token} (please keep it when you reply)`,
      `Run: ${run.runId}`,
    ].join("\n"),
  };
}

/** Message-IDs: what send() returned vs what the mailbox stores now (and the SES id). If they differ, real replies fail not_in_our_thread. */
export function compareMessageIds(sendTime: string, stored: string | null, ses: string | null) {
  const n = (s: string | null) => (s ? normalizeMessageId(s) : null);
  const sendN = n(sendTime);
  return {
    send_time: sendTime, stored, ses_message_id: ses,
    send_time_equals_stored: stored !== null && sendN === n(stored),
    send_time_mentions_ses_id: !!ses && !!sendN && sendN.includes(ses.toLowerCase().replace(/[<>]/g, "").split("@")[0]!),
    verdict: stored === null ? "outbound message not found when listing the mailbox" : sendN === n(stored) ? "OK: the Message-ID the engine stores at send time is the one replies reference" : "MISMATCH: the engine stores the send-time id, but the mailbox (and recipients) see another; every external reply would fail not_in_our_thread",
  };
}

export interface ReplyEvaluation {
  id: string;
  from: string;
  subject: string | null;
  created_at: string | null;
  body_source: "text" | "html" | "none";
  match: string;
  verdict: string;
  /** Verdict when the thread check uses every id we know (send-time, stored, SES): differs only if the ids differ. */
  verdict_any_known_id: string;
  token_in_subject: boolean;
  token_in_body: boolean;
  token_in_own_words: boolean;
  in_reply_to_ours: boolean;
  references_ours: boolean;
  quoted_history_cut: boolean;
  own_words_preview: string;
  opt_out: boolean;
  bounce: boolean;
  attachments: { filename: string; content_type: string; size: number }[];
  notes: string[];
}

/** Run one captured reply through the engine's real inbound functions, as the webhook would. */
export function evaluateReply(detail: InkboxMessageDetail, run: TrialRun, ids: { sendTime: string; stored: string | null; ses: string | null }): ReplyEvaluation {
  const msg = inkboxToInbound({ id: `trial:${detail.id}`, event_type: "message.received" }, detail);
  const from = msg.from ?? "";
  const ourSend = ids.sendTime;
  const known = [ids.sendTime, ids.stored, ids.ses ? `<${ids.ses.replace(/[<>]/g, "")}@email.amazonses.com>` : null];
  const match = matchInbound(
    { to: msg.to, threadId: msg.threadId, inReplyTo: msg.inReplyTo, references: msg.references, subject: msg.subject, from },
    [{ businessId: run.businessId, jobId: run.jobId, shortCode: "TEST", email: run.to, threadId: run.send?.threadId ?? null, outboundMessageId: ourSend }],
  );
  const verify = (ours: (string | null)[]) => {
    const v = verifyExternalReply({ from, pinned: run.to, inReplyTo: msg.inReplyTo, references: msg.references, ourMessageIds: ours, subject: msg.subject, bodyText: msg.bodyText, token: run.token, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
    return v.ok ? `ok:${v.reason}` : `${v.reason}:${v.detail}`;
  };
  const body = msg.bodyText ?? "";
  const own = cleanEmailBody(body);
  const ourIds = new Set(known.filter((x): x is string => !!x).map(normalizeMessageId));
  const tok = run.token.toUpperCase();
  const notes: string[] = [];
  const bodySource = detail.bodyText?.trim() ? "text" : detail.bodyHtml?.trim() ? "html" : "none";
  if (bodySource === "html") notes.push("HTML-only message: body derived from HTML");
  if (own !== body.trim() && own.length < body.trim().length) notes.push("quoted history removed before parsing");
  if (own === body.trim() && /^>|wrote:|From:/m.test(body)) notes.push("CHECK: body looks quoted but nothing was cut");
  const subjectHas = (msg.subject ?? "").toUpperCase().includes(tok);
  const ownHas = own.toUpperCase().includes(tok);
  if (!subjectHas && body.toUpperCase().includes(tok) && !ownHas) notes.push("token only in quoted text");
  return {
    id: detail.id, from, subject: msg.subject, created_at: detail.createdAt ? new Date(detail.createdAt).toISOString() : null, body_source: bodySource,
    match: match.kind === "unmatched" || match.kind === "quarantine" ? `${match.kind}:${match.reason}` : `${match.kind}:${match.via}`,
    verdict: verify([ourSend]), verdict_any_known_id: verify(known),
    token_in_subject: subjectHas, token_in_body: body.toUpperCase().includes(tok), token_in_own_words: ownHas,
    in_reply_to_ours: msg.inReplyTo.some((x) => ourIds.has(normalizeMessageId(x))), references_ours: msg.references.some((x) => ourIds.has(normalizeMessageId(x))),
    quoted_history_cut: own.length < body.trim().length, own_words_preview: own.slice(0, 400),
    opt_out: isOptOut(body), bounce: parseBounce(msg) !== null,
    attachments: msg.attachments.map((a) => ({ filename: a.filename ?? "", content_type: a.contentType, size: a.sizeBytes })), notes,
  };
}

/** Mask personal data for the shareable report: mailbox local parts, phone numbers, the token, long digit runs. Raw captures stay local. */
export function redact(text: string, run?: Pick<TrialRun, "token" | "secret">): string {
  let t = text;
  if (run) t = t.split(run.token).join("HGR-<token>").split(run.secret).join("<secret>");
  return t
    .replace(/HGR-[A-HJ-NP-Z2-9]{10}/gi, "HGR-<token>")
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "<number>");
}

export interface TrialReport {
  run: { runId: string; startedAt: string; collectedAt: string; buyerMailbox: string; to: string };
  message_ids: ReturnType<typeof compareMessageIds>;
  replies: ReplyEvaluation[];
  summary: { replies: number; verified: number; quarantined: Record<string, number>; html_only: number; token_only_in_quotes: number };
  scenarios: readonly string[];
}

export function buildReport(run: TrialRun, ids: ReturnType<typeof compareMessageIds>, replies: ReplyEvaluation[], now: Date): TrialReport {
  const quarantined: Record<string, number> = {};
  for (const r of replies) if (!r.verdict.startsWith("ok:")) quarantined[r.verdict] = (quarantined[r.verdict] ?? 0) + 1;
  const red = (s: string) => redact(s, run);
  return {
    run: { runId: run.runId, startedAt: run.startedAt, collectedAt: now.toISOString(), buyerMailbox: red(run.buyerMailbox), to: red(run.to) },
    message_ids: ids,
    replies: replies.map((r) => ({ ...r, from: red(r.from), subject: r.subject === null ? null : red(r.subject), own_words_preview: red(r.own_words_preview), notes: r.notes.map(red) })),
    summary: { replies: replies.length, verified: replies.filter((r) => r.verdict.startsWith("ok:")).length, quarantined, html_only: replies.filter((r) => r.body_source === "html").length, token_only_in_quotes: replies.filter((r) => r.notes.includes("token only in quoted text")).length },
    scenarios: SCENARIOS,
  };
}

export function renderMarkdown(r: TrialReport): string {
  const yes = (b: boolean) => (b ? "yes" : "no");
  return [
    `# Email trial ${r.run.runId}`,
    "",
    `Started ${r.run.startedAt}, collected ${r.run.collectedAt}. Buyer ${r.run.buyerMailbox}, trial recipient ${r.run.to}.`,
    "",
    "## Message-ID at send time vs stored",
    "",
    `- ${r.message_ids.verdict}`,
    `- send-time id equals stored: ${yes(r.message_ids.send_time_equals_stored)}`,
    "",
    "## Summary",
    "",
    `- replies: ${r.summary.replies}; verified: ${r.summary.verified}; HTML-only: ${r.summary.html_only}; token only in quoted text: ${r.summary.token_only_in_quotes}`,
    ...Object.entries(r.summary.quarantined).map(([k, v]) => `- quarantined ${k}: ${v}`),
    "",
    "## Replies",
    "",
    "| # | from | verdict | match | token subj/body/own | in-reply-to ours | cut quotes | body | notes |",
    "|---|---|---|---|---|---|---|---|---|",
    ...r.replies.map((x, i) => `| ${i + 1} | ${x.from} | ${x.verdict}${x.verdict_any_known_id !== x.verdict ? ` (any id: ${x.verdict_any_known_id})` : ""} | ${x.match} | ${yes(x.token_in_subject)}/${yes(x.token_in_body)}/${yes(x.token_in_own_words)} | ${yes(x.in_reply_to_ours)} | ${yes(x.quoted_history_cut)} | ${x.body_source} | ${x.notes.join("; ").replace(/\|/g, "/")} |`),
    "",
    "## Scenario checklist",
    "",
    ...r.scenarios.map((s) => `- [ ] ${s}`),
    "",
  ].join("\n");
}

/** Read-only: which required mail event types each subscription of the buyer identity lacks. */
export function checkSubscriptions(subs: { id: string; url: string; eventTypes: string[]; status?: string; agentIdentityId?: string | null; ownerIdentityId?: string | null }[], buyerIdentityId: string | null) {
  const mine = subs.filter((s) => !buyerIdentityId || s.agentIdentityId === buyerIdentityId || s.ownerIdentityId === buyerIdentityId);
  const rows = mine.map((s) => ({
    id: s.id, url: redactUrl(s.url), status: s.status ?? "unknown",
    missing_required: REQUIRED_EVENT_TYPES.filter((t) => !s.eventTypes.includes(t)),
    missing_optional: OPTIONAL_EVENT_TYPES.filter((t) => !s.eventTypes.includes(t)),
  }));
  const ok = rows.some((r) => r.missing_required.length === 0);
  return { subscriptions: rows, ok, advice: ok ? "A subscription covers message.received, message.bounced and message.failed." : rows.length ? `Add ${[...new Set(rows.flatMap((r) => r.missing_required))].join(", ")} to the buyer's webhook subscription (subscriptions.update with the full eventTypes list); until then bounces are found only by the reconciler's outbound status sweep.` : "No webhook subscription for the buyer identity." };
}

/** Webhook URLs can carry a secret path segment: keep only the origin and the first path segment. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const first = u.pathname.split("/").filter(Boolean)[0];
    return `${u.origin}/${first ?? ""}${u.pathname.split("/").filter(Boolean).length > 1 ? "/…" : ""}`;
  } catch {
    return "<invalid url>";
  }
}
