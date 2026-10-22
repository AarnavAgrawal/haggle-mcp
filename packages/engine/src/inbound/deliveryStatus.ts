// Delivery status of Haggle's own outbound email: Inkbox `message.bounced` / `message.failed`
// webhooks and the reconciler's sweep of outbound statuses. Inkbox sends through Amazon SES, which
// is the envelope sender, so DSN bounce mail never reaches the buyer mailbox (parseBounce stays for
// providers that do deliver one); a bounce arrives only as this status.
//
// Only a message Haggle itself sent counts: the provider id (or RFC Message-ID) must name one of our
// own outbound email rows, so a forged event or someone else's message can't suppress a vendor.
// Inkbox doesn't say whether a bounce was permanent or transient. A bounce to an address the
// business has never replied from suppresses it and marks the business bounced (a call fallback
// then applies, if configured); after a real reply from that address it is recorded only, since the
// address demonstrably works. `failed` (Haggle/Inkbox couldn't send it) is recorded, never
// suppressed. Idempotent: the effects are idempotent and the job event is appended once per message.
import { normalizeAddress } from "./matching.ts";
import type { MessageRow, Repository } from "../store/types.ts";

export type DeliveryStatus = "bounced" | "failed";

export interface DeliveryStatusInput {
  /** Inkbox message id of the outbound message (our messages.provider_email_id). */
  providerMessageId: string;
  /** Its RFC Message-ID, when known (fallback lookup). */
  rfcMessageId?: string | null;
  status: DeliveryStatus;
  /** "webhook" (message.bounced / message.failed) or "reconcile" (outbound status sweep). */
  source: "webhook" | "reconcile";
}

export type DeliveryStatusOutcome = "bounced" | "bounce_recorded" | "delivery_failed" | "duplicate" | "unmatched";

type Repo = Pick<Repository, "findMessageByProviderId" | "findOutboundByRfcIds" | "getBusinesses" | "addSuppression" | "updateBusiness" | "appendEvent" | "recordInboundEvent" | "touchJob">;

const EVIDENCE = "inkbox message.bounced; bounce type not exposed";

export async function applyDeliveryStatus(repo: Repo, s: DeliveryStatusInput, log: (event: string, data: Record<string, unknown>) => void = () => {}): Promise<{ jobId: string | null; outcome: DeliveryStatusOutcome }> {
  let row: MessageRow | null = await repo.findMessageByProviderId(s.providerMessageId);
  if ((!row || row.direction !== "out") && s.rfcMessageId) row = (await repo.findOutboundByRfcIds([s.rfcMessageId])).find((m) => m.channel === "email") ?? null;
  if (!row || row.direction !== "out" || row.channel !== "email" || !row.job_id || !row.to_address) {
    log("delivery_status_unmatched", { provider_id: s.providerMessageId, status: s.status, source: s.source });
    return { jobId: null, outcome: "unmatched" };
  }
  const jobId = row.job_id;
  const to = normalizeAddress(row.to_address);
  const key = `delivery:${s.status}:${row.provider_email_id ?? row.id}`;
  const b = row.business_id ? (await repo.getBusinesses(jobId)).find((x) => x.business_id === row.business_id) ?? null : null;
  const who = b?.name ?? "the approver";
  if (s.status === "failed") {
    if (!(await repo.recordInboundEvent(key))) return { jobId, outcome: "duplicate" };
    await repo.appendEvent(jobId, "reply", { ...(b ? { business_id: b.business_id } : {}), summary: `An email to ${who} (${row.kind}) failed to send (Inkbox status "failed"); it was not delivered`, delivery_status: "failed", message_id: row.id });
    await repo.touchJob(jobId);
    log("delivery_failed", { job_id: jobId, message_id: row.id, source: s.source });
    return { jobId, outcome: "delivery_failed" };
  }
  // A bounce. The approver's address (receipts) and an address that has already replied are not suppressed.
  const repliedBefore = !!b?.last_reply_at && normalizeAddress(b.email ?? "") === to;
  const suppress = !!b && !repliedBefore;
  if (suppress) {
    await repo.addSuppression({ contact: to, reason: "bounce", job_id: jobId, evidence: `${EVIDENCE} (outbound ${row.provider_email_id ?? row.id}, ${row.kind})` });
    await repo.updateBusiness(jobId, b!.business_id, { status: "bounced", next_attempt_at: null }, { ifStatus: ["pending", "contacted", "no_reply", "silent", "ringing", "bounced"] });
  }
  if (!(await repo.recordInboundEvent(key))) return { jobId, outcome: "duplicate" };
  await repo.appendEvent(jobId, "reply", {
    ...(b ? { business_id: b.business_id } : {}), delivery_status: "bounced", message_id: row.id,
    summary: suppress ? `Email to ${who} bounced; it won't be emailed again` : b ? `An email to ${who} bounced, but they have replied from this address before; not suppressed` : `An email to ${who} bounced`,
  });
  await repo.touchJob(jobId);
  log("delivery_bounced", { job_id: jobId, message_id: row.id, suppressed: suppress, source: s.source });
  return { jobId, outcome: suppress ? "bounced" : "bounce_recorded" };
}
