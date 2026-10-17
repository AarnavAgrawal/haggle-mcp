// PURE: one-line job summaries and the `next` hint every tool returns
// (DESIGN.md §8.1). Shared by wait_for_job and get_job.
import type { ApprovalRow, JobRow, QuoteRow, VendorRow } from "../db/queries.js";
import { pickBest } from "../tools/best.js";

const usd = (cents: number | null) => (cents === null ? "?" : `$${(cents / 100).toFixed(2)}`);
const hhmm = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

export function nextStep(job: Pick<JobRow, "id" | "status">, approval: Pick<ApprovalRow, "id" | "status"> | null): string {
  switch (job.status) {
    case "collecting":
    case "negotiating":
      return "Keep calling wait_for_job with until='ready'.";
    case "ready":
      return "Call list_quotes, then request_approval with the chosen quote_id.";
    case "awaiting_approval":
      return "Call wait_for_job with until='approval_decided'.";
    case "approved":
      return approval ? `Call pay with job_id and approval_id='${approval.id}'.` : "Call get_job to find the approval_id, then pay.";
    case "payment_failed":
      return "Call pay again to retry, or cancel_job.";
    case "paid":
      return "Done. The job is paid.";
    case "expired":
      return "No usable quotes arrived. Start a new create_quote_request with other vendors.";
    case "cancelled":
      return "The job was cancelled. Nothing else to do.";
  }
}

export function summarizeJob(
  job: JobRow,
  vendors: VendorRow[],
  quotes: QuoteRow[],
  approval: ApprovalRow | null,
): string {
  const names = new Map(vendors.map((v) => [v.id, v.name]));
  const replied = vendors.filter((v) => ["replied", "declined"].includes(v.status)).length;
  const best = pickBest(job, quotes);
  const bestText = best ? `Best so far: ${names.get(best.vendor_id)} at ${usd(best.price_per_head_cents)}/head.` : "No complete quote yet.";
  const approvalVendor = approval ? names.get(approval.vendor_id) : undefined;

  switch (job.status) {
    case "collecting":
      return `${replied} of ${vendors.length} vendors replied. ${bestText}${job.collect_until ? ` Collecting until ${hhmm(job.collect_until)}.` : ""}`;
    case "negotiating":
      return `Negotiation round ${job.round} of ${job.max_rounds}. ${bestText}`;
    case "ready":
      return `${quotes.filter((q) => q.available).length} quote(s) ready. ${bestText}`;
    case "awaiting_approval":
      return approval
        ? `Waiting for the human to approve ${usd(approval.amount_cents)} to ${approvalVendor} (expires ${hhmm(approval.expires_at)}).`
        : "Waiting for approval.";
    case "approved":
      return `Approved: ${usd(approval?.amount_cents ?? null)} deposit to ${approvalVendor}.`;
    case "payment_failed":
      return `The ${usd(approval?.amount_cents ?? null)} deposit to ${approvalVendor} failed to charge.`;
    case "paid":
      return `Paid ${usd(approval?.amount_cents ?? null)} deposit to ${approvalVendor}.`;
    case "expired":
      return `No usable quotes from ${vendors.length} vendor(s).`;
    case "cancelled":
      return "Cancelled.";
  }
}
