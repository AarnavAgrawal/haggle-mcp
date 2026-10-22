// The operator report (apps/mcp/scripts/ops-report.ts): everything that waits on a person, per
// workspace. Read-only by construction: it takes only the repository's read methods. Built from the
// same planners the server acts with (workflow/recovery.ts, ops/stalled.ts, workflow/callbackAuth.ts,
// inbound/quarantineReasons.ts), so the report and the server never disagree about what is stuck.
//
// `attention` flattens it into "what needs a person right now": one item per thing, oldest first,
// each with who it waits on and the exact operator script command to run next (formatOpsBrief).
// Contacts are masked (maskHandle); message bodies, approval / BOOKED / CALL / CANCEL codes and their
// hashes are never read into the report.
import { explainQuarantine } from "../inbound/quarantineReasons.ts";
import { redactText } from "../live/log.ts";
import type { JobEventRow, JobRow, MessageRow, OperatorReviewRow, Repository } from "../store/types.ts";
import { pendingCallbackAuths } from "../workflow/callbackAuth.ts";
import { maskHandle } from "../workflow/engine.ts";
import { planRecovery, type StuckFinding } from "../workflow/recovery.ts";
import { findStalledJobs, type StalledJob } from "./stalled.ts";

export type ReportRepo = Pick<Repository,
  "listOpenJobs" | "listRecentJobs" | "listReviews" | "getLatestApproval" | "getBusinesses" | "listOutbox" | "listMessages" | "getPendingMessages"
  | "getPaymentForJob" | "getBookingByApproval" | "getHandoffByApproval" | "getHandoffReceipt" | "listEvents" | "getJob" | "listQuarantinedMessages" | "listQuarantineResolutions">;

export type HandoffStage =
  | "awaiting_vendor_confirmation" | "vendor_claimed_awaiting_booked" | "not_in_writing_awaiting_attestation"
  | "awaiting_payment_instructions" | "awaiting_customer_payment" | "customer_paid_no_receipt";

/** Who has to act for an item to move. */
export type WaitingOn = "operator" | "approver" | "business";

export interface OpsReportWorkspace {
  workspace_id: string;
  open_jobs: number;
  pending_approvals: { job_id: string; short_code: string; approval_id: string; channel: string; expires_at: string; expired: boolean; requested_at: string; age_h: number }[];
  reviews: { id: string; kind: OperatorReviewRow["kind"]; job_id: string | null; subject: string; reason: string; attempts: number; age_h: number }[];
  failed_communications: { job_id: string; what: string; status: string; attempts: number | null; since: string }[];
  /** Every quarantined inbound row on this workspace's jobs (resolved and delivery reports included); `quarantined_emails` is what still needs a decision. */
  quarantined_replies: number;
  stalled_jobs: (Pick<StalledJob, "job_id" | "state" | "reason"> & { age_h: number })[];
  recovery: Pick<StuckFinding, "job_id" | "issue" | "action" | "detail" | "subject">[];
  /** Bookings and manual payment handoffs not yet settled. `stalled`: reminded once already (or, for a missing receipt, past the grace period). */
  handoffs_awaiting: { job_id: string; approval_id: string; business: string; kind: "booking" | "payment"; stage: HandoffStage; since: string; age_h: number; stalled: boolean }[];
  /** Held vendor email with no operator decision yet (bounce reports excluded). `from` is masked. */
  quarantined_emails: { message_id: string; job_id: string | null; business_id: string | null; from: string; reason: string; explanation: string; action: string; releasable: boolean; received_at: string; age_h: number }[];
  /** CALL / CANCEL codes texted to the approver and not yet answered, decided, locked or expired. */
  pending_authorizations: { job_id: string; kind: "callback" | "cancel"; auth_id: string; business: string; requested_at: string; expires_at: string; wrong_codes: number; age_h: number }[];
  /** Texts held because their number is on deals in several workspaces (workspace "unscoped" only). `from` is masked. */
  held_texts: { message_id: string; from: string; received_at: string; age_h: number; release_requested: boolean; release_job_id: string | null }[];
}

export type AttentionCategory = "stalled_job" | "quarantined_email" | "pending_approval" | "booking" | "payment_handoff" | "authorization" | "held_text" | "review" | "failed_communication";
export const ATTENTION_CATEGORIES: readonly AttentionCategory[] = ["stalled_job", "quarantined_email", "pending_approval", "booking", "payment_handoff", "authorization", "held_text", "review", "failed_communication"];

export interface AttentionItem {
  category: AttentionCategory;
  workspace_id: string;
  job_id: string | null;
  /** When the wait started (ISO); items are sorted by it, oldest first. */
  since: string;
  age_h: number;
  waiting_on: WaitingOn;
  /** One line, masked. */
  what: string;
  /** The next command, run from apps/mcp as `node --env-file=.env <command>`. Placeholders in <angle brackets>. */
  command: string;
  alt_command?: string;
}

export interface OpsReport {
  generated_at: string;
  /** Closed jobs are included this long after their last change (late replies, unsent confirmations). */
  closed_window_days: number;
  totals: {
    workspaces: number; open_jobs: number; pending_approvals: number; open_reviews: number; failed_communications: number; quarantined_replies: number; stalled_jobs: number; handoffs_awaiting: number;
    quarantined_emails: number; pending_authorizations: number; held_texts: number;
  };
  workspaces: OpsReportWorkspace[];
  attention: { status: "ALL CLEAR" | "ATTENTION"; total: number; by_category: Record<AttentionCategory, number>; items: AttentionItem[] };
}

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
/** A business may take a while to acknowledge a payment; past this the missing receipt needs a person. */
export const RECEIPT_GRACE_MS = 24 * 3_600_000;
/** Never releasable (inbound/quarantineReview.ts): likely spoofed, or a delivery report. */
const NOT_RELEASABLE = new Set(["identity_unverified:auth_failed", "bounce", "bounce_soft", "bounce_unmatched"]);
const RELEASABLE_STATES = new Set(["contacting", "collecting", "negotiating", "awaiting_approval"]);
const UNSCOPED = "unscoped";
const hours = (ms: number) => Math.round((Math.max(0, ms) / 3_600_000) * 10) / 10;
const heldReason = (m: Pick<MessageRow, "quarantine_reason" | "trust_reason">) => (m.quarantine_reason ?? m.trust_reason ?? "unverified").slice(0, 200);

const emptyWorkspace = (id: string): OpsReportWorkspace => ({ workspace_id: id, open_jobs: 0, pending_approvals: [], reviews: [], failed_communications: [], quarantined_replies: 0, stalled_jobs: [], recovery: [], handoffs_awaiting: [], quarantined_emails: [], pending_authorizations: [], held_texts: [] });

export async function buildOpsReport(repo: ReportRepo, opts: { now?: Date; workspaceId?: string; closedWindowDays?: number; maxJobs?: number } = {}): Promise<OpsReport> {
  const now = opts.now ?? new Date();
  const at = now.getTime();
  const days = opts.closedWindowDays ?? 7;
  const open = await repo.listOpenJobs();
  const closed = (await repo.listRecentJobs(opts.maxJobs ?? 500)).filter((j) => TERMINAL.has(j.state) && at - Date.parse(j.updated_at) < days * 86_400_000);
  const jobs = [...open, ...closed.filter((c) => !open.some((o) => o.id === c.id))].filter((j) => !opts.workspaceId || j.workspace_id === opts.workspaceId).slice(0, opts.maxJobs ?? 500);
  const byWs = new Map<string, OpsReportWorkspace>();
  const ws = (id: string) => {
    let w = byWs.get(id);
    if (!w) byWs.set(id, (w = emptyWorkspace(id)));
    return w;
  };
  const jobWs = new Map<string, string>(jobs.map((j) => [j.id, j.workspace_id]));
  for (const s of await findStalledJobs(repo, now)) {
    if (jobWs.has(s.job_id)) ws(s.workspace_id).stalled_jobs.push({ job_id: s.job_id, state: s.state, reason: s.reason, age_h: hours(s.age_s * 1000) });
  }
  for (const job of jobs) await addJob(repo, ws(job.workspace_id), job, at);
  // Open reviews: by their job's workspace; a review with no job (a reconciler give-up) under "unscoped".
  const openReviews = await repo.listReviews({ status: "open", limit: 1000 });
  for (const r of openReviews) {
    const w = r.job_id ? jobWs.get(r.job_id) : undefined;
    if (opts.workspaceId && w !== opts.workspaceId) continue;
    ws(w ?? (r.job_id ? "unknown_job" : UNSCOPED)).reviews.push({ id: r.id, kind: r.kind, job_id: r.job_id, subject: r.subject, reason: r.reason, attempts: r.attempts, age_h: hours(at - Date.parse(r.created_at)) });
  }
  await addQuarantine(repo, { ws, jobWs, at, days, workspaceId: opts.workspaceId, openReviews });
  const workspaces = [...byWs.values()].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id));
  const sum = (f: (w: OpsReportWorkspace) => number) => workspaces.reduce((n, w) => n + f(w), 0);
  return {
    generated_at: now.toISOString(),
    closed_window_days: days,
    totals: {
      workspaces: workspaces.length, open_jobs: sum((w) => w.open_jobs), pending_approvals: sum((w) => w.pending_approvals.length), open_reviews: sum((w) => w.reviews.length),
      failed_communications: sum((w) => w.failed_communications.length), quarantined_replies: sum((w) => w.quarantined_replies), stalled_jobs: sum((w) => w.stalled_jobs.length), handoffs_awaiting: sum((w) => w.handoffs_awaiting.length),
      quarantined_emails: sum((w) => w.quarantined_emails.length), pending_authorizations: sum((w) => w.pending_authorizations.length), held_texts: sum((w) => w.held_texts.length),
    },
    workspaces,
    attention: attentionOf(workspaces, at),
  };
}

const lastEvent = (events: JobEventRow[], pred: (e: JobEventRow) => boolean) => events.filter(pred).at(-1) ?? null;

async function addJob(repo: ReportRepo, w: OpsReportWorkspace, job: JobRow, at: number) {
  const [approval, businesses, outbox, messages, pending, payment] = await Promise.all([
    repo.getLatestApproval(job.id), repo.getBusinesses(job.id), repo.listOutbox({ jobId: job.id }), repo.listMessages(job.id), repo.getPendingMessages(job.id), repo.getPaymentForJob(job.id),
  ]);
  const open = !TERMINAL.has(job.state);
  if (open) w.open_jobs++;
  if (approval?.status === "pending" && open) w.pending_approvals.push({ job_id: job.id, short_code: job.short_code, approval_id: approval.id, channel: approval.channel, expires_at: approval.expires_at, expired: Date.parse(approval.expires_at) < at, requested_at: approval.created_at, age_h: hours(at - Date.parse(approval.created_at)) });
  for (const o of outbox) if (o.status === "not_sent" || o.status === "unknown") w.failed_communications.push({ job_id: job.id, what: `${o.kind} ${o.key}`, status: o.status, attempts: o.attempts, since: o.updated_at });
  for (const b of businesses) if (b.status === "bounced") w.failed_communications.push({ job_id: job.id, what: `${b.channel} to ${b.name}`, status: "bounced", attempts: b.send_attempts, since: b.contacted_at ?? job.updated_at });
  w.quarantined_replies += messages.filter((m) => m.direction === "in" && m.quarantine_reason).length;
  const [booking, handoff] = approval ? await Promise.all([repo.getBookingByApproval(approval.id), repo.getHandoffByApproval(approval.id)]) : [null, null];
  const name = (businessId: string) => businesses.find((b) => b.business_id === businessId)?.name ?? businessId;
  const events = open || booking || handoff ? await repo.listEvents(job.id) : [];
  if (approval) {
    const push = (kind: "booking" | "payment", stage: HandoffStage, since: string, stalled: boolean) =>
      w.handoffs_awaiting.push({ job_id: job.id, approval_id: approval.id, business: name(approval.business_id), kind, stage, since, age_h: hours(at - Date.parse(since)), stalled });
    if (booking?.status === "awaiting_vendor_confirmation") {
      // The vendor said "confirmed" on a channel that can't prove who it is: only the approver's BOOKED <code> books it.
      const claim = lastEvent(events, (e) => e.type === "booking" && e.data.approval_id === approval.id && e.data.status === "vendor_claims_confirmed");
      if (claim) push("booking", "vendor_claimed_awaiting_booked", typeof claim.data.at === "string" ? claim.data.at : claim.at, !!booking.stalled_at);
      else push("booking", "awaiting_vendor_confirmation", booking.created_at, !!booking.stalled_at);
    }
    if (booking?.status === "not_in_writing" && !booking.human_attested_at) push("booking", "not_in_writing_awaiting_attestation", booking.created_at, !!booking.stalled_at);
    if (handoff && (handoff.status === "instructions_requested" || handoff.status === "instructions_received")) {
      push("payment", handoff.status === "instructions_requested" ? "awaiting_payment_instructions" : "awaiting_customer_payment", handoff.updated_at, !!handoff.stalled_at);
    }
    if (handoff?.status === "human_confirmed" && !(await repo.getHandoffReceipt(handoff.id))) {
      const since = handoff.confirmed_at ?? handoff.updated_at;
      push("payment", "customer_paid_no_receipt", since, at - Date.parse(since) > RECEIPT_GRACE_MS);
    }
  }
  if (open) {
    const now = new Date(at);
    for (const kind of ["callback", "cancel"] as const) {
      for (const p of pendingCallbackAuths(events, now, kind)) {
        const asked = events.find((e) => e.type === `${kind}_auth_requested` && e.data.auth_id === p.auth_id);
        const requested = asked?.at ?? now.toISOString();
        w.pending_authorizations.push({ job_id: job.id, kind, auth_id: p.auth_id, business: name(p.business_id), requested_at: requested, expires_at: p.expires_at, wrong_codes: p.wrong, age_h: hours(at - Date.parse(requested)) });
      }
    }
  }
  const findings = planRecovery({ job, businesses, approval, payment, outbox, pendingMessages: pending.length, booking, handoff }, at);
  for (const f of findings) w.recovery.push({ job_id: f.job_id, issue: f.issue, action: f.action, detail: f.detail, ...(f.subject ? { subject: f.subject } : {}) });
}

/**
 * Held inbound with no operator decision: vendor email (on an open deal, or received within the
 * window), and texts held because their number spans workspaces. Delivery reports are bookkeeping.
 */
async function addQuarantine(repo: ReportRepo, c: { ws: (id: string) => OpsReportWorkspace; jobWs: Map<string, string>; at: number; days: number; workspaceId: string | undefined; openReviews: OperatorReviewRow[] }) {
  const held = await repo.listQuarantinedMessages({ limit: 1000 });
  if (!held.length) return;
  const decided = new Set((await repo.listQuarantineResolutions({ limit: 5000 })).map((r) => r.message_id));
  const releaseReqs = [...c.openReviews, ...(await repo.listReviews({ status: "resolved", limit: 1000 }))].filter((r) => r.subject.startsWith("opreq:release-text:"));
  const jobs = new Map<string, JobRow | null>();
  const jobOf = async (id: string) => {
    if (!jobs.has(id)) jobs.set(id, await repo.getJob(id));
    return jobs.get(id)!;
  };
  for (const m of held) {
    if (decided.has(m.id)) continue;
    const reason = heldReason(m);
    if (reason.startsWith("bounce")) continue;
    const age = c.at - Date.parse(m.created_at);
    if (m.channel !== "email") {
      // Only texts held for an ambiguous workspace wait on a person (other held texts are "no action" notices).
      if (reason !== "ambiguous_workspace" || m.job_id !== null || c.workspaceId || age > c.days * 86_400_000) continue;
      const req = releaseReqs.find((r) => r.subject === `opreq:release-text:${m.id}`);
      if (req?.status === "resolved") continue; // the server routed it (or refused it and said why): job-ops inspect shows the outcome
      c.ws(UNSCOPED).held_texts.push({ message_id: m.id, from: maskHandle(m.from_address ?? "unknown"), received_at: m.created_at, age_h: hours(age), release_requested: !!req, release_job_id: req?.job_id ?? null });
      continue;
    }
    const job = m.job_id ? await jobOf(m.job_id) : null;
    const wsId = job?.workspace_id ?? (m.job_id ? c.jobWs.get(m.job_id) : undefined) ?? UNSCOPED;
    if (c.workspaceId && wsId !== c.workspaceId) continue;
    const jobOpen = !!job && !TERMINAL.has(job.state);
    if (!jobOpen && age > c.days * 86_400_000) continue;
    const why = explainQuarantine(reason);
    const releasable = !NOT_RELEASABLE.has(reason) && (!job || RELEASABLE_STATES.has(job.state));
    c.ws(wsId).quarantined_emails.push({ message_id: m.id, job_id: m.job_id, business_id: m.business_id, from: maskHandle(m.from_address ?? "unknown"), reason: why.reason, explanation: why.explanation, action: why.action, releasable, received_at: m.created_at, age_h: hours(age) });
  }
}

const INSPECT = (jobId: string) => `scripts/job-ops.ts inspect --job ${jobId}`;
const STAGE_TEXT: Record<HandoffStage, string> = {
  awaiting_vendor_confirmation: "approved; the business hasn't confirmed the booking",
  vendor_claimed_awaiting_booked: "\"confirmed\" on an unverified channel; the approver must text BOOKED",
  not_in_writing_awaiting_attestation: "can't confirm in writing; the approver must confirm directly, text BOOKED",
  awaiting_payment_instructions: "booked; the business hasn't said how to pay",
  awaiting_customer_payment: "payment instructions received; the customer hasn't reported paying",
  customer_paid_no_receipt: "the customer reported paying; no receipt from the business",
};
const STAGE_WAITS: Record<HandoffStage, WaitingOn> = {
  awaiting_vendor_confirmation: "business", vendor_claimed_awaiting_booked: "approver", not_in_writing_awaiting_attestation: "approver",
  awaiting_payment_instructions: "business", awaiting_customer_payment: "approver", customer_paid_no_receipt: "business",
};

function reviewCommand(r: OpsReportWorkspace["reviews"][number]): Pick<AttentionItem, "command" | "alt_command"> {
  const resolve = `scripts/job-ops.ts resolve --id ${r.id} --note "<what you checked or did>" --by "<you>"`;
  if (!r.job_id) return { command: `scripts/job-ops.ts list-review`, alt_command: resolve };
  if (r.subject.startsWith("hold:")) return { command: INSPECT(r.job_id), alt_command: `scripts/job-ops.ts resume --job ${r.job_id} --note "<what you fixed>" --by "<you>"` };
  // Operator requests (callback, release-text) and close requests are performed and closed by the server.
  if (r.subject.startsWith("opreq:") || r.subject.startsWith("close:")) return { command: INSPECT(r.job_id) };
  return { command: INSPECT(r.job_id), alt_command: resolve };
}

/** Flatten the workspaces into "what needs a person", oldest first. */
function attentionOf(workspaces: OpsReportWorkspace[], at: number): OpsReport["attention"] {
  const items: AttentionItem[] = [];
  const add = (w: OpsReportWorkspace, i: Omit<AttentionItem, "workspace_id" | "age_h">) => items.push({ workspace_id: w.workspace_id, ...i, age_h: hours(at - Date.parse(i.since)) });
  for (const w of workspaces) {
    for (const a of w.pending_approvals) add(w, { category: "pending_approval", job_id: a.job_id, since: a.requested_at, waiting_on: "approver", what: `HG-${a.short_code} approval via ${a.channel}${a.expired ? " EXPIRED, still waiting" : `, expires ${a.expires_at}`}`, command: INSPECT(a.job_id) });
    for (const h of w.handoffs_awaiting) {
      if (h.stage === "customer_paid_no_receipt" && !h.stalled) continue; // within the grace period: normal
      add(w, { category: h.kind === "booking" ? "booking" : "payment_handoff", job_id: h.job_id, since: h.since, waiting_on: STAGE_WAITS[h.stage], what: `${h.business}: ${STAGE_TEXT[h.stage]}${h.stalled ? " (STALLED)" : ""}`, command: INSPECT(h.job_id) });
    }
    for (const p of w.pending_authorizations) add(w, { category: "authorization", job_id: p.job_id, since: p.requested_at, waiting_on: "approver", what: `${p.kind === "callback" ? "CALL" : "CANCEL"} code for ${p.business} unanswered by the approver (expires in ${Math.max(0, Math.round((Date.parse(p.expires_at) - at) / 60_000))} min${p.wrong_codes ? `, ${p.wrong_codes} wrong` : ""})`, command: INSPECT(p.job_id) });
    for (const q of w.quarantined_emails) {
      const reject = `scripts/quarantine.ts reject --message ${q.message_id} --by "<you>" --why "<what you checked>"`;
      const release = `scripts/quarantine.ts release --message ${q.message_id} --verified-by "<you>" --how "<how you verified it independently>"${q.job_id ? "" : " --job <job_id> --business <business_id>"}`;
      add(w, { category: "quarantined_email", job_id: q.job_id, since: q.received_at, waiting_on: "operator", what: `email from ${q.from} held: ${q.explanation}`, ...(q.releasable ? { command: release, alt_command: reject } : { command: reject }) });
    }
    for (const t of w.held_texts) {
      add(w, { category: "held_text", job_id: null, since: t.received_at, waiting_on: "operator", what: `text from ${t.from} held: its number is on deals in several workspaces${t.release_requested ? " (release requested; the server routes it on the deal's next advance)" : ""}`,
        ...(t.release_requested && t.release_job_id ? { command: INSPECT(t.release_job_id) } : { command: `scripts/quarantine.ts release-text --message ${t.message_id} --job <job_id> --by "<you>" --why "<how you know which deal>"`, alt_command: `scripts/quarantine.ts show --message ${t.message_id}` }) });
    }
    for (const r of w.reviews) add(w, { category: "review", job_id: r.job_id, since: new Date(at - r.age_h * 3_600_000).toISOString(), waiting_on: "operator", what: `${r.kind} review: ${redactText(r.reason).slice(0, 120)}`, ...reviewCommand(r) });
    for (const f of w.failed_communications) add(w, { category: "failed_communication", job_id: f.job_id, since: f.since, waiting_on: "operator", what: `${f.status}: ${redactText(f.what).slice(0, 100)}`, command: INSPECT(f.job_id) });
  }
  // A stalled job is listed only when nothing more specific already names it (it is idle *because* it waits).
  const named = new Set(items.map((i) => i.job_id).filter((j): j is string => !!j));
  for (const w of workspaces) {
    for (const s of w.stalled_jobs) {
      if (named.has(s.job_id)) continue;
      add(w, { category: "stalled_job", job_id: s.job_id, since: new Date(at - s.age_h * 3_600_000).toISOString(), waiting_on: "operator", what: `${s.state}, ${s.reason.replace(/_/g, " ")}`, command: INSPECT(s.job_id) });
    }
  }
  items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.category.localeCompare(b.category) || (a.job_id ?? "").localeCompare(b.job_id ?? ""));
  const by_category = Object.fromEntries(ATTENTION_CATEGORIES.map((c) => [c, items.filter((i) => i.category === c).length])) as Record<AttentionCategory, number>;
  return { status: items.length ? "ATTENTION" : "ALL CLEAR", total: items.length, by_category, items };
}

const statusLine = (r: OpsReport) => (r.attention.total ? `ATTENTION: ${r.attention.total} item${r.attention.total === 1 ? "" : "s"}` : "ALL CLEAR");

/** Plain text for a terminal: one section per workspace, only what needs a person. */
export function formatOpsReport(r: OpsReport): string {
  const t = r.totals;
  const lines = [
    `Haggle ops report ${r.generated_at} (closed jobs: last ${r.closed_window_days} days) · ${statusLine(r)}`,
    `${t.workspaces} workspace(s) · ${t.open_jobs} open job(s) · ${t.pending_approvals} pending approval(s) · ${t.open_reviews} open review(s) · ${t.failed_communications} failed/bounced communication(s) · ${t.quarantined_emails} quarantined email(s) awaiting a decision · ${t.stalled_jobs} stalled job(s) · ${t.handoffs_awaiting} booking/handoff(s) awaiting action · ${t.pending_authorizations} pending CALL/CANCEL authorization(s) · ${t.held_texts} held text(s)`,
  ];
  for (const w of r.workspaces) {
    lines.push("", `== ${w.workspace_id} (${w.open_jobs} open)`);
    const section = <T>(title: string, xs: T[], f: (x: T) => string) => { if (xs.length) lines.push(`  ${title}:`, ...xs.map((x) => `    ${f(x)}`)); };
    section("Pending approvals", w.pending_approvals, (a) => `${a.job_id} HG-${a.short_code} ${a.approval_id} via ${a.channel}${a.expired ? " (EXPIRED, still waiting)" : ` expires ${a.expires_at}`} · ${a.age_h}h`);
    section("Operator reviews", w.reviews, (v) => `${v.id} ${v.kind} [${v.subject}] ${v.age_h}h · ${redactText(v.reason)}${v.attempts ? ` · attempts ${v.attempts}` : ""}`);
    section("Failed / bounced communications", w.failed_communications, (c) => `${c.job_id} ${redactText(c.what)} · ${c.status}${c.attempts !== null ? ` · attempts ${c.attempts}` : ""}`);
    section("Quarantined emails", w.quarantined_emails, (q) => `${q.message_id} ${q.job_id ?? "(no deal)"} from ${q.from} · ${q.age_h}h · ${q.reason}: ${q.explanation} → ${q.action}${q.releasable ? "" : " (not releasable)"}`);
    if (w.quarantined_replies && !w.quarantined_emails.length) lines.push(`  Quarantined replies: ${w.quarantined_replies} (all decided or delivery reports; quarantine.ts list --all)`);
    section("Stalled jobs", w.stalled_jobs, (s) => `${s.job_id} ${s.state} ${s.reason} · ${s.age_h}h`);
    section("Recovery findings", w.recovery, (f) => `${f.job_id} ${f.issue} → ${f.action}${f.subject ? ` [${f.subject}]` : ""} · ${f.detail}`);
    section("Handoffs awaiting action", w.handoffs_awaiting, (h) => `${h.job_id} ${h.business} · ${h.stage} since ${h.since} (${h.age_h}h)${h.stalled ? " (STALLED)" : ""}`);
    section("Pending CALL / CANCEL authorizations", w.pending_authorizations, (p) => `${p.job_id} ${p.kind} for ${p.business} · asked ${p.age_h}h ago, expires ${p.expires_at}${p.wrong_codes ? ` · ${p.wrong_codes} wrong code(s)` : ""}`);
    section("Held texts (ambiguous workspace)", w.held_texts, (h) => `${h.message_id} from ${h.from} · ${h.age_h}h${h.release_requested ? ` · release requested to ${h.release_job_id}` : ""}`);
  }
  if (!r.workspaces.length) lines.push("", "Nothing open or recently closed.");
  if (r.attention.total) lines.push("", "Next commands (oldest first):", ...briefLines(r));
  return lines.join("\n");
}

const SHORT: Record<AttentionCategory, string> = { stalled_job: "stalled", quarantined_email: "quarantine", pending_approval: "approval", booking: "booking", payment_handoff: "payment", authorization: "auth", held_text: "held text", review: "review", failed_communication: "failed" };

function briefLines(r: OpsReport, max = Infinity): string[] {
  const shown = r.attention.items.slice(0, max);
  const clip = (x: string, n: number) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);
  const out = shown.map((i) => `${`${i.age_h}h`.padStart(6)} ${SHORT[i.category].padEnd(10)} ${i.workspace_id} ${i.job_id ?? "-"} [${i.waiting_on}] ${clip(i.what, 90)} → ${i.command}${i.alt_command ? ` | or: ${i.alt_command}` : ""}`);
  if (r.attention.items.length > shown.length) out.push(`  … ${r.attention.items.length - shown.length} more (--json, or drop --brief for the full report)`);
  return out;
}

/** One screen: the status and counts per category, then one line per item with its next command, oldest first. */
export function formatOpsBrief(r: OpsReport, opts: { maxItems?: number } = {}): string {
  const c = r.attention.by_category;
  const lines = [`Haggle ops ${r.generated_at} · ${statusLine(r)}`];
  if (!r.attention.total) return lines.join("\n");
  lines.push(
    `stalled ${c.stalled_job} · quarantine ${c.quarantined_email} · approvals ${c.pending_approval} · bookings ${c.booking} · payments ${c.payment_handoff} · authorizations ${c.authorization} · held texts ${c.held_text} · reviews ${c.review} · failed comms ${c.failed_communication}`,
    "(commands run from apps/mcp: node --env-file=.env <command>; fill in the <placeholders>)",
    ...briefLines(r, opts.maxItems ?? 25),
  );
  return lines.join("\n");
}
