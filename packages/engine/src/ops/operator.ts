// Operator actions from the scripts (sprint 5, workstream B; migration 119). Never reachable from an
// MCP tool or the model. Every action is recorded append-only with who, why and when. Nothing here
// approves, pays or names a payee: an operator can stop things (suspend, hold, close, revoke) and
// can ask the running server to do one reviewed thing (a callback to a consenting vendor, routing a
// held text), which the engine then performs through every normal check.
import { callbackConsent } from "../workflow/callbackAuth.ts";
import { holdSubject } from "../workflow/deadLetter.ts";
import { TERMINAL } from "../workflow/stateMachine.ts";
import { newId } from "../ids.ts";
import type { JobRow, OperatorAction, OperatorActionRow, OperatorReviewRow, Repository } from "../store/types.ts";

export type ActionRepo = Pick<Repository, "appendOperatorAction" | "listOperatorActions">;

/** Record one action; refused (nothing recorded) when the database lacks migration 119. */
export async function recordOperatorAction(repo: ActionRepo, a: { action: OperatorAction; operator: string; reason: string; workspaceId?: string | null; jobId?: string | null; detail?: Record<string, unknown> }): Promise<OperatorActionRow> {
  if (!repo.appendOperatorAction) throw new Error("this database has no operator_actions table: apply supabase/migrations/119_engine_pilot.sql");
  return repo.appendOperatorAction({ id: newId("opa"), workspace_id: a.workspaceId ?? null, job_id: a.jobId ?? null, action: a.action, operator: a.operator.trim().slice(0, 80), reason: a.reason.trim().slice(0, 500), detail: a.detail ?? {} });
}

/** Missing table (42P01) reads as "nothing recorded": nobody can have been suspended or verified without it. */
async function listActions(repo: ActionRepo, q: Parameters<NonNullable<Repository["listOperatorActions"]>>[0]): Promise<OperatorActionRow[]> {
  if (!repo.listOperatorActions) return [];
  try {
    return await repo.listOperatorActions(q);
  } catch (e) {
    if ((e as { code?: unknown })?.code === "42P01") return [];
    throw e;
  }
}

export interface Suspension { by: string; reason: string; at: string }

/** The workspace's suspension (the latest suspend/resume row decides), or null when active. */
export async function workspaceSuspension(repo: ActionRepo, workspaceId: string): Promise<Suspension | null> {
  const [last] = await listActions(repo, { workspaceId, actions: ["workspace_suspended", "workspace_resumed"], limit: 1 });
  return last?.action === "workspace_suspended" ? { by: last.operator, reason: last.reason, at: last.at } : null;
}

export interface ApproverVerification { phone: string; by: string; how: string; at: string }

/**
 * Is this approver phone verified? Only an approver_verified row for exactly this number, not
 * superseded by a later approver change or approver_unverified. Any approver change needs a new one.
 */
export async function approverVerification(repo: ActionRepo, workspaceId: string, phone: string | null | undefined): Promise<ApproverVerification | null> {
  if (!phone) return null;
  const [last] = await listActions(repo, { workspaceId, actions: ["approver_verified", "approver_unverified", "approver_changed"], limit: 1 });
  return last?.action === "approver_verified" && last.detail.phone === phone ? { phone, by: last.operator, how: last.reason, at: last.at } : null;
}

const SUSPENSION_HOLD = "workspace suspended";

/**
 * Suspend a workspace: recorded first (its credentials then get WORKSPACE_SUSPENDED on every tool
 * call), then every open deal is put on an operator hold, so nothing more is sent for it (no RFQs,
 * follow-ups, counters, calls or booking requests). Inbound replies are still stored; a human's own
 * coded text still records their decision, but nothing goes out until resume. Credentials stay valid.
 */
export async function suspendWorkspace(repo: Repository, i: { workspaceId: string; by: string; reason: string; now: string }): Promise<{ held: string[]; alreadyHeld: string[] }> {
  if (!(await repo.getWorkspace(i.workspaceId))) throw new Error(`no workspace ${i.workspaceId}`);
  if (await workspaceSuspension(repo, i.workspaceId)) throw new Error(`workspace ${i.workspaceId} is already suspended`);
  await recordOperatorAction(repo, { action: "workspace_suspended", operator: i.by, reason: i.reason, workspaceId: i.workspaceId });
  const held: string[] = [];
  const alreadyHeld: string[] = [];
  for (const job of (await repo.listOpenJobs()).filter((j) => j.workspace_id === i.workspaceId)) {
    if (await repo.findOpenReview("stuck_job", holdSubject(job.id))) { alreadyHeld.push(job.id); continue; }
    const { created } = await repo.openReview({ id: newId("rev"), job_id: job.id, kind: "stuck_job", subject: holdSubject(job.id), reason: `${SUSPENSION_HOLD} by ${i.by}: ${i.reason}`.slice(0, 200), attempts: 0, last_error: null }, i.now);
    if (!created) { alreadyHeld.push(job.id); continue; }
    await repo.appendEvent(job.id, "operator_hold", { by: i.by, note: `workspace suspended: ${i.reason}`.slice(0, 400), suspension: true });
    await repo.touchJob(job.id);
    held.push(job.id);
  }
  return { held, alreadyHeld };
}

/** Lift a suspension: recorded, and only the holds the suspension placed are lifted (an operator's own hold stays). */
export async function resumeWorkspace(repo: Repository, i: { workspaceId: string; by: string; reason: string; now: string }): Promise<{ resumed: string[]; stillHeld: string[] }> {
  if (!(await workspaceSuspension(repo, i.workspaceId))) throw new Error(`workspace ${i.workspaceId} isn't suspended`);
  await recordOperatorAction(repo, { action: "workspace_resumed", operator: i.by, reason: i.reason, workspaceId: i.workspaceId });
  const resumed: string[] = [];
  const stillHeld: string[] = [];
  for (const job of (await repo.listOpenJobs()).filter((j) => j.workspace_id === i.workspaceId)) {
    const hold = await repo.findOpenReview("stuck_job", holdSubject(job.id));
    if (!hold) continue;
    if (!hold.reason.startsWith(SUSPENSION_HOLD)) { stillHeld.push(job.id); continue; }
    if (!(await repo.resolveReview(hold.id, { resolution: `workspace resumed by ${i.by}: ${i.reason}`.slice(0, 500), resolved_by: i.by.slice(0, 120) }, i.now))) continue;
    await repo.appendEvent(job.id, "operator_resume", { by: i.by, note: `workspace resumed: ${i.reason}`.slice(0, 400), suspension: true });
    await repo.touchJob(job.id);
    resumed.push(job.id);
  }
  return { resumed, stillHeld };
}

// ───────────────────────────── review-mediated requests (job-ops callback, quarantine release-text) ─────────────────────────────

/** An operator request is an open `stuck_job` review with one of these subjects; the job's next advance performs it. */
export const callbackRequestSubject = (jobId: string, businessId: string) => `opreq:callback:${jobId}:${businessId}`;
export const textReleaseSubject = (messageId: string) => `opreq:release-text:${messageId}`;
const REQUEST_PREFIX = "opreq:";

type RequestResult = { ok: true; reviewId: string } | { ok: false; reason: string };

async function openRequest(repo: Repository, job: JobRow, subject: string, kind: "callback" | "release_text", by: string, reason: string, data: Record<string, unknown>, now: string): Promise<RequestResult> {
  if (await repo.findOpenReview("stuck_job", subject)) return { ok: false, reason: "the same request is already waiting for the server (job-ops inspect shows it)" };
  const id = newId("rev");
  const { created } = await repo.openReview({ id, job_id: job.id, kind: "stuck_job", subject, reason: `${kind.replace("_", " ")} requested by ${by}: ${reason}`.slice(0, 200), attempts: 0, last_error: null }, now);
  if (!created) return { ok: false, reason: "the same request is already waiting for the server" };
  await repo.appendEvent(job.id, "operator_request", { subject, kind, by, reason, review_id: id, ...data });
  await repo.touchJob(job.id);
  return { ok: true, reviewId: id };
}

/**
 * Ask the running server to call one business back on a deal (job-ops callback). The operator has
 * reviewed the deal; the engine still requires an evidence-based callback proposal (a cheaper
 * competing quote, a round left) and the callee's recorded consent, and places at most one call.
 * Refused here early when consent is already known to be missing.
 */
export async function requestOperatorCallback(repo: Repository, i: { jobId: string; businessId: string; by: string; reason: string; now: string }): Promise<RequestResult> {
  const job = await repo.getJob(i.jobId);
  if (!job) return { ok: false, reason: "no such job" };
  if (TERMINAL.has(job.state)) return { ok: false, reason: `job is ${job.state}; nobody is called about a closed deal` };
  if (await repo.findOpenReview("stuck_job", holdSubject(job.id))) return { ok: false, reason: "job is on hold (or its workspace is suspended); resume it first" };
  if (await workspaceSuspension(repo, job.workspace_id)) return { ok: false, reason: "the job's workspace is suspended" };
  const b = (await repo.getBusinesses(job.id)).find((x) => x.business_id === i.businessId);
  if (!b) return { ok: false, reason: "that business isn't on this deal (see job-ops inspect)" };
  if (job.mode === "live") {
    const consent = callbackConsent({ business: b, workspaceVendors: await repo.listWorkspaceVendors(job.workspace_id), messages: await repo.listMessages(job.id), suppressed: b.phone ? (await repo.findSuppressions([b.phone])).length > 0 : false });
    if (!consent.ok) return { ok: false, reason: `no consent to call: ${consent.reason}` };
  }
  const r = await openRequest(repo, job, callbackRequestSubject(job.id, b.business_id), "callback", i.by, i.reason, { business_id: b.business_id }, i.now);
  if (r.ok) await recordOperatorAction(repo, { action: "callback_requested", operator: i.by, reason: i.reason, workspaceId: job.workspace_id, jobId: job.id, detail: { business_id: b.business_id, review_id: r.reviewId } });
  return r;
}

/**
 * Ask the running server to route a text held as ambiguous (several workspaces share the number)
 * to one open deal (quarantine release-text). The engine (releaseHeldText) re-checks that the number
 * belongs to that deal and refuses an approval, payment or callback reply (the human resends those
 * with the deal code). Refused here early for what is already known.
 */
export async function requestTextRelease(repo: Repository, i: { messageId: string; jobId: string; by: string; reason: string; now: string }): Promise<RequestResult> {
  const m = await repo.getMessage(i.messageId);
  if (!m || m.kind !== "quarantine" || m.quarantine_reason !== "ambiguous_workspace" || m.job_id !== null) return { ok: false, reason: "no held ambiguous text with that id (quarantine list shows held texts with reason ambiguous_workspace)" };
  const job = await repo.getJob(i.jobId);
  if (!job || TERMINAL.has(job.state)) return { ok: false, reason: "that deal isn't open" };
  if (await repo.findOpenReview("stuck_job", holdSubject(job.id))) return { ok: false, reason: "job is on hold (or its workspace is suspended); resume it first" };
  if (await workspaceSuspension(repo, job.workspace_id)) return { ok: false, reason: "the job's workspace is suspended" };
  const r = await openRequest(repo, job, textReleaseSubject(m.id), "release_text", i.by, i.reason, { message_id: m.id }, i.now);
  if (r.ok) await recordOperatorAction(repo, { action: "text_release_requested", operator: i.by, reason: i.reason, workspaceId: job.workspace_id, jobId: job.id, detail: { message_id: m.id, review_id: r.reviewId } });
  return r;
}

export interface OperatorRequestDeps {
  repo: Repository;
  now: () => Date;
  callback: (jobId: string, businessId: string, operator: string) => Promise<unknown>;
  releaseText: (messageId: string, jobId: string, operator: string) => Promise<{ outcome: string }>;
  /** Refusals the operator should read (EngineError): recorded and closed, never retried. */
  isRefusal: (e: unknown) => e is Error & { code: string };
  log: (event: string, data: Record<string, unknown>) => void;
}

/** Transient failures before a request is closed as failed (the operator can ask again). */
const MAX_REQUEST_ATTEMPTS = 3;

/**
 * Run a job's open operator requests (called from the job's advance, under its lease; skipped while
 * the job is on hold). Each is performed once through the engine's own checks; the outcome closes
 * the review and is recorded as a job event. A refusal is final; a transient error is retried on the
 * next advance, at most three times.
 */
export async function runOperatorRequests(d: OperatorRequestDeps, job: JobRow, open: OperatorReviewRow[]): Promise<void> {
  const reqs = open.filter((r) => r.subject.startsWith(REQUEST_PREFIX) && r.status === "open");
  if (!reqs.length) return;
  const events = await d.repo.listEvents(job.id);
  for (const r of reqs) {
    const ask = events.filter((e) => e.type === "operator_request" && e.data.subject === r.subject).at(-1)?.data ?? {};
    const by = typeof ask.by === "string" && ask.by.trim().length >= 2 ? `operator:${ask.by.trim().slice(0, 60)}` : "operator";
    const operator = by.slice("operator:".length) || "operator";
    const close = async (resolution: string, data: Record<string, unknown>) => {
      if (await d.repo.resolveReview(r.id, { resolution: resolution.slice(0, 500), resolved_by: "haggle-server" }, d.now().toISOString())) await d.repo.appendEvent(job.id, "operator_request_done", { subject: r.subject, review_id: r.id, ...data });
    };
    try {
      const cb = r.subject.match(/^opreq:callback:[^:]+:(.+)$/);
      const rel = r.subject.match(/^opreq:release-text:(.+)$/);
      if (cb) {
        await d.callback(job.id, cb[1]!, operator);
        await close(`callback placed through the engine's checks (${by})`, { outcome: "callback_placed" });
      } else if (rel) {
        const out = await d.releaseText(rel[1]!, job.id, operator);
        await close(`held text routed to this deal: ${out.outcome}`, { outcome: out.outcome });
      } else {
        await close("unknown operator request; nothing done", { outcome: "unknown" });
      }
    } catch (e) {
      if (d.isRefusal(e)) {
        await close(`refused (${e.code}): ${e.message}`, { outcome: "refused", code: e.code });
        continue;
      }
      const failures = events.filter((x) => x.type === "operator_request_failed" && x.data.subject === r.subject).length + 1;
      await d.repo.appendEvent(job.id, "operator_request_failed", { subject: r.subject, attempt: failures });
      d.log("operator_request_failed", { job_id: job.id, subject: r.subject, attempt: failures });
      if (failures >= MAX_REQUEST_ATTEMPTS) await close(`failed ${failures} times; nothing more will be tried (ask again once the cause is fixed)`, { outcome: "failed" });
    }
  }
}
