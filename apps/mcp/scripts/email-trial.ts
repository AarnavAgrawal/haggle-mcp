// Controlled live test of real external replies (Gmail, Outlook, iOS Mail) against a STAGING Inkbox
// buyer mailbox. OPERATOR-RUN ONLY, against mailboxes the operator owns. It never touches the engine
// database, never contacts a business, and never parses with Claude. Checklist:
// docs/email-trial-checklist.md.
//
//   node scripts/email-trial.ts validate --run ~/haggle-trials/t1 --to me@gmail.com      (no network)
//   node scripts/email-trial.ts dry-run --to me@gmail.com --run ~/haggle-trials/t1        (no network)
//   HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me2@outlook.com \
//     node --env-file=<staging env> scripts/email-trial.ts send --to me@gmail.com --run ~/haggle-trials/t1 --i-own-this-mailbox
//   ... reply from the mail clients following the printed checklist ...
//   HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=... node --env-file=<staging env> scripts/email-trial.ts collect --run ~/haggle-trials/t1 --i-own-this-mailbox
//   HAGGLE_EMAIL_TRIAL=1 node --env-file=<staging env> scripts/email-trial.ts check-subscription
//
// Gates (email-trial-lib.ts trialChecks), all checked before any network call: HAGGLE_EMAIL_TRIAL=1,
// HAGGLE_ENV=staging (production refused), INKBOX_API_KEY, INKBOX_IDENTITY set explicitly and not a
// production handle, the installed SDK; send/collect also an exact plain-ASCII allowlist
// (HAGGLE_EMAIL_TRIAL_MAILBOXES, at most 5), --i-own-this-mailbox, and a private run directory
// outside the repository (send: no run there yet; collect: the run send recorded).
//
// validate: every gate as ok / FAIL / BLOCKED with its fix. Contacts nothing, writes nothing.
// dry-run: the exact test email `send` would build, the gates, and (when the run directory holds
//   captures) their offline replay and diagnosis. Contacts nothing, writes nothing.
// send: one clearly-labelled TEST email. run.json (mode 0600, created exclusively) is written BEFORE
//   the send call, so a crash or a second invocation can never send twice; then the send-time
//   Message-ID is recorded.
// collect: reads only mail FROM the allowlisted mailboxes (delivery notices only with
//   --include-bounces), restores each message's unread state, re-lists the outbound test email for
//   the stored/SES Message-IDs, reads the buyer's webhook subscription, evaluates and replays every
//   reply offline, and writes report.json, report.md (redacted) and raw/<id>.json (unredacted), all
//   mode 0600 in a 0700 directory outside the repository.
// check-subscription: read-only; reports mail event types the buyer's webhook subscription lacks.
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { connectInkboxTrial, type InkboxMessageDetail } from "@haggle/engine";
import { ENV_MANIFEST } from "../src/envManifest.ts";
import { collectRun, readRun, sendOnce } from "./email-trial-io.ts";
import {
  buildReport, checkSubscriptions, compareMessageIds, evaluateReply, formatChecks, newRun, planTrial, plannedSend, problems, renderMarkdown, SCENARIOS, scrubSecrets, sendGates,
  strictAddress, trialMailboxes, validateTrial, withPipeline, type FsProbe, type TrialReport, type WebhookDiagnosis,
} from "./email-trial-lib.ts";
import { replayCaptures } from "./email-trial-replay.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** The locally installed @inkbox/sdk version (module resolution only; nothing is contacted). */
function sdkVersion(): string | null {
  try {
    const entry = fileURLToPath(import.meta.resolve("@inkbox/sdk"));
    const root = entry.slice(0, entry.lastIndexOf(`${sep}@inkbox${sep}sdk${sep}`) + `${sep}@inkbox${sep}sdk`.length);
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return null;
  }
}

const fsProbe: FsProbe = {
  exists: (p) => existsSync(p),
  writable: (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } },
  list: (p) => { try { return readdirSync(p); } catch { return []; } },
  mode: (p) => { try { return statSync(p).mode & 0o777; } catch { return null; } },
  realpath: (p) => { try { return realpathSync(p); } catch { return null; } },
  read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
};

/** Every secret value this process could print (by the env manifest's secret flag), scrubbed from all output. */
const SECRETS: string[] = ENV_MANIFEST.filter((s) => s.secret).map((s) => process.env[s.name] ?? "").filter(Boolean);
let runSecrets: string[] = [];
const scrub = (s: string) => scrubSecrets(s, [...SECRETS, ...runSecrets]);
const out = (s: string) => console.log(scrub(s));

function readCaptures(runDir: string): InkboxMessageDetail[] {
  const dir = join(runDir, "raw");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as InkboxMessageDetail);
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

async function main() {
  const argv = process.argv.slice(2);
  const plan = planTrial(argv, process.env, REPO_ROOT, { fs: fsProbe, sdk: sdkVersion() });
  if (!plan.ok) throw new Error(plan.error);
  const cmd = plan.cmd;

  if (cmd.kind === "validate") {
    const v = validateTrial(cmd, process.env, argv, REPO_ROOT, fsProbe, sdkVersion());
    out(`Checking every gate of: ${v.target}${cmd.runDir ? "" : " (no --run given)"}\n`);
    out(formatChecks(v.checks));
    const bad = problems(v.checks);
    out(v.ok ? `\n${v.target}: all gates pass (nothing was contacted).` : `\n${v.target} would be REFUSED: ${bad.length} problem(s) above (nothing was contacted).`);
    if (!v.ok) process.exitCode = 1;
    return;
  }

  if (cmd.kind === "dry-run") {
    const existing = readRun(cmd.runDir);
    if (existing) runSecrets = [existing.secret, existing.token];
    const run = existing ?? newRun({ to: cmd.to, buyerMailbox: cmd.buyer ?? "<buyer mailbox from Inkbox>", now: new Date() });
    const gates = sendGates(process.env, argv, cmd.to, REPO_ROOT, fsProbe, sdkVersion(), cmd.runDir);
    const bad = problems(gates);
    out(`DRY RUN: nothing is sent, fetched or written.\n\nsend ${bad.length ? `would be REFUSED (${bad.length} problem(s)):\n${formatChecks(bad)}` : "gates: all pass"}\n`);
    const mail = plannedSend({ ...run, to: cmd.to });
    out(`The test email ${existing ? "this run sent (its token shown as HGR-<token>)" : "send would build (its token and run id are made fresh at send time)"}:\n\nFrom: ${mail.from}\nTo: ${mail.to.join(", ")}\nSubject: ${existing ? mail.subject.split(run.token).join("HGR-<token>") : mail.subject}\nIdempotency key: ${mail.idempotencyKey}\n\n${existing ? mail.bodyText.split(run.token).join("HGR-<token>") : mail.bodyText}\n`);
    const captures = existing?.send ? readCaptures(cmd.runDir) : [];
    if (!captures.length) {
      out(existing ? "No captures in <run>/raw yet (run collect first)." : "No run in this directory yet: after send and collect, dry-run replays the captured replies offline.");
      return;
    }
    // The ids and webhook facts collect recorded (no network here); otherwise only the send-time id is known.
    const prior = readJson<TrialReport>(join(cmd.runDir, "report.json"));
    const ids = { sendTime: existing!.send!.messageId, stored: prior?.message_ids.stored ?? null, ses: prior?.message_ids.ses_message_id ?? null };
    const hooks = new Map((prior?.replies ?? []).map((r) => [r.id, r.webhook] as [string, WebhookDiagnosis]));
    const evals = captures.map((c) => evaluateReply(c, existing!, ids, hooks.get(c.id)));
    const replays = await replayCaptures(existing!, captures);
    const report = buildReport(existing!, compareMessageIds(ids.sendTime, ids.stored, ids.ses), withPipeline(evals, replays), new Date(), { subscription: prior?.webhook.subscription ?? "not checked (dry-run is offline; collect reads it)" });
    out(`Offline replay of ${captures.length} captured repl${captures.length === 1 ? "y" : "ies"} through the real pipeline (signed webhook -> engine -> keyword reader, not Claude):\n`);
    for (const r of replays) out(`  ${r.id}  ${r.outcome.padEnd(34)} ${r.trust_reason ?? r.quarantine_reason ?? ""}${r.quote_total_usd !== null ? `  quote $${r.quote_total_usd}${r.approvable === false ? " (keyword reading: not approvable)" : ""}` : ""}${r.notes.length ? `  [${r.notes.join("; ")}]` : ""}`);
    out(`\n${renderMarkdown(report)}`);
    return;
  }

  // Every gate passed (planTrial): only now is Inkbox contacted.
  const handle = process.env.INKBOX_IDENTITY!.trim();
  const ink = await connectInkboxTrial({ apiKey: process.env.INKBOX_API_KEY!.trim(), handle });
  if (ink.handle && ink.handle.toLowerCase() !== handle.toLowerCase()) throw new Error(`Inkbox returned identity "${ink.handle}", not "${handle}": refusing to go on. Fix: check INKBOX_IDENTITY and that INKBOX_API_KEY is the staging org's key.`);

  if (cmd.kind === "check-subscription") {
    const mailFilter = ink.mailInboundFilterMode === "whitelist" ? "whitelist: only allowed senders' mail is delivered; every pilot vendor and trial mailbox must be allowed" : ink.mailInboundFilterMode;
    out(JSON.stringify({ ...checkSubscriptions(await ink.listSubscriptions(), ink.identityId), buyer_mail_inbound_filter: mailFilter }, null, 2));
    return;
  }

  if (cmd.kind === "send") {
    // Re-check the gate right before the only mutating call.
    const to = strictAddress(cmd.to);
    if (!to || !trialMailboxes(process.env).includes(to) || !argv.includes("--i-own-this-mailbox") || process.env.HAGGLE_EMAIL_TRIAL !== "1") throw new Error("send gate failed");
    const run = await sendOnce(ink, { to, runDir: cmd.runDir, scrub });
    runSecrets = [run.secret, run.token];
    out(`Sent the TEST email to ${to} (Inkbox id ${run.send!.id}). Run state: ${join(cmd.runDir, "run.json")} (mode 0600)\n\nAsk the tester to reply in each of these ways:\n${SCENARIOS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\nThen run collect.`);
    return;
  }

  // collect
  const existing = readRun(cmd.runDir);
  if (existing) runSecrets = [existing.secret, existing.token];
  const r = await collectRun(ink, { runDir: cmd.runDir, allowed: trialMailboxes(process.env), includeBounces: cmd.includeBounces, scrub });
  out(r.markdown);
  for (const w of r.warnings) out(`warning: ${w}`);
  out(`Skipped without opening: ${r.skipped.not_allowlisted} message(s) from senders not in HAGGLE_EMAIL_TRIAL_MAILBOXES; ${r.skipped.bounces} delivery notice(s)${cmd.includeBounces ? "" : " (add --include-bounces to read them)"}.`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/email-trial.ts")) {
  main().catch((e) => {
    console.error(scrub(`email-trial failed: ${(e as Error).message}`));
    process.exit(1);
  });
}
