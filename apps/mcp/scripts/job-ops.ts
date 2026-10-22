// Operator-only job operations, run with direct database access (never through an MCP tool): see
// what is stuck or waiting for review, inspect one job, retry an action safely, close a review.
//
//   node --env-file=.env scripts/job-ops.ts list-stuck [--limit 200]
//   node --env-file=.env scripts/job-ops.ts list-review [--all] [--job job_...]
//   node --env-file=.env scripts/job-ops.ts inspect --job job_...
//   node --env-file=.env scripts/job-ops.ts retry --key "rfq:job_...:biz_..." --by "<your name>"
//   node --env-file=.env scripts/job-ops.ts retry --key "confirm:apr_..." --override-obligation --by "<your name>"
//   node --env-file=.env scripts/job-ops.ts retry --payment pay_... --override-financial --by "<your name>"
//   node --env-file=.env scripts/job-ops.ts resolve --id rev_... --note "<what you checked or did>" --by "<your name>"
//   node --env-file=.env scripts/job-ops.ts review-job --job job_... --note "<why>" --by "<your name>"
//   node --env-file=.env scripts/job-ops.ts resume --job job_... --note "<what you fixed>" --by "<your name>"
//   node --env-file=.env scripts/job-ops.ts fail-safe-close --job job_... --reason "<short, the human reads it>" --by "<your name>" --confirm
//   node --env-file=.env scripts/job-ops.ts cancel --job job_... --reason "<short>" --by "<your name>" --confirm     (= fail-safe-close)
//   node --env-file=.env scripts/job-ops.ts callback --job job_... --business biz_... --by "<your name>" --reason "<what you reviewed>"
//
// callback asks the running server to call one business back once (Voice AI, the engine's
// operatorCallback): the request is recorded as an open review; on the job's next advance the engine
// performs it only if its own checks pass (an evidence-based callback proposal, a round left, the
// callee's recorded consent, not suppressed) and closes the review with the outcome (inspect shows
// it). It never approves or pays. Every change here is also recorded in the operator log (migration 119).
//
// The script never calls Inkbox or Stripe. A retry only re-arms the action in the database; the
// running server's next advance performs it through every normal check (suppressions, vendor
// authorization, the approval it rests on, the full payment guard). What a retry refuses:
//   * a Voice AI call that may have rung (pending or unknown): never redialed, override or not;
//   * a business suppressed (opt-out, bounce) or no longer authorized for the workspace since;
//   * anything first attempted longer ago than Inkbox keeps idempotency keys (7 days);
//   * an acceptance, booking confirmation or "the customer paid" notice: only with
//     --override-obligation, after checking the business never received it;
//   * a held Stripe charge: only with --override-financial, after checking the Stripe dashboard has
//     no PaymentIntent for the approval (metadata approval_id). The payment guard runs again first;
//   * x402 payment steps (legacy rail), follow-ups, answers, counteroffers and texts to the human:
//     the engine re-decides those, or send them again through their tool.
// Job-level actions: review-job holds a job (the server's background advance skips it until resume);
// fail-safe-close asks the server to close it (failed, the human texted exactly what happened, no
// business contacted); refused while money may be moving. Steps: docs/operator-recovery.md.
//
// Needs SUPABASE_DB_URL (the engine database, migrations through 109 applied).
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { randomBytes } from "node:crypto";
import { closeSubject, DEFAULT_WORKSPACE_ID, holdSubject, recordOperatorAction, requestOperatorCallback, type OperatorAction, planChargeRelease, planFailSafeClose, planJobHold, planOutboxRetry, planRecovery, planResume, PostgresRepository, redactError, TERMINAL, type ContactCheck, type Repository, type RetryPlan, type RetryStep, type StuckFinding } from "@haggle/engine";

export type OpsCommand =
  | { kind: "list-stuck"; limit: number }
  | { kind: "list-review"; all: boolean; jobId?: string }
  | { kind: "inspect"; jobId: string }
  | { kind: "review-job"; jobId: string; note: string; by: string }
  | { kind: "resume"; jobId: string; note: string; by: string }
  | { kind: "fail-safe-close"; jobId: string; reason: string; by: string }
  | { kind: "retry-key"; key: string; override: boolean; by: string }
  | { kind: "retry-payment"; paymentId: string; override: boolean; by: string }
  | { kind: "resolve"; id: string; note: string; by: string }
  | { kind: "callback"; jobId: string; businessId: string; reason: string; by: string };

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (argv: string[], name: string) => argv.includes(`--${name}`);
const ID = /^[a-z]+_[A-Za-z0-9]{6,40}$/;

function by(argv: string[]): string {
  const who = (arg(argv, "by") ?? "").trim();
  if (who.length < 2 || who.length > 80) throw new Error("--by is required: who is doing this (it is recorded on the review and the job)");
  return who;
}

/** Validate a command line (pure). */
export function planOps(argv: string[]): OpsCommand {
  const [kind] = argv;
  if (kind === "list-stuck") {
    const limit = Number(arg(argv, "limit") ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be 1-1000");
    return { kind, limit };
  }
  if (kind === "list-review") {
    const job = arg(argv, "job");
    if (job !== undefined && !ID.test(job)) throw new Error("--job must be a job id like job_...");
    return { kind, all: flag(argv, "all"), ...(job ? { jobId: job } : {}) };
  }
  if (kind === "inspect") {
    const job = arg(argv, "job") ?? "";
    if (!ID.test(job)) throw new Error("--job must be a job id like job_...");
    return { kind, jobId: job };
  }
  if (kind === "retry") {
    const key = arg(argv, "key");
    const payment = arg(argv, "payment");
    if ((key === undefined) === (payment === undefined)) throw new Error("retry needs exactly one of --key <outbox key> or --payment <payment id>");
    if (payment !== undefined) {
      if (!ID.test(payment)) throw new Error("--payment must be a payment id like pay_...");
      if (flag(argv, "override-obligation")) throw new Error("--override-obligation is for --key; a charge needs --override-financial");
      return { kind: "retry-payment", paymentId: payment, override: flag(argv, "override-financial"), by: by(argv) };
    }
    if (!key || key.length > 300 || /\s/.test(key)) throw new Error("--key must be an outbox key (see inspect)");
    if (flag(argv, "override-financial")) throw new Error("--override-financial is for --payment; an acceptance or confirmation needs --override-obligation");
    return { kind: "retry-key", key, override: flag(argv, "override-obligation"), by: by(argv) };
  }
  if (kind === "resolve") {
    const id = arg(argv, "id") ?? "";
    if (!ID.test(id)) throw new Error("--id must be a review id like rev_...");
    const note = (arg(argv, "note") ?? "").trim();
    if (note.length < 3) throw new Error("--note is required: what you checked or did");
    return { kind, id, note: note.slice(0, 400), by: by(argv) };
  }
  if (kind === "review-job" || kind === "resume") {
    const job = arg(argv, "job") ?? "";
    if (!ID.test(job)) throw new Error("--job must be a job id like job_...");
    const note = (arg(argv, "note") ?? "").trim();
    if (note.length < 3) throw new Error(`--note is required: ${kind === "resume" ? "what you checked or fixed" : "why the job is held"}`);
    return { kind, jobId: job, note: note.slice(0, 400), by: by(argv) };
  }
  if (kind === "callback") {
    const job = arg(argv, "job") ?? "";
    if (!ID.test(job)) throw new Error("--job must be a job id like job_...");
    const biz = arg(argv, "business") ?? "";
    if (!ID.test(biz)) throw new Error("--business must be a business id like biz_... (see inspect)");
    const reason = (arg(argv, "reason") ?? "").trim();
    if (reason.length < 10 || reason.length > 400) throw new Error("--reason is required (10-400 characters): what you reviewed and why one callback is right");
    return { kind, jobId: job, businessId: biz, reason, by: by(argv) };
  }
  if (kind === "fail-safe-close" || kind === "cancel") {
    const job = arg(argv, "job") ?? "";
    if (!ID.test(job)) throw new Error("--job must be a job id like job_...");
    const reason = (arg(argv, "reason") ?? "").trim();
    if (reason.length < 3 || reason.length > 80) throw new Error("--reason is required (3-80 characters): the human reads it in the text Haggle sends");
    if (!flag(argv, "confirm")) throw new Error("fail-safe-close ends the deal for good: add --confirm once you've read docs/operator-recovery.md §fail-safe close");
    return { kind: "fail-safe-close", jobId: job, reason, by: by(argv) };
  }
  throw new Error("command must be one of: list-stuck, list-review, inspect, retry, resolve, review-job, resume, fail-safe-close (or cancel), callback");
}

/** Job-level actions (hold, resume, fail-safe close), planned from what the database holds. */
export async function planJobAction(repo: Repository, cmd: Extract<OpsCommand, { kind: "review-job" | "resume" | "fail-safe-close" }>): Promise<RetryPlan> {
  const job = await repo.getJob(cmd.jobId);
  if (cmd.kind === "fail-safe-close") return planFailSafeClose({ job, payment: job ? await repo.getPaymentForJob(job.id) : null, closeRequested: !!(await repo.findOpenReview("stuck_job", closeSubject(cmd.jobId))), reason: cmd.reason, by: cmd.by });
  const hold = await repo.findOpenReview("stuck_job", holdSubject(cmd.jobId));
  return cmd.kind === "review-job" ? planJobHold({ job, hold, note: cmd.note, by: cmd.by }) : planResume({ job, hold, note: cmd.note, by: cmd.by });
}

/**
 * The contact an outbox key reaches, checked the way a first send is: suppressed since (opt-out,
 * bounce), and still authorized for the job's workspace (its vendor list, or the operator's
 * HAGGLE_ALLOWED_RECIPIENTS; the default workspace's global roster isn't checked here).
 */
export async function contactCheck(repo: Repository, job: { id: string; workspace_id: string }, key: string, env: Record<string, string | undefined> = process.env): Promise<ContactCheck> {
  const businesses = await repo.getBusinesses(job.id);
  let biz = businesses.find((b) => key.endsWith(`:${b.business_id}`));
  const apr = key.match(/(?:^|:)(ap_[A-Za-z0-9]+)$/)?.[1];
  if (!biz && apr) {
    const a = await repo.getApproval(apr);
    biz = businesses.find((b) => b.business_id === a?.business_id);
  }
  if (!biz) return { suppressed: null, authorized: null };
  const contacts = [biz.email, biz.phone, biz.a2a_card_url].filter((c): c is string => !!c).map((c) => c.toLowerCase());
  const [hit] = await repo.findSuppressions(contacts);
  if (job.workspace_id === DEFAULT_WORKSPACE_ID) return { suppressed: hit?.reason ?? null, authorized: null };
  const vendors = new Set((await repo.listWorkspaceVendors(job.workspace_id)).map((v) => v.contact.toLowerCase()));
  const allow = (env.HAGGLE_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ok = (c: string) => vendors.has(c) || allow.some((x) => x === c || (x.startsWith("@") && /^[^@\s/:?#]+@[^@\s/:?#]+$/.test(c) && c.endsWith(x))); // @domain: email addresses only (S5-D F9)
  return { suppressed: hit?.reason ?? null, authorized: contacts.length > 0 && contacts.every(ok) };
}

/** Build the plan for a retry from what the database holds (pure given the rows). */
export async function planRetry(repo: Repository, cmd: Extract<OpsCommand, { kind: "retry-key" | "retry-payment" }>, nowMs = Date.now()): Promise<RetryPlan> {
  if (cmd.kind === "retry-payment") {
    const job = await findPaymentJob(repo, cmd.paymentId);
    const payment = job ? await repo.getPaymentForJob(job) : null;
    const p = payment?.id === cmd.paymentId ? payment : null;
    return planChargeRelease({ payment: p, review: p ? await repo.findOpenReview("payment", p.id) : null, override: cmd.override, by: cmd.by });
  }
  const row = await repo.getOutbox(cmd.key);
  const job = row?.job_id ? await repo.getJob(row.job_id) : null;
  const biz = job ? (await repo.getBusinesses(job.id)).find((b) => cmd.key.endsWith(`:${b.business_id}`)) : undefined;
  const contact = job ? await contactCheck(repo, job, cmd.key) : undefined;
  return planOutboxRetry({ key: cmd.key, row, review: await repo.findOpenReview("outbox", cmd.key), job, businessStatus: biz?.status ?? null, override: cmd.override, by: cmd.by, nowMs, ...(contact ? { contact } : {}) });
}

/** The payment's job (payments are read per job): the review row names it. */
async function findPaymentJob(repo: Repository, paymentId: string): Promise<string | null> {
  return (await repo.findOpenReview("payment", paymentId))?.job_id ?? null;
}

/** Apply a plan's steps in order. Resolving the review comes first: an open review blocks the claim. */
export async function applySteps(repo: Repository, steps: RetryStep[], now: string): Promise<string[]> {
  const done: string[] = [];
  for (const s of steps) {
    if (s.op === "resolve_review") {
      if (!(await repo.resolveReview(s.id, { resolution: s.resolution, resolved_by: s.by }, now))) throw new Error(`review ${s.id} is no longer open; nothing changed after it`);
    } else if (s.op === "rearm_outbox") {
      if (!(await repo.rearmOutbox(s.key, now))) throw new Error(`outbox ${s.key} can't be re-armed (sent, or a call that may have rung)`);
    } else if (s.op === "requeue_business") {
      await repo.updateBusiness(s.jobId, s.businessId, { status: "pending", next_attempt_at: now, send_attempts: 0 }, { ifStatus: ["pending", "bounced", "unavailable"] });
      await repo.touchJob(s.jobId);
    } else if (s.op === "open_review") {
      const { created } = await repo.openReview({ id: `rev_${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`, ...s.review, attempts: 0, last_error: null }, now);
      if (!created) throw new Error(`an open review for [${s.review.subject}] already exists; nothing changed after it`);
    } else {
      await repo.appendEvent(s.jobId, s.type, s.data);
      await repo.touchJob(s.jobId);
    }
    done.push(s.op);
  }
  return done;
}

/** The operator-log entry for a change job-ops made (migration 119). */
export async function logJobAction(repo: Repository, cmd: OpsCommand, detail: Record<string, unknown> = {}): Promise<void> {
  const map: Partial<Record<OpsCommand["kind"], OperatorAction>> = { "review-job": "job_held", resume: "job_resumed", "fail-safe-close": "job_close_requested", "retry-key": "retry_requested", "retry-payment": "retry_requested", resolve: "review_resolved" };
  const action = map[cmd.kind];
  if (!action || !("by" in cmd)) return;
  const jobId = "jobId" in cmd ? cmd.jobId : typeof detail.job_id === "string" ? detail.job_id : null;
  const job = jobId ? await repo.getJob(jobId) : null;
  const reason = "note" in cmd ? cmd.note : "reason" in cmd ? cmd.reason : cmd.kind === "retry-key" ? `retry ${cmd.key}${cmd.override ? " (override)" : ""}` : cmd.kind === "retry-payment" ? `retry ${cmd.paymentId}${cmd.override ? " (override)" : ""}` : "operator action";
  await recordOperatorAction(repo, { action, operator: cmd.by, reason, workspaceId: job?.workspace_id ?? null, jobId: job?.id ?? null, detail: { ...detail, ...("key" in cmd ? { key: cmd.key } : {}), ...("paymentId" in cmd ? { payment_id: cmd.paymentId } : {}), ...("id" in cmd ? { review_id: cmd.id } : {}) } });
}

/** Record in the operator log; the change already happened, so a failure is a warning (exit 1), not a rollback. */
async function logOrWarn(repo: Repository, cmd: OpsCommand, detail: Record<string, unknown> = {}) {
  try {
    await logJobAction(repo, cmd, detail);
  } catch (e) {
    console.error(`WARNING: done, but not recorded in the operator log (${(e as Error).message})`);
    process.exitCode = 1;
  }
}

export const formatFinding = (f: StuckFinding) =>
  `${f.job_id}  ${f.issue.padEnd(22)} ${f.action.padEnd(12)} ${Math.round(f.overdue_ms / 60_000)}m  ${f.subject ? `[${f.subject}] ` : ""}${f.detail}`;

/** Every open job and recently closed one, through the same planner the server's tick uses (read only). */
export async function listStuck(repo: Repository, nowMs: number, limit: number): Promise<StuckFinding[]> {
  const open = (await repo.listOpenJobs()).slice(0, limit);
  const closed = (await repo.listRecentJobs(50)).filter((j) => TERMINAL.has(j.state) && nowMs - Date.parse(j.updated_at) < 7 * 86_400_000);
  const out: StuckFinding[] = [];
  for (const job of [...open, ...closed]) {
    const [businesses, approval, payment, outbox, pending] = await Promise.all([repo.getBusinesses(job.id), repo.getLatestApproval(job.id), repo.getPaymentForJob(job.id), repo.listOutbox({ jobId: job.id }), repo.getPendingMessages(job.id)]);
    const [booking, handoff] = approval ? await Promise.all([repo.getBookingByApproval(approval.id), repo.getHandoffByApproval(approval.id)]) : [null, null];
    out.push(...planRecovery({ job, businesses, approval, payment, outbox, pendingMessages: pending.length, booking, handoff }, nowMs));
  }
  return out;
}

const mask = (c: string | null) => (c ? c.replace(/^(.).*(@.*)$/, "$1***$2").replace(/^(\+\d{2}).*(\d{2})$/, "$1***$2") : "-");

async function inspect(repo: Repository, jobId: string, nowMs: number): Promise<string> {
  const job = await repo.getJob(jobId);
  if (!job) throw new Error(`no job ${jobId}`);
  const [businesses, outbox, reviews, approval, payment, events] = await Promise.all([repo.getBusinesses(jobId), repo.listOutbox({ jobId }), repo.listReviews({ jobId, limit: 50 }), repo.getLatestApproval(jobId), repo.getPaymentForJob(jobId), repo.listEvents(jobId)]);
  const findings = planRecovery({ job, businesses, approval, payment, outbox, pendingMessages: (await repo.getPendingMessages(jobId)).length }, nowMs);
  return [
    `${job.id} HG-${job.short_code} · ${job.state}${job.ready ? " (ready)" : ""} · round ${job.round}/${job.max_rounds} · reply-by ${job.collect_until} · workspace ${job.workspace_id} · ${job.mode}`,
    "", "Businesses:", ...businesses.map((b) => `  ${b.business_id} ${b.name} · ${b.channel} ${mask(b.email ?? b.phone)} · ${b.status}${b.next_attempt_at ? ` · next attempt ${b.next_attempt_at}` : ""}`),
    "", "Outbox:", ...(outbox.length ? outbox.map((o) => `  ${o.key} · ${o.kind} · ${o.status} · attempts ${o.attempts} · ${o.updated_at}`) : ["  (none)"]),
    "", `Approval: ${approval ? `${approval.id} ${approval.status} · quote ${approval.quote_id} · pay ${approval.payment_cents}c · expires ${approval.expires_at}` : "none"}`,
    `Payment: ${payment ? `${payment.id} ${payment.rail} ${payment.status} · ${payment.amount_cents}c${payment.reason ? ` · ${redactError(payment.reason)}` : ""}` : "none"}`,
    "", "Reviews:", ...(reviews.length ? reviews.map((r) => `  ${r.id} · ${r.status} · ${r.kind} [${r.subject}] · ${r.reason} · attempts ${r.attempts}${r.last_error ? ` · ${r.last_error}` : ""}${r.resolution ? ` · resolved: ${r.resolution}` : ""}`) : ["  (none)"]),
    "", "Stuck:", ...(findings.length ? findings.map((f) => `  ${formatFinding(f)}`) : ["  (nothing overdue)"]),
    "", "Last events:", ...events.slice(-20).map((e) => `  #${e.seq} ${e.at} ${e.type}${typeof e.data.summary === "string" ? `: ${redactError(e.data.summary)}` : ""}`),
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planOps(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  const now = new Date();
  try {
    if (cmd.kind === "list-stuck") {
      const f = await listStuck(repo, now.getTime(), cmd.limit);
      console.log(f.length ? f.map(formatFinding).join("\n") : "Nothing is overdue.");
    } else if (cmd.kind === "list-review") {
      const list = await repo.listReviews({ ...(cmd.all ? {} : { status: "open" as const }), ...(cmd.jobId ? { jobId: cmd.jobId } : {}), limit: 200 });
      console.log(list.length ? list.map((r) => `${r.id} · ${r.status} · ${r.kind} · job ${r.job_id ?? "-"} · [${r.subject}] · ${r.reason} · attempts ${r.attempts} · ${r.created_at}${r.last_error ? `\n    last error: ${r.last_error}` : ""}`).join("\n") : "No reviews.");
    } else if (cmd.kind === "inspect") {
      console.log(await inspect(repo, cmd.jobId, now.getTime()));
    } else if (cmd.kind === "resolve") {
      const r = await repo.resolveReview(cmd.id, { resolution: cmd.note, resolved_by: cmd.by }, now.toISOString());
      if (!r) throw new Error(`review ${cmd.id} isn't open`);
      if (r.job_id) await repo.appendEvent(r.job_id, "operator_resolved", { review_id: r.id, kind: r.kind, by: cmd.by });
      await logOrWarn(repo, cmd, { job_id: r.job_id });
      console.log(`Resolved ${r.id} (${r.kind} [${r.subject}]): ${cmd.note}. Nothing was re-sent.`);
    } else if (cmd.kind === "callback") {
      const r = await requestOperatorCallback(repo, { jobId: cmd.jobId, businessId: cmd.businessId, by: cmd.by, reason: cmd.reason, now: now.toISOString() });
      if (!r.ok) throw new Error(`refused: ${r.reason}`);
      console.log(`Callback requested (review ${r.reviewId}). On the job's next advance the server places it only if the engine's checks pass (a justified proposal, a round left, the callee's recorded consent); job-ops inspect --job ${cmd.jobId} shows the outcome. Nothing is approved or paid.`);
    } else if (cmd.kind === "review-job" || cmd.kind === "resume" || cmd.kind === "fail-safe-close") {
      const plan = await planJobAction(repo, cmd);
      if (!plan.ok) throw new Error(`refused: ${plan.reason}`);
      await applySteps(repo, plan.steps, now.toISOString());
      await logOrWarn(repo, cmd);
      console.log(`Done (${plan.steps.map((s) => s.op).join(", ")}): ${plan.note}.`);
    } else {
      const plan = await planRetry(repo, cmd, now.getTime());
      if (!plan.ok) throw new Error(`refused: ${plan.reason}`);
      await applySteps(repo, plan.steps, now.toISOString());
      const jobOf = plan.steps.find((x): x is Extract<RetryStep, { jobId: string }> => "jobId" in x);
      await logOrWarn(repo, cmd, jobOf ? { job_id: jobOf.jobId } : {});
      console.log(`Done (${plan.steps.map((s) => s.op).join(", ")}): ${plan.note}.`);
    }
  } finally {
    await repo.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/job-ops.ts")) {
  main().catch((e) => {
    console.error(`job-ops failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
