// advanceJob(jobId): apply everything that is due for a job (DESIGN.md §7.3).
//
// Called by every tool that touches a job, by the webhook after storing a
// message, by each wait_for_job poll, and by the backup tick. Safe to call
// concurrently and repeatedly:
//   - parsing is idempotent (unique index on quotes.source_message_id);
//   - transitions use compare-and-swap on jobs.version, so only one caller
//     wins a given transition, and only the winner runs its effects;
//   - every outbound email carries an idempotency key.
import { getConfig } from "../config.js";
import {
  casJob,
  getCounteredVendorIds,
  getCurrentQuotes,
  getJob,
  getLatestApproval,
  getPendingApproval,
  getPendingMessages,
  getVendors,
  hasRoundEvent,
  insertCurrentQuote,
  insertJobEvent,
  markSilentVendors,
  setParseStatus,
  transitionApproval,
  updateJobVersioned,
  updateVendor,
  type JobRow,
  type MessageRow,
} from "../db/queries.js";
import { downloadAttachmentsArchive } from "../channels/email.js";
import { parseReply } from "../parser/parseReply.js";
import { extractPdfs, type PdfFile } from "../parser/attachments.js";
import { validateQuote } from "../parser/validate.js";
import { TERMINAL, transition, type JobEvent, type JobState } from "./stateMachine.js";
import { runEffects } from "./effects.js";

export type ApplyResult =
  | { status: "applied"; job: JobRow }
  | { status: "conflict" }
  | { status: "rejected"; reason: string };

const stateOf = (job: JobRow): JobState => ({
  status: job.status,
  round: job.round,
  max_rounds: job.max_rounds,
  collect_until: job.collect_until,
});

/**
 * Run one event through the pure state machine against this exact job
 * version. Commits with compare-and-swap, then runs effects. Effects run
 * after the commit, so a lost race never sends email.
 */
async function applyEvent(job: JobRow, event: JobEvent, data: Record<string, unknown>): Promise<ApplyResult> {
  const cfg = getConfig();
  const quotes = await getCurrentQuotes(job.id);
  const result = transition(stateOf(job), event, {
    now: new Date(),
    availableQuotes: quotes.filter((q) => q.available).length,
    negotiationWindowSeconds: cfg.negotiationWindowSeconds,
  });
  if (!result.ok) return { status: "rejected", reason: result.reason };

  const updated = await casJob(job.id, job.version, result.next);
  if (!updated) return { status: "conflict" };

  await insertJobEvent(job.id, event.type, { from: job.status, to: updated.status, round: updated.round, ...data });
  if (job.status === "collecting" && updated.status !== "collecting") await markSilentVendors(job.id);
  await runEffects(updated, result.effects);
  return { status: "applied", job: updated };
}

/** Fire an event from a tool or webhook, retrying on version conflicts. */
export async function fireEvent(jobId: string, event: JobEvent, data: Record<string, unknown> = {}): Promise<ApplyResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await getJob(jobId);
    if (!job) return { status: "rejected", reason: "job not found" };
    const r = await applyEvent(job, event, data);
    if (r.status !== "conflict") return r;
  }
  return { status: "conflict" };
}

/** Which time- or reply-driven event is due right now, if any. */
async function dueEvent(job: JobRow): Promise<JobEvent | null> {
  const now = Date.now();
  const deadlinePassed = job.collect_until !== null && now > Date.parse(job.collect_until);

  if (job.status === "collecting") {
    const vendors = await getVendors(job.id);
    const waiting = vendors.filter((v) => v.status === "contacted" || v.status === "pending");
    if (vendors.length > 0 && waiting.length === 0) return { type: "all_vendors_replied" };
    return deadlinePassed ? { type: "deadline_passed" } : null;
  }

  if (job.status === "negotiating") {
    // Only judge "everyone answered" once this round's counteroffers are out;
    // otherwise an empty countered list would close the round instantly.
    if (await hasRoundEvent(job.id, "counteroffers_sent", job.round)) {
      const [countered, quotes, vendors] = await Promise.all([
        getCounteredVendorIds(job.id, job.round),
        getCurrentQuotes(job.id),
        getVendors(job.id),
      ]);
      const answered = new Set(quotes.filter((q) => q.round >= job.round).map((q) => q.vendor_id));
      const gone = new Set(vendors.filter((v) => v.status === "bounced").map((v) => v.id));
      if (countered.every((id) => answered.has(id) || gone.has(id))) return { type: "all_vendors_replied" };
    }
    return deadlinePassed ? { type: "deadline_passed" } : null;
  }

  if (job.status === "awaiting_approval") {
    // Self-heal: the webhook records the human's decision on the approval row
    // first, then fires the job event. If that second step lost a race, the
    // decision is still here to apply.
    const latest = await getLatestApproval(job.id);
    if (latest?.status === "approved") return { type: "approval_verified" };
    if (latest?.status === "declined") return { type: "approval_declined" };

    const approval = await getPendingApproval(job.id);
    if (!approval) return { type: "approval_expired" }; // recover from a half-written request
    if (now > Date.parse(approval.expires_at)) {
      await transitionApproval(approval.id, "pending", { status: "expired", decided_at: new Date().toISOString() });
      return { type: "approval_expired" };
    }
  }
  return null;
}

async function loadPdfs(msg: MessageRow): Promise<PdfFile[]> {
  const wanted = msg.attachments
    .filter((a) => a.tar_path)
    .map((a) => ({ tarPath: a.tar_path!, contentType: a.content_type, filename: a.filename }));
  if (!msg.attachments_download_url || wanted.length === 0) return [];
  try {
    return await extractPdfs(await downloadAttachmentsArchive(msg.attachments_download_url), wanted);
  } catch (err) {
    // Parse the text anyway; the agent will see any fields the PDF would have filled as missing.
    console.error(`[advanceJob] attachments unavailable for ${msg.id}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/** Turn pending vendor replies into quotes. */
async function parsePending(job: JobRow): Promise<void> {
  for (const msg of await getPendingMessages(job.id)) {
    if (!msg.vendor_id) {
      await setParseStatus(msg.id, "failed");
      continue;
    }
    try {
      const extraction = await parseReply({ event: job.event, bodyText: msg.body_text ?? "", pdfs: await loadPdfs(msg) });
      const record = validateQuote(extraction, job.event.headcount);
      const quote = await insertCurrentQuote({
        ...record,
        job_id: job.id,
        vendor_id: msg.vendor_id,
        source_message_id: msg.id,
        round: job.round,
      });
      await setParseStatus(msg.id, "done");
      if (quote) {
        await updateVendor(msg.vendor_id, { status: record.available ? "replied" : "declined" });
        await insertJobEvent(job.id, "quote_parsed", {
          vendor_id: msg.vendor_id,
          quote_id: quote.id,
          round: job.round,
          available: record.available,
          missing: record.missing_fields,
        });
        await updateJobVersioned(job.id);
      }
    } catch (err) {
      // Log the reason only; the email body never goes to logs.
      console.error(`[advanceJob] parse failed for message ${msg.id}:`, err instanceof Error ? err.message : err);
      await setParseStatus(msg.id, "failed");
      await insertJobEvent(job.id, "parse_failed", { message_id: msg.id, vendor_id: msg.vendor_id });
      await updateJobVersioned(job.id);
    }
  }
}

export async function advanceJob(jobId: string): Promise<void> {
  const first = await getJob(jobId);
  if (!first || TERMINAL.has(first.status)) return;

  await parsePending(first);

  // Apply due events until nothing more is due. Several can chain, e.g. a
  // collection window closing straight into a negotiation round.
  for (let step = 0; step < 6; step++) {
    const job = await getJob(jobId);
    if (!job || TERMINAL.has(job.status)) return;
    const event = await dueEvent(job);
    if (!event) return;
    const r = await applyEvent(job, event, {});
    if (r.status === "rejected") return;
  }
}
