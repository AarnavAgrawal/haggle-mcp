// Pure logic for scripts/email-trial.ts (a controlled, operator-run test of real Gmail/Outlook/iOS
// replies against a STAGING Inkbox buyer mailbox): the gates (every prerequisite checked before any
// network call), the test email, evaluation and diagnosis of each captured reply through the engine's
// real inbound functions, redaction, and the report. No I/O here: the file system is reached through
// an injected probe, so tests/emailTrial*.test.ts run it with fakes.
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  cleanEmailBody, explainQuarantine, inkboxToInbound, isOptOut, matchInbound, normalizeAddress, normalizeMessageId, parseBounce, replyToken, verifyExternalReply,
  type InkboxMessageDetail,
} from "@haggle/engine";

export const TRIAL_FLAG = "--i-own-this-mailbox";
/** collect reads delivery-failure notices (mailer-daemon, postmaster) only with this flag. */
export const BOUNCES_FLAG = "--include-bounces";
/** The deal tag the test email carries like a real RFQ ([HG-<code>]), so matching behaves as it does live. */
export const TRIAL_CODE = "TRIAL";
/** Mail webhook event types the live subscription needs (received: replies; bounced/failed: delivery status). */
export const REQUIRED_EVENT_TYPES = ["message.received", "message.bounced", "message.failed"] as const;
export const OPTIONAL_EVENT_TYPES = ["message.delivered", "message.sent"] as const;
/** Inkbox handles of production buyer identities: the trial refuses them (the env manifest's INKBOX_IDENTITY default). */
export const PRODUCTION_IDENTITY_HANDLES = ["haggle"] as const;
/** At most this many trial mailboxes may be allowlisted (one person's own addresses, not a list). */
export const MAX_TRIAL_MAILBOXES = 5;
/** What the offline reader is: never confuse it with the live server's Claude reading. */
export const KEYWORD_READER = "keyword reading (offline heuristic, not Claude)";

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

export type TrialEnv = {
  HAGGLE_EMAIL_TRIAL?: string; HAGGLE_EMAIL_TRIAL_MAILBOXES?: string; HAGGLE_ENV?: string;
  INKBOX_API_KEY?: string; INKBOX_IDENTITY?: string; INKBOX_WEBHOOK_SECRET?: string;
};

// ---------------------------------------------------------------------------------------------
// Addresses: exact, plain-ASCII, normalized only by trimming and lower-casing.
// ---------------------------------------------------------------------------------------------

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * A single plain address, trimmed and lower-cased, or null. Refused: anything non-ASCII (look-alike
 * letters), display names, lists, spaces, a trailing dot, empty labels. No plus-tag or dot folding:
 * `me+x@gmail.com` and `me@gmail.com` are different trial mailboxes.
 */
export function strictAddress(input: string | null | undefined): string | null {
  const s = (input ?? "").trim().toLowerCase();
  if (!s || /[^\x21-\x7e]/.test(s) || !ADDRESS.test(s)) return null;
  const [local, domain] = s.split("@") as [string, string];
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const labels = domain.split(".");
  if (labels.some((l) => !l || l.startsWith("-") || l.endsWith("-")) || !/^[a-z]{2,}$/.test(labels.at(-1)!)) return null;
  return s;
}

export function parseAllowlist(env: TrialEnv): { allowed: string[]; rejected: string[]; tooMany: boolean } {
  const raw = (env.HAGGLE_EMAIL_TRIAL_MAILBOXES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const r of raw) {
    const a = strictAddress(r);
    if (a === null) rejected.push(r);
    else if (!allowed.includes(a)) allowed.push(a);
  }
  return { allowed, rejected, tooMany: allowed.length > MAX_TRIAL_MAILBOXES };
}

/** The allowlisted trial mailboxes (exact addresses). */
export function trialMailboxes(env: TrialEnv): string[] {
  return parseAllowlist(env).allowed;
}

// ---------------------------------------------------------------------------------------------
// Commands and gates.
// ---------------------------------------------------------------------------------------------

export type Command =
  | { kind: "send"; to: string; runDir: string }
  | { kind: "collect"; runDir: string; includeBounces: boolean }
  | { kind: "check-subscription" }
  /** No network, no Inkbox, nothing written: configuration checks only. */
  | { kind: "validate"; runDir: string | null; to: string | null }
  /** No network, nothing written: the exact test email `send` would build, and an offline replay of the run's captures. */
  | { kind: "dry-run"; to: string; runDir: string; buyer: string | null };

/** The commands that contact Inkbox; each passes every one of its gates first. */
export type NetworkKind = "send" | "collect" | "check-subscription";

export const USAGE = "usage: email-trial.ts validate [--run <dir>] [--to <addr>] | dry-run --to <addr> --run <dir> [--buyer <addr>] | send --to <addr> --run <dir> --i-own-this-mailbox | collect --run <dir> --i-own-this-mailbox [--include-bounces] | check-subscription";

function arg(argv: string[], name: string): { value?: string; repeated: boolean } {
  const at = argv.flatMap((a, i) => (a === `--${name}` ? [i] : []));
  return { value: at.length ? argv[at[0]! + 1] : undefined, repeated: at.length > 1 };
}

/** Parse one invocation (arguments only; the gates are trialChecks). */
export function parseTrialArgs(argv: string[]): { ok: true; cmd: Command } | { ok: false; error: string } {
  const [sub] = argv;
  for (const n of ["to", "run", "buyer"]) if (arg(argv, n).repeated) return { ok: false, error: `--${n} is given twice: give exactly one` };
  const runRaw = arg(argv, "run").value;
  const runDir = runRaw && !runRaw.startsWith("--") ? resolve(runRaw) : null;
  const toRaw = arg(argv, "to").value;
  if (sub === "validate") return { ok: true, cmd: { kind: "validate", runDir, to: toRaw ? toRaw.trim().toLowerCase() : null } };
  if (sub === "dry-run") {
    const to = strictAddress(toRaw);
    if (!runDir || !to) return { ok: false, error: "dry-run needs --to <one plain address> and --run <dir> (outside the repository)" };
    const buyer = arg(argv, "buyer").value;
    return { ok: true, cmd: { kind: "dry-run", to, runDir, buyer: buyer ? buyer.trim().toLowerCase() : null } };
  }
  if (sub === "check-subscription") return { ok: true, cmd: { kind: "check-subscription" } };
  if (sub === "collect") {
    if (!runDir) return { ok: false, error: "collect needs --run <dir> (the directory send used, outside the repository)" };
    return { ok: true, cmd: { kind: "collect", runDir, includeBounces: argv.includes(BOUNCES_FLAG) } };
  }
  if (sub === "send") {
    if (!runDir) return { ok: false, error: "send needs --run <dir> (a new directory outside the repository)" };
    if (!toRaw) return { ok: false, error: "send needs --to <addr> (one of HAGGLE_EMAIL_TRIAL_MAILBOXES)" };
    return { ok: true, cmd: { kind: "send", to: toRaw.trim().toLowerCase(), runDir } };
  }
  return { ok: false, error: USAGE };
}

/** The file system, read-only, as the gates see it. */
export type FsProbe = {
  exists(p: string): boolean;
  writable(p: string): boolean;
  list(p: string): string[];
  /** Permission bits (mode & 0o777), or null if it doesn't exist. */
  mode(p: string): number | null;
  /** Symlink-free absolute path of an existing path (null if it doesn't exist). */
  realpath(p: string): string | null;
  /** A small text file's contents (null if missing or unreadable). */
  read(p: string): string | null;
};

/** No files at all (tests; and the default when no probe is given). */
export const EMPTY_FS: FsProbe = { exists: () => false, writable: () => true, list: () => [], mode: () => null, realpath: () => null, read: () => null };

export type CheckStatus = "ok" | "FAIL" | "BLOCKED" | "info";
/** FAIL: set but wrong or unsafe. BLOCKED: a prerequisite is missing. Both refuse the command. */
export interface Check { check: string; status: CheckStatus; detail: string; fix?: string }

/** The real location of `dir`: its nearest existing ancestor's realpath plus the rest (so a symlink can't hide the repository). */
export function realLocation(dir: string, fs: FsProbe): string {
  let base = resolve(dir);
  const rest: string[] = [];
  for (;;) {
    const real = fs.realpath(base);
    if (real) return resolve(real, ...rest.reverse());
    const parent = resolve(base, "..");
    if (parent === base) return resolve(dir);
    rest.push(base.slice(parent.length).replace(/^[\\/]/, ""));
    base = parent;
  }
}

export function outsideRepo(dir: string, repoRoot: string, fs: FsProbe = EMPTY_FS): boolean {
  const roots = [resolve(repoRoot), fs.realpath(repoRoot)].filter((x): x is string => !!x);
  const dirs = [resolve(dir), realLocation(dir, fs)];
  return dirs.every((d) => roots.every((r) => {
    const rel = relative(r, d);
    return rel.startsWith("..") || isAbsolute(rel);
  }));
}

const isProductionHandle = (h: string) => (PRODUCTION_IDENTITY_HANDLES as readonly string[]).includes(h.toLowerCase());
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fmtMode = (m: number) => `0${m.toString(8).padStart(3, "0")}`;

/**
 * Every prerequisite of one network command, each ok / FAIL / BLOCKED (info lines refuse nothing),
 * with the exact env var NAME or step that fixes it. Values of secrets are never shown.
 */
export function trialChecks(kind: NetworkKind, o: { runDir: string | null; to: string | null }, env: TrialEnv, argv: string[], repoRoot: string, fs: FsProbe, sdk: string | null): Check[] {
  const out: Check[] = [];
  const add = (check: string, status: CheckStatus, detail: string, fix?: string) => out.push({ check, status, detail, ...(fix && status !== "ok" && status !== "info" ? { fix } : {}) });

  add("HAGGLE_EMAIL_TRIAL", env.HAGGLE_EMAIL_TRIAL === "1" ? "ok" : "BLOCKED", env.HAGGLE_EMAIL_TRIAL === "1" ? "1 (this invocation only)" : `${env.HAGGLE_EMAIL_TRIAL ? "not 1" : "not set"}: the email trial is disabled (every Inkbox call is refused)`, "prefix the one command with HAGGLE_EMAIL_TRIAL=1 (never put it in an env file)");

  const he = env.HAGGLE_ENV?.trim().toLowerCase() ?? "";
  if (he === "staging") add("HAGGLE_ENV", "ok", "staging");
  else if (he === "production") add("HAGGLE_ENV", "FAIL", "production: the email trial never runs against production", "run it from a staging shell with HAGGLE_ENV=staging and the staging Inkbox key and identity");
  else if (!he) add("HAGGLE_ENV", "BLOCKED", "not set: the trial runs only with HAGGLE_ENV=staging", "set HAGGLE_ENV=staging (in the staging env file passed with --env-file)");
  else add("HAGGLE_ENV", "FAIL", `"${he}": the trial runs only with HAGGLE_ENV=staging`, "set HAGGLE_ENV=staging");

  add("INKBOX_API_KEY", env.INKBOX_API_KEY?.trim() ? "ok" : "BLOCKED", env.INKBOX_API_KEY?.trim() ? "set (value not shown)" : "not set", "set INKBOX_API_KEY to the staging Inkbox org's API key (staging env file)");

  const handle = env.INKBOX_IDENTITY?.trim() ?? "";
  if (!handle) add("INKBOX_IDENTITY", "BLOCKED", `not set: the default handle "${PRODUCTION_IDENTITY_HANDLES[0]}" is the production buyer, so the trial needs an explicit staging identity`, "create a staging identity in Inkbox (its own mailbox) and set INKBOX_IDENTITY=<its handle>");
  else if (!HANDLE.test(handle)) add("INKBOX_IDENTITY", "FAIL", "not an Inkbox handle (letters, digits, . _ -)", "set INKBOX_IDENTITY to the staging identity's handle exactly as Inkbox shows it");
  else if (isProductionHandle(handle)) add("INKBOX_IDENTITY", "FAIL", `"${handle}" is the production buyer identity: refused`, "create a staging identity in Inkbox and set INKBOX_IDENTITY=<its handle>");
  else add("INKBOX_IDENTITY", "ok", `"${handle}" (not a production handle)`);

  add("INKBOX_WEBHOOK_SECRET", "info", `${env.INKBOX_WEBHOOK_SECRET?.trim() ? "set" : "not set"} (value not shown): the trial doesn't need it (its offline replay signs with a local key); the staging SERVER needs it to accept message.received`);
  add("@inkbox/sdk", sdk ? "ok" : "BLOCKED", sdk ? `installed locally: ${sdk} (not contacted)` : "not installed", "run npm install from the repository root");
  if (kind === "check-subscription") return out;

  const list = parseAllowlist(env);
  if (list.rejected.length) add("HAGGLE_EMAIL_TRIAL_MAILBOXES", "FAIL", `${list.rejected.length} entr${list.rejected.length === 1 ? "y is" : "ies are"} not one plain ASCII address (display names, non-ASCII look-alike letters, lists and typos are refused)`, "list bare addresses only, comma-separated: me@gmail.com,me@outlook.com");
  else if (!list.allowed.length) add("HAGGLE_EMAIL_TRIAL_MAILBOXES", "BLOCKED", "empty", "set HAGGLE_EMAIL_TRIAL_MAILBOXES to the trial mailboxes you own, comma-separated");
  else if (list.tooMany) add("HAGGLE_EMAIL_TRIAL_MAILBOXES", "FAIL", `${list.allowed.length} mailboxes: at most ${MAX_TRIAL_MAILBOXES}`, `list at most ${MAX_TRIAL_MAILBOXES} of your own mailboxes`);
  else add("HAGGLE_EMAIL_TRIAL_MAILBOXES", "ok", `${list.allowed.length} mailbox(es): ${list.allowed.map((a) => redact(a)).join(", ")}`);

  add(TRIAL_FLAG, argv.includes(TRIAL_FLAG) ? "ok" : "BLOCKED", argv.includes(TRIAL_FLAG) ? "given" : "not given", `add ${TRIAL_FLAG} (only mailboxes you own may take part)`);

  if (kind === "send") {
    const to = strictAddress(o.to);
    if (o.to === null) add("--to", "BLOCKED", "not given", "add --to <one of HAGGLE_EMAIL_TRIAL_MAILBOXES>");
    else if (!to) add("--to", "FAIL", "not one plain ASCII address", "give exactly one bare address, e.g. --to me@gmail.com");
    else if (!list.allowed.includes(to)) add("--to", "FAIL", `${redact(to)} is not an exact entry of HAGGLE_EMAIL_TRIAL_MAILBOXES (no plus-tag or look-alike matching)`, "add the exact address to HAGGLE_EMAIL_TRIAL_MAILBOXES, only if you own it");
    else add("--to", "ok", "listed exactly in HAGGLE_EMAIL_TRIAL_MAILBOXES");
  }

  if (o.runDir === null) {
    add("--run", "BLOCKED", "not given", `add --run <dir> outside the repository (${kind === "send" ? "a new directory" : "the directory send used"})`);
    return out;
  }
  if (!outsideRepo(o.runDir, repoRoot, fs)) {
    add("--run", "FAIL", "inside the repository (directly or through a symlink): raw captures of real mail must never be committed", "use a directory outside the repository, e.g. ~/haggle-trials/<date>-gmail");
    return out;
  }
  const exists = fs.exists(o.runDir);
  const mode = exists ? fs.mode(o.runDir) : null;
  if (exists && !fs.writable(o.runDir)) add("--run", "FAIL", "exists but is not writable", "pick another directory");
  else if (mode !== null && (mode & 0o077) !== 0) add("--run", "FAIL", `exists with mode ${fmtMode(mode)}: other users can read it`, `chmod 700 ${o.runDir}`);
  else add("--run", "ok", exists ? `outside the repository, private (${mode === null ? "mode unknown" : fmtMode(mode)})` : "outside the repository; send creates it with mode 0700");

  const runFile = join(o.runDir, "run.json");
  const hasRun = exists && fs.exists(runFile);
  const runMode = hasRun ? fs.mode(runFile) : null;
  if (runMode !== null && (runMode & 0o077) !== 0) add("run.json", "FAIL", `mode ${fmtMode(runMode)}: it holds the run's token secret`, `chmod 600 ${runFile}`);
  if (kind === "send") {
    if (hasRun) add("run state", "FAIL", "this directory already holds a run (sent, or a send that was started): send is one-shot", "use a new --run directory for another send; collect reads this one");
    else add("run state", "ok", "no run yet: send records it in run.json (mode 0600) before sending");
    return out;
  }
  if (!hasRun) {
    add("run state", "BLOCKED", "no run.json here: nothing was sent from this directory", "run send with this --run first, or point --run at the directory send used");
    return out;
  }
  let run: TrialRun | null = null;
  try { run = JSON.parse(fs.read(runFile) ?? "") as TrialRun; } catch { /* reported below */ }
  if (!run || typeof run !== "object" || !run.runId || !run.token || !run.secret) {
    add("run state", "FAIL", "run.json is unreadable or not a trial run", "point --run at the directory send used");
    return out;
  }
  if (!strictAddress(run.to) || !list.allowed.includes(strictAddress(run.to)!)) add("run state", "FAIL", `the run's recipient ${redact(run.to ?? "")} is no longer in HAGGLE_EMAIL_TRIAL_MAILBOXES`, "add it back (exactly) to collect this run");
  else if (run.send) add("run state", "ok", `run ${run.runId} sent ${run.send.at}; ${fs.exists(join(o.runDir, "raw")) ? fs.list(join(o.runDir, "raw")).filter((f) => f.endsWith(".json")).length : 0} capture(s) so far`);
  else add("run state", "info", `run ${run.runId}: the send was started but not confirmed (${run.sendState ?? "pending"}); collect looks for the test email in the outbound mailbox by its subject`);
  return out;
}

/** The checks that refuse a command. */
export const problems = (checks: Check[]) => checks.filter((c) => c.status === "FAIL" || c.status === "BLOCKED");

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.status.padEnd(7)} ${c.check.padEnd(28)} ${c.detail}${c.fix ? `\n${" ".repeat(37)}fix: ${c.fix}` : ""}`).join("\n");
}

/**
 * Parse and gate one invocation. validate and dry-run contact nothing and need no gate. send, collect
 * and check-subscription pass every check of trialChecks first (HAGGLE_EMAIL_TRIAL=1,
 * HAGGLE_ENV=staging, INKBOX_API_KEY, a non-production INKBOX_IDENTITY, the SDK; send/collect also the
 * exact allowlist, the ownership flag, a private run directory outside the repository and the run's
 * state), or are refused, listing every problem with its fix, before any network call.
 */
export function planTrial(argv: string[], env: TrialEnv, repoRoot: string, probe: { fs?: FsProbe; sdk?: string | null } = {}): { ok: true; cmd: Command } | { ok: false; error: string } {
  const p = parseTrialArgs(argv);
  if (!p.ok) return p;
  const cmd = p.cmd;
  if (cmd.kind === "validate") return p;
  if (cmd.kind === "dry-run") {
    if (!outsideRepo(cmd.runDir, repoRoot, probe.fs)) return { ok: false, error: "--run must be outside the repository: raw captures of real mail must never be committed" };
    return p;
  }
  const checks = trialChecks(cmd.kind, { runDir: "runDir" in cmd ? cmd.runDir : null, to: cmd.kind === "send" ? cmd.to : null }, env, argv, repoRoot, probe.fs ?? EMPTY_FS, probe.sdk === undefined ? "unknown" : probe.sdk);
  const bad = problems(checks);
  if (bad.length) return { ok: false, error: `${cmd.kind} refused before any network call (${bad.length} problem${bad.length === 1 ? "" : "s"}):\n${formatChecks(bad)}` };
  return p;
}

/** validate: every check for the command this run directory is ready for next (send if it holds no run, else collect). */
export function validateTrial(cmd: Extract<Command, { kind: "validate" }>, env: TrialEnv, argv: string[], repoRoot: string, fs: FsProbe, sdk: string | null): { ok: boolean; target: NetworkKind; checks: Check[] } {
  const target: NetworkKind = cmd.runDir && fs.exists(join(cmd.runDir, "run.json")) ? "collect" : "send";
  const checks = trialChecks(target, cmd, env, argv, repoRoot, fs, sdk);
  return { ok: problems(checks).length === 0, target, checks };
}

/** Every gate a send must pass, ok or not (dry-run prints them). */
export function sendGates(env: TrialEnv, argv: string[], to: string | null, repoRoot = "/nonexistent-repo", fs: FsProbe = EMPTY_FS, sdk: string | null = "unknown", runDir: string | null = null): Check[] {
  return trialChecks("send", { runDir, to }, env, argv, repoRoot, fs, sdk);
}

// ---------------------------------------------------------------------------------------------
// The run and the test email.
// ---------------------------------------------------------------------------------------------

/** The exact outbound email `send` builds for a run: from, to, subject, body and the provider idempotency key. */
export function plannedSend(run: TrialRun): { from: string; to: string[]; subject: string; bodyText: string; idempotencyKey: string } {
  const mail = trialEmail(run);
  return { from: run.buyerMailbox, to: [run.to], subject: mail.subject, bodyText: mail.bodyText, idempotencyKey: `email-trial:${run.runId}` };
}

/** The persisted state of one run (run.json in the run directory, mode 0600; the secret never leaves it). */
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
  /** pending: written before the send call (so a crash can't lead to a second send); sent; failed. */
  sendState?: "pending" | "sent" | "failed";
  sendError?: string;
  /** recovered: the send result wasn't recorded; collect found the email in the outbound mailbox (its id is the stored one). */
  send?: { id: string; messageId: string; status: string; at: string; threadId?: string | null; recovered?: boolean };
}

export function newRun(o: { to: string; buyerMailbox: string; now: Date; random?: (n: number) => Buffer }): TrialRun {
  const rnd = o.random ?? randomBytes;
  const runId = `trial-${o.now.toISOString().slice(0, 10)}-${rnd(4).toString("hex")}`;
  const secret = rnd(32).toString("hex");
  const jobId = `job_${runId}`;
  const businessId = `biz_${rnd(4).toString("hex")}`;
  const token = replyToken(secret, jobId, businessId);
  return { runId, startedAt: o.now.toISOString(), buyerMailbox: normalizeAddress(o.buyerMailbox), to: o.to, secret, jobId, businessId, token, subject: `[HAGGLE TEST] Reply-handling trial (ref ${token})` }; // no [HG-…] tag: real RFQs carry none (2026-10-30)
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

// ---------------------------------------------------------------------------------------------
// Message-IDs.
// ---------------------------------------------------------------------------------------------

const localPart = (id: string) => normalizeMessageId(id).split("@")[0]!;

/** Message-IDs: what send() returned vs what the mailbox stores now (and the SES id). If they differ, real replies fail not_in_our_thread. */
export function compareMessageIds(sendTime: string, stored: string | null, ses: string | null) {
  const n = (s: string | null) => (s ? normalizeMessageId(s) : null);
  const sendN = n(sendTime);
  return {
    send_time: sendTime, stored, ses_message_id: ses,
    send_time_equals_stored: stored !== null && sendN === n(stored),
    send_time_mentions_ses_id: !!ses && !!sendN && sendN.includes(localPart(ses)),
    verdict: stored === null ? "outbound message not found when listing the mailbox" : sendN === n(stored) ? "OK: the Message-ID the engine stores at send time is the one replies reference" : "MISMATCH: the engine stores the send-time id, but the mailbox (and recipients) see another; every external reply would fail not_in_our_thread",
  };
}

export type IdKind = "send_time" | "stored" | "ses";
type Where = { in_reply_to: boolean; references: boolean };

export interface MessageIdChain {
  in_reply_to: string[];
  references: string[];
  /** Where each known Haggle id appears (null: that id is unknown for this run). */
  send_time: Where;
  stored: Where | null;
  ses: Where | null;
  /** The id this reply proves the engine must record (none: the reply names no Haggle id). */
  record: IdKind | "none";
  verdict: string;
}

export function messageIdChain(inReplyTo: string[], references: string[], ids: { sendTime: string; stored: string | null; ses: string | null }): MessageIdChain {
  const eq = (x: string, id: string) => normalizeMessageId(x) === normalizeMessageId(id);
  // Inkbox's sesMessageId may be bare or a full header: compare SES ids by local part.
  const sesEq = (x: string, ses: string) => localPart(x) === localPart(ses);
  const where = (f: (x: string) => boolean): Where => ({ in_reply_to: inReplyTo.some(f), references: references.some(f) });
  const send_time = where((x) => eq(x, ids.sendTime));
  const stored = ids.stored ? where((x) => eq(x, ids.stored!)) : null;
  const ses = ids.ses ? where((x) => sesEq(x, ids.ses!)) : null;
  const any = (w: Where | null) => !!w && (w.in_reply_to || w.references);
  const headers = (w: Where) => [w.in_reply_to && "In-Reply-To", w.references && "References"].filter(Boolean).join(" + ");
  let record: MessageIdChain["record"] = "none";
  let verdict: string;
  if (any(send_time)) { record = "send_time"; verdict = `the send-time id is referenced (${headers(send_time)}): the id the engine records works`; }
  else if (any(stored)) { record = "stored"; verdict = `only the mailbox's stored id is referenced (${headers(stored!)}): the engine must record the stored id, not send()'s return value`; }
  else if (any(ses)) { record = "ses"; verdict = `only the SES id is referenced (${headers(ses!)}): the engine must record the SES Message-ID`; }
  else if (!inReplyTo.length && !references.length) verdict = "no In-Reply-To and no References: the client sent it as a new email (or dropped the headers)";
  else verdict = `In-Reply-To/References name ${inReplyTo.length + references.length} id(s), none of them Haggle's`;
  return { in_reply_to: inReplyTo, references, send_time, stored, ses, record, verdict };
}

// ---------------------------------------------------------------------------------------------
// One reply.
// ---------------------------------------------------------------------------------------------

export type MatchBy = "header+token" | "header" | "token" | "none" | "sender_mismatch";

export interface ReplyEvaluation {
  id: string;
  from: string;
  subject: string | null;
  created_at: string | null;
  body_source: "text" | "html" | "none";
  /** matchInbound's routing (business:thread / business:message_id / business:subject_tag / quarantine / unmatched). */
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
  /** (a) Which Haggle Message-IDs the reply names, where, and which one the engine must record. */
  message_id_chain: MessageIdChain;
  /** (b) Where the reply token survived, and how the engine would match it. */
  token: { where: ("subject" | "own words" | "quoted text")[]; summary: string; engine_sees_it: boolean };
  engine: { match_by: MatchBy; summary: string };
  /** (c) What can be told read-only about live webhook delivery. */
  webhook: WebhookDiagnosis;
  /** (d) Why it was (or would be) held, in plain English, and the operator's next step. */
  quarantine: { reason: string; explanation: string; next_step: string } | null;
  /** (e) The offline keyword reader's result (never Claude). */
  extraction: { reader: string; total_usd: number | null; deposit_usd: number | null; flags: string[]; approvable: boolean | null; why_not_approvable: string | null } | null;
  /** What the real pipeline (signed webhook -> engine -> parse) did with it, replayed offline (email-trial-replay.ts). */
  pipeline?: { outcome: string; trust_reason: string | null; quarantine_reason: string | null; quote_total_usd: number | null; approvable: boolean | null };
}

export interface WebhookDiagnosis {
  /** The buyer's subscription lists message.received (null: couldn't be read). */
  subscription_has_message_received: boolean | null;
  /** The message's read flag as the mailbox listed it BEFORE collect fetched it. */
  read_before_collect: "read" | "unread" | "unknown";
  live_server_saw_it: string;
}

export function diagnoseWebhook(o: { subscriptionHasReceived: boolean | null; isRead: boolean | undefined | null; id?: string }): WebhookDiagnosis {
  const read = o.isRead === true ? "read" : o.isRead === false ? "unread" : "unknown";
  const log = `look for mail:${o.id ?? "<id>"} in the staging server's log`;
  const saw = o.subscriptionHasReceived === false
    ? "no: the buyer's webhook subscription has no message.received, so Inkbox sent no webhook for it"
    : read === "read"
      ? `probably: it was already read before collect, i.e. something fetched it through the API (the live webhook handler and the reconciler both call messages.get, which marks it read; so does opening it in the Inkbox console). Not proof: ${log}`
      : read === "unread"
        ? `no sign of it: it was still unread, so nothing fetched it through the API before collect. If the staging server runs with this identity, its webhook did not process it; ${log}`
        : `unknown: the mailbox listing has no read flag for it; ${log}`;
  return { subscription_has_message_received: o.subscriptionHasReceived, read_before_collect: read, live_server_saw_it: saw };
}

const NOT_COLLECTED: WebhookDiagnosis = { subscription_has_message_received: null, read_before_collect: "unknown", live_server_saw_it: "unknown: not determinable offline (collect records it)" };

/** Run one captured reply through the engine's real inbound functions, as the webhook would, and diagnose it. */
export function evaluateReply(detail: InkboxMessageDetail, run: TrialRun, ids: { sendTime: string; stored: string | null; ses: string | null }, webhook: WebhookDiagnosis = NOT_COLLECTED): ReplyEvaluation {
  const msg = inkboxToInbound({ id: `trial:${detail.id}`, event_type: "message.received" }, detail);
  const from = msg.from ?? "";
  const ourSend = ids.sendTime;
  const chain = messageIdChain(msg.inReplyTo, msg.references, ids);
  const sesRefs = ids.ses ? [...msg.inReplyTo, ...msg.references].filter((x) => localPart(x) === localPart(ids.ses!)) : [];
  const known = [ids.sendTime, ids.stored, ...sesRefs];
  const match = matchInbound(
    { to: msg.to, threadId: msg.threadId, inReplyTo: msg.inReplyTo, references: msg.references, subject: msg.subject, from },
    [{ businessId: run.businessId, jobId: run.jobId, shortCode: TRIAL_CODE, email: run.to, threadId: run.send?.threadId ?? null, outboundMessageId: ourSend }],
  );
  const verify = (ours: (string | null)[]) => {
    const v = verifyExternalReply({ from, pinned: run.to, inReplyTo: msg.inReplyTo, references: msg.references, ourMessageIds: ours, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
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
  const bodyHas = body.toUpperCase().includes(tok);
  // The quoted part: the body without the business's own words (counted, so a token in both is seen in both).
  const count = (s: string) => s.toUpperCase().split(tok).length - 1;
  const quotedHas = count(body) > count(own);
  if (!subjectHas && bodyHas && !ownHas) notes.push("token only in quoted text");
  const where = [subjectHas && "subject", ownHas && "own words", quotedHas && "quoted text"].filter(Boolean) as ("subject" | "own words" | "quoted text")[];
  const verdict = verify([ourSend]);
  const engineSees = subjectHas || bodyHas; // the engine looks for the token in the subject and the whole body
  const header = chain.record === "send_time";
  const pinned = strictAddress(from) !== null && strictAddress(from) === strictAddress(run.to);
  const matchBy: MatchBy = !pinned ? "sender_mismatch" : header && engineSees ? "header+token" : header ? "header" : engineSees ? "token" : "none";
  const engineSummary = {
    "header+token": "matches by Message-ID header: accepted as the business's reply (the engine no longer needs the token)",
    header: "matches by Message-ID header: accepted as the business's reply",
    token: "no Haggle Message-ID in its headers: a new email to the engine, read only when the vendor has exactly one open deal (lowest trust), else held (ambiguous_sender)",
    none: "neither a recorded Message-ID nor the token: not matched as the business's reply",
    sender_mismatch: "from another address than Haggle wrote to: quarantined whatever its headers or token",
  }[matchBy];
  return {
    id: detail.id, from, subject: msg.subject, created_at: detail.createdAt ? new Date(detail.createdAt).toISOString() : null, body_source: bodySource,
    match: match.kind === "unmatched" || match.kind === "quarantine" ? `${match.kind}:${match.reason}` : `${match.kind}:${match.via}`,
    verdict, verdict_any_known_id: verify(known),
    token_in_subject: subjectHas, token_in_body: bodyHas, token_in_own_words: ownHas,
    in_reply_to_ours: msg.inReplyTo.some((x) => ourIds.has(normalizeMessageId(x))), references_ours: msg.references.some((x) => ourIds.has(normalizeMessageId(x))),
    quoted_history_cut: own.length < body.trim().length, own_words_preview: own.slice(0, 400),
    opt_out: isOptOut(body), bounce: parseBounce(msg) !== null,
    attachments: msg.attachments.map((a) => ({ filename: a.filename ?? "", content_type: a.contentType, size: a.sizeBytes })), notes,
    message_id_chain: chain,
    token: { where, summary: where.length ? where.join(" + ") : "not found", engine_sees_it: engineSees },
    engine: { match_by: matchBy, summary: engineSummary },
    webhook,
    quarantine: verdict.startsWith("ok:") ? null : explainReason(verdict, chain),
    extraction: null,
  };
}

/** Plain English for a quarantine reason, with the trial operator's next step. */
export function explainReason(reason: string, chain?: MessageIdChain): { reason: string; explanation: string; next_step: string } {
  const e = explainQuarantine(reason);
  let next = e.action;
  if ((reason.endsWith(":not_in_our_thread") || reason === "ambiguous_sender") && chain && (chain.record === "stored" || chain.record === "ses")) {
    next = `Engine fix, not a tester problem: this reply names the ${chain.record === "ses" ? "SES" : "stored"} Message-ID, but the engine records send()'s return value. Record that id after sending before any pilot; report it to the coordinator.`;
  } else if (reason.endsWith(":not_in_our_thread")) next = `Expected for a new email (scenario 8). For a reply made with Reply, the client dropped the thread headers: note the client. ${e.action}`;
  else if (reason.endsWith(":token_missing")) next = `Expected for scenario 2/3 when the subject and quote were both removed. Otherwise note the client: it stripped the reference. ${e.action}`;
  else if (reason.endsWith(":from_mismatch") || reason.startsWith("sender_mismatch")) next = `Expected for the forward scenario (5). ${e.action}`;
  return { reason: e.reason, explanation: e.explanation, next_step: next };
}

// ---------------------------------------------------------------------------------------------
// Redaction, report.
// ---------------------------------------------------------------------------------------------

/** Mask personal data for the shareable report: mailbox local parts, phone numbers, the token, long digit runs. Raw captures stay local. */
export function redact(text: string, run?: Pick<TrialRun, "token" | "secret">): string {
  let t = text;
  if (run) t = t.split(run.token).join("HGR-<token>").split(run.secret).join("<secret>");
  return t
    .replace(/HGR-[A-HJ-NP-Z2-9]{10}/gi, "HGR-<token>")
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "<number>");
}

/** Replace every secret value (API keys, webhook secrets, the run secret) in console or error text. */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let t = text;
  for (const s of secrets) if (s && s.trim().length >= 8) t = t.split(s.trim()).join("<redacted>");
  return t;
}

export type OverallVerdict = { label: "READY" | "ID MISMATCH" | "TOKEN ONLY" | "NOT MATCHED" | "NO REPLIES"; line: string };

/**
 * One line for the whole run, from the replies sent by the trial recipient itself (forwards from
 * other addresses and bounces are expected failures and don't count):
 *   READY        some replies name the send-time Message-ID (the one the engine records);
 *   ID MISMATCH  none do, but some name the stored or SES id: the engine records the wrong id;
 *   TOKEN ONLY   no Haggle id in any reply's headers, but the token survived;
 *   NOT MATCHED  neither; NO REPLIES  nothing from the recipient yet.
 */
export function overallVerdict(run: Pick<TrialRun, "to">, replies: ReplyEvaluation[]): OverallVerdict {
  const to = strictAddress(run.to);
  const core = replies.filter((r) => !r.bounce && strictAddress(r.from) === to);
  const n = core.length;
  if (!n) return { label: "NO REPLIES", line: "NO REPLIES: nothing from the trial recipient since the send. Reply from the mail clients, wait a minute, re-run collect." };
  const by = (k: IdKind) => core.filter((r) => r.message_id_chain.record === k).length;
  const verified = core.filter((r) => r.verdict.startsWith("ok:")).length;
  const sendTime = by("send_time");
  if (sendTime) {
    const rest = n - verified;
    return { label: "READY", line: `READY: replies match by Message-ID (${sendTime}/${n} replies name the send-time id; ${verified}/${n} verified)${rest ? `; ${rest} held: see each reply's quarantine reason (expected for the edited-subject, fresh-email scenarios)` : ""}.` };
  }
  const other = by("stored") + by("ses");
  if (other) {
    const which = by("ses") >= by("stored") ? "SES" : "stored";
    return { label: "ID MISMATCH", line: `ID MISMATCH: ${other}/${n} replies name the ${which} Message-ID, none the send-time id the engine records; every real reply would be quarantined not_in_our_thread. Fix the recorded id before any pilot.` };
  }
  const tokenOnly = core.filter((r) => r.token.engine_sees_it).length;
  if (tokenOnly) return { label: "TOKEN ONLY", line: `TOKEN ONLY: ${tokenOnly}/${n} replies keep the reply token but none names a Haggle Message-ID; the engine quarantines them (not_in_our_thread). Check the clients' In-Reply-To/References in raw/.` };
  return { label: "NOT MATCHED", line: `NOT MATCHED: none of the ${n} replies names a Haggle Message-ID or keeps the reply token.` };
}

export interface TrialReport {
  run: { runId: string; startedAt: string; collectedAt: string; buyerMailbox: string; to: string; send_recovered: boolean };
  verdict: OverallVerdict;
  message_ids: ReturnType<typeof compareMessageIds> & {
    /** How many of the recipient's replies name each id (the decisive evidence). */
    observed_in_replies: Record<IdKind | "none", number>;
    engine_should_record: string;
  };
  webhook: { subscription: string };
  replies: ReplyEvaluation[];
  summary: { replies: number; verified: number; quarantined: Record<string, number>; html_only: number; token_only_in_quotes: number };
  scenarios: readonly string[];
}

export function buildReport(run: TrialRun, ids: ReturnType<typeof compareMessageIds>, replies: ReplyEvaluation[], now: Date, extra: { subscription?: string } = {}): TrialReport {
  const quarantined: Record<string, number> = {};
  for (const r of replies) if (!r.verdict.startsWith("ok:")) quarantined[r.verdict] = (quarantined[r.verdict] ?? 0) + 1;
  const red = (s: string) => redact(s, run);
  const to = strictAddress(run.to);
  const core = replies.filter((r) => !r.bounce && strictAddress(r.from) === to);
  const observed = { send_time: 0, stored: 0, ses: 0, none: 0 } as Record<IdKind | "none", number>;
  for (const r of core) observed[r.message_id_chain.record]++;
  const should = observed.send_time ? "send_time: keep recording send()'s Message-ID" : observed.stored ? "stored: record the Message-ID the mailbox stores (re-read the message after send)" : observed.ses ? "ses: record the SES Message-ID" : "undetermined: no reply named a Haggle Message-ID";
  return {
    run: { runId: run.runId, startedAt: run.startedAt, collectedAt: now.toISOString(), buyerMailbox: red(run.buyerMailbox), to: red(run.to), send_recovered: !!run.send?.recovered },
    verdict: overallVerdict(run, replies),
    message_ids: { ...ids, observed_in_replies: observed, engine_should_record: should },
    webhook: { subscription: extra.subscription ?? "not checked" },
    replies: replies.map((r) => ({
      ...r, from: red(r.from), subject: r.subject === null ? null : red(r.subject), own_words_preview: red(r.own_words_preview), notes: r.notes.map(red),
      attachments: r.attachments.map((a) => ({ ...a, filename: red(a.filename) })),
    })),
    summary: { replies: replies.length, verified: replies.filter((r) => r.verdict.startsWith("ok:")).length, quarantined, html_only: replies.filter((r) => r.body_source === "html").length, token_only_in_quotes: replies.filter((r) => r.notes.includes("token only in quoted text")).length },
    scenarios: SCENARIOS,
  };
}

function pipelineCell(p: ReplyEvaluation["pipeline"]): string {
  if (!p) return "-";
  return `${p.outcome}${p.trust_reason ? ` (${p.trust_reason})` : ""}${p.quote_total_usd !== null ? ` quote $${p.quote_total_usd}${p.approvable === false ? " (not approvable)" : ""}` : ""}`;
}

export type ReplayRow = { id: string; outcome: string; trust_reason: string | null; quarantine_reason: string | null; quote_total_usd: number | null; approvable: boolean | null; notes?: string[]; quote_deposit_usd?: number | null; quote_flags?: string[]; approval_block?: string | null };

/** Attach each reply's offline pipeline replay (by Inkbox message id): the quarantine reason it really got and the keyword reader's extraction. */
export function withPipeline(evals: ReplyEvaluation[], replays: ReplayRow[]): ReplyEvaluation[] {
  const by = new Map(replays.map((r) => [r.id, r]));
  return evals.map((e) => {
    const r = by.get(e.id);
    if (!r) return e;
    const stored = r.outcome === "stored";
    const held = r.quarantine_reason ?? (!stored ? r.outcome.replace(/^quarantined:/, "") : null);
    return {
      ...e,
      pipeline: { outcome: r.outcome, trust_reason: r.trust_reason, quarantine_reason: r.quarantine_reason, quote_total_usd: r.quote_total_usd, approvable: r.approvable },
      notes: [...e.notes, ...(r.notes ?? [])],
      quarantine: held ? explainReason(held, e.message_id_chain) : e.quarantine,
      extraction: stored ? { reader: KEYWORD_READER, total_usd: r.quote_total_usd, deposit_usd: r.quote_deposit_usd ?? null, flags: r.quote_flags ?? [], approvable: r.approvable, why_not_approvable: r.approvable === false ? r.approval_block ?? "offline keyword reading is never approvable" : null } : null,
    };
  });
}

export function renderMarkdown(r: TrialReport): string {
  const yes = (b: boolean) => (b ? "yes" : "no");
  const w = (x: Where | null) => (x ? `${yes(x.in_reply_to)}/${yes(x.references)}` : "n/a");
  return [
    `# Email trial ${r.run.runId}`,
    "",
    `**${r.verdict.line}**`,
    "",
    `Started ${r.run.startedAt}, collected ${r.run.collectedAt}. Buyer ${r.run.buyerMailbox}, trial recipient ${r.run.to}.${r.run.send_recovered ? " The send result wasn't recorded: the test email was recovered from the outbound mailbox (send-time id unknown; the stored id stands in)." : ""}`,
    "",
    "## Message-IDs",
    "",
    `- ${r.message_ids.verdict}`,
    `- send-time id equals stored: ${yes(r.message_ids.send_time_equals_stored)}; SES id known: ${yes(!!r.message_ids.ses_message_id)}`,
    `- named by the recipient's replies: send-time ${r.message_ids.observed_in_replies.send_time}, stored only ${r.message_ids.observed_in_replies.stored}, SES only ${r.message_ids.observed_in_replies.ses}, none ${r.message_ids.observed_in_replies.none}`,
    `- the engine should record: ${r.message_ids.engine_should_record}`,
    "",
    "## Webhook",
    "",
    `- subscription: ${r.webhook.subscription}`,
    "",
    "## Summary",
    "",
    `- replies: ${r.summary.replies}; verified: ${r.summary.verified}; HTML-only: ${r.summary.html_only}; token only in quoted text: ${r.summary.token_only_in_quotes}`,
    ...Object.entries(r.summary.quarantined).map(([k, v]) => `- quarantined ${k}: ${v}`),
    "",
    "## Replies",
    "",
    "| # | from | verdict | engine match | token | cut quotes | body | pipeline | notes |",
    "|---|---|---|---|---|---|---|---|---|",
    ...r.replies.map((x, i) => `| ${i + 1} | ${x.from} | ${x.verdict}${x.verdict_any_known_id !== x.verdict ? ` (any id: ${x.verdict_any_known_id})` : ""} | ${x.engine.match_by} (${x.match}) | ${x.token.summary} | ${yes(x.quoted_history_cut)} | ${x.body_source} | ${pipelineCell(x.pipeline)} | ${x.notes.join("; ").replace(/\|/g, "/")} |`),
    "",
    ...r.replies.flatMap((x, i) => [
      `### Reply ${i + 1}: ${x.from}${x.subject ? `, "${x.subject.replace(/\|/g, "/")}"` : ""}`,
      "",
      `- Message-ID chain: ${x.message_id_chain.verdict}. In-Reply-To/References name: send-time ${w(x.message_id_chain.send_time)}, stored ${w(x.message_id_chain.stored)}, SES ${w(x.message_id_chain.ses)}.`,
      `- Reply token: ${x.token.summary}${x.token.engine_sees_it ? " (the engine sees it)" : " (the engine can't verify the sender)"}. Engine: ${x.engine.summary}.`,
      `- Webhook: ${x.webhook.live_server_saw_it}`,
      x.quarantine ? `- Held: ${x.quarantine.reason}. ${x.quarantine.explanation} Next: ${x.quarantine.next_step}` : "- Held: no (accepted as the business's reply).",
      x.extraction ? `- Extraction (${x.extraction.reader}): total ${x.extraction.total_usd === null ? "not found" : `$${x.extraction.total_usd}`}, deposit ${x.extraction.deposit_usd === null ? "not found" : `$${x.extraction.deposit_usd}`}, flags ${x.extraction.flags.length ? x.extraction.flags.join(", ") : "none"}; approvable: ${x.extraction.approvable === null ? "n/a" : yes(x.extraction.approvable)}${x.extraction.why_not_approvable ? ` (${x.extraction.why_not_approvable})` : ""}.` : `- Extraction (${KEYWORD_READER}): not read (held, or not replayed).`,
      "",
    ]),
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
  const hasReceived = rows.some((r) => !r.missing_required.includes("message.received"));
  return { subscriptions: rows, ok, has_message_received: hasReceived, advice: ok ? "A subscription covers message.received, message.bounced and message.failed." : rows.length ? `Add ${[...new Set(rows.flatMap((r) => r.missing_required))].join(", ")} to the buyer's webhook subscription (subscriptions.update with the full eventTypes list); until then bounces are found only by the reconciler's outbound status sweep.` : "No webhook subscription for the buyer identity." };
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
