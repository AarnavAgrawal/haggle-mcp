// Controlled live test of real external replies (Gmail, Outlook, iOS Mail) against the Inkbox buyer
// mailbox. OPERATOR-RUN ONLY, against mailboxes the operator owns. Sending is disabled unless
// HAGGLE_EMAIL_TRIAL=1, every address is listed in HAGGLE_EMAIL_TRIAL_MAILBOXES, and
// --i-own-this-mailbox is passed. It never touches the engine database, never contacts a business,
// and never parses with Claude. Checklist: docs/email-trial-checklist.md.
//
//   node scripts/email-trial.ts validate --run ~/haggle-trials/t1 --to me@gmail.com      (no network)
//   node scripts/email-trial.ts dry-run --to me@gmail.com --run ~/haggle-trials/t1        (no network)
//   HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=me@gmail.com,me2@outlook.com \
//     node --env-file=.env scripts/email-trial.ts send --to me@gmail.com --run ~/haggle-trials/t1 --i-own-this-mailbox
//   ... reply from the mail clients following the printed checklist ...
//   HAGGLE_EMAIL_TRIAL=1 HAGGLE_EMAIL_TRIAL_MAILBOXES=... node --env-file=.env scripts/email-trial.ts collect --run ~/haggle-trials/t1 --i-own-this-mailbox
//   HAGGLE_EMAIL_TRIAL=1 node --env-file=.env scripts/email-trial.ts check-subscription
//
// validate: configuration only (env names present, never values; the mailbox allowlist; the run
//   directory; the installed SDK; every send gate). Contacts nothing, writes nothing.
// dry-run: prints the exact test email `send` would build (a fresh run's token; the real send makes
//   its own), and, when the run directory already holds a run and its captures, replays them through
//   the real inbound pipeline offline (signed webhook -> engine -> parse; email-trial-replay.ts).
//   Contacts nothing, writes nothing.
// send: one clearly-labelled TEST email from the buyer mailbox, carrying a reply token made with a
//   run-local random secret; records the send-time Message-ID in <run>/run.json. Refuses a run
//   directory that already holds a run (no accidental second send).
// collect: lists inbound mail since the run started from the trial addresses, fetches each (restoring
//   its unread state: messages.get marks it read), re-lists the outbound test email to compare the
//   send-time and stored Message-IDs, evaluates every reply with the engine's pure inbound functions
//   AND replays it through the pipeline, and writes <run>/report.json and <run>/report.md (redacted)
//   plus <run>/raw/<id>.json (unredacted captures; the run directory must be outside the repository).
// check-subscription: read-only; reports mail event types the buyer's webhook subscription lacks.
//
// Needs INKBOX_API_KEY and INKBOX_IDENTITY (default "haggle") for send, collect and check-subscription.
import { existsSync, accessSync, constants, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { connectInkboxTrial, type InkboxMessageDetail } from "@haggle/engine";
import { buildReport, checkSubscriptions, compareMessageIds, evaluateReply, newRun, planTrial, plannedSend, renderMarkdown, SCENARIOS, sendGates, trialMailboxes, validateTrial, withPipeline, type ReplyEvaluation, type TrialRun } from "./email-trial-lib.ts";
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

const fsProbe = {
  exists: (p: string) => existsSync(p),
  writable: (p: string) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } },
  list: (p: string) => { try { return readdirSync(p); } catch { return []; } },
};

function readCaptures(runDir: string): InkboxMessageDetail[] {
  const dir = join(runDir, "raw");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as InkboxMessageDetail);
}

async function main() {
  const argv = process.argv.slice(2);
  const plan = planTrial(argv, process.env, REPO_ROOT);
  if (!plan.ok) throw new Error(plan.error);
  const cmd = plan.cmd;

  if (cmd.kind === "validate") {
    const v = validateTrial(cmd, process.env, argv, REPO_ROOT, fsProbe, sdkVersion());
    for (const c of v.checks) console.log(`${c.ok ? "ok  " : c.level === "error" ? "FAIL" : "warn"}  ${c.check.padEnd(30)} ${c.detail}`);
    console.log(v.ok ? "\nConfiguration OK (nothing was contacted)." : "\nConfiguration has errors (nothing was contacted).");
    if (!v.ok) process.exitCode = 1;
    return;
  }

  if (cmd.kind === "dry-run") {
    const existing = existsSync(join(cmd.runDir, "run.json")) ? (JSON.parse(readFileSync(join(cmd.runDir, "run.json"), "utf8")) as TrialRun) : null;
    const run = existing ?? newRun({ to: cmd.to, buyerMailbox: cmd.buyer ?? "<buyer mailbox from Inkbox>", now: new Date() });
    const gates = sendGates(process.env, argv, cmd.to);
    console.log(`DRY RUN: nothing is sent, fetched or written.\n\nSend gates: ${Object.entries(gates).map(([k, ok]) => `${k} ${ok ? "ok" : "MISSING"}`).join(", ")}\n`);
    const mail = plannedSend({ ...run, to: cmd.to });
    console.log(`The test email ${existing ? "this run sent" : "send would build (its token and run id are made fresh at send time)"}:\n\nFrom: ${mail.from}\nTo: ${mail.to.join(", ")}\nSubject: ${mail.subject}\nIdempotency key: ${mail.idempotencyKey}\n\n${mail.bodyText}\n`);
    const captures = existing?.send ? readCaptures(cmd.runDir) : [];
    if (!captures.length) {
      console.log(existing ? "No captures in <run>/raw yet (run collect first)." : "No run in this directory yet: after send and collect, dry-run replays the captured replies offline.");
      return;
    }
    const replays = await replayCaptures(existing!, captures);
    console.log(`Offline replay of ${captures.length} captured repl${captures.length === 1 ? "y" : "ies"} through the real pipeline (signed webhook -> engine -> keyword reader):\n`);
    for (const r of replays) console.log(`  ${r.id}  ${r.outcome.padEnd(34)} ${r.trust_reason ?? r.quarantine_reason ?? ""}${r.quote_total_usd !== null ? `  quote $${r.quote_total_usd}${r.approvable === false ? " (keyword reading: not approvable)" : ""}` : ""}${r.notes.length ? `  [${r.notes.join("; ")}]` : ""}`);
    return;
  }

  const apiKey = process.env.INKBOX_API_KEY;
  if (!apiKey) throw new Error("INKBOX_API_KEY is not set");
  const ink = await connectInkboxTrial({ apiKey, handle: process.env.INKBOX_IDENTITY?.trim() || "haggle" });
  const buyer = ink.buyerMailbox;

  if (cmd.kind === "check-subscription") {
    const mailFilter = ink.mailInboundFilterMode === "whitelist" ? "whitelist: only allowed senders' mail is delivered; every pilot vendor and trial mailbox must be allowed" : ink.mailInboundFilterMode;
    console.log(JSON.stringify({ ...checkSubscriptions(await ink.listSubscriptions(), ink.identityId), buyer_mail_inbound_filter: mailFilter }, null, 2));
    return;
  }

  const runFile = join(cmd.runDir, "run.json");
  if (cmd.kind === "send") {
    if (existsSync(runFile)) throw new Error(`${runFile} already exists: this run was sent; use a new --run directory for another send`);
    // planTrial checked every gate; check the address again right before the only mutating call.
    if (!trialMailboxes(process.env).includes(cmd.to) || !argv.includes("--i-own-this-mailbox") || process.env.HAGGLE_EMAIL_TRIAL !== "1") throw new Error("send gate failed");
    mkdirSync(cmd.runDir, { recursive: true });
    const run = newRun({ to: cmd.to, buyerMailbox: buyer, now: new Date() });
    const mail = plannedSend(run);
    const sent = await ink.send({ to: mail.to, subject: mail.subject, bodyText: mail.bodyText, idempotencyKey: mail.idempotencyKey });
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
  const captures: InkboxMessageDetail[] = [];
  for await (const m of ink.list({ direction: "inbound", startDatetime: run.startedAt, pageSize: 50 })) {
    const from = (m.fromAddress ?? "").toLowerCase();
    if (!m.id || (!allowed.has(from) && !/^(mailer-daemon|postmaster)@/.test(from))) continue;
    const detail = await ink.get(m.id);
    if (m.isRead === false) await ink.markUnread(m.id); // get() marks it read: put it back for the live webhook/sweep
    writeFileSync(join(cmd.runDir, "raw", `${m.id}.json`), JSON.stringify(detail, null, 2), { mode: 0o600 });
    captures.push(detail);
    evaluations.push(evaluateReply(detail, run, { sendTime: run.send.messageId, stored, ses }));
  }
  // The same captures through the real pipeline, offline (what the server would have done with each).
  const replays = await replayCaptures(run, [...captures].reverse());
  const report = buildReport(run, ids, withPipeline(evaluations.reverse(), replays), new Date());
  writeFileSync(join(cmd.runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(cmd.runDir, "report.md"), renderMarkdown(report));
  console.log(renderMarkdown(report));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/email-trial.ts")) {
  main().catch((e) => {
    console.error(`email-trial failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
