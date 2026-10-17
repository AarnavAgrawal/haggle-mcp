// POST /webhooks/primitive (DESIGN.md §10.4).
//
// Order matters:
//   1. Verify the HMAC signature on the RAW body before trusting anything.
//   2. Skip events we've already processed (dedupe on the event id).
//   3. Route: vendor reply -> store for parsing; approval reply -> verify;
//      bounce -> mark the vendor.
//   4. Record the event id, return 200 fast, and advance the job in the
//      background.
// Message inserts are idempotent on provider_email_id, so a crash between
// steps 3 and 4 just means Primitive's retry is a harmless no-op.
import type { Context } from "hono";
import {
  handleWebhook,
  isTrustedSender,
  validateEmailAuth,
  type EmailReceivedEvent,
} from "@primitivedotdev/sdk/webhook";
import { getConfig } from "../config.js";
import {
  findApprovalCandidates,
  findVendorByOutboundEmailId,
  findVendorCandidates,
  getApproval,
  insertJobEvent,
  insertMessage,
  recordWebhookEvent,
  transitionApproval,
  updateApproval,
  updateJobVersioned,
  updateVendor,
  webhookEventSeen,
} from "../db/queries.js";
import { matchInbound, normalizeAddress, subjectShortCode } from "../channels/matching.js";
import type { InboundMessage } from "../channels/types.js";
import { verifyApproval } from "../approvals/verifyApproval.js";
import { advanceJob, fireEvent } from "../jobs/advanceJob.js";

/** Thrown when processing should be retried later (respond 5xx). */
class RetryLater extends Error {}

/** `"Taqueria Sol" <sol@x.com>` -> `sol@x.com`. For matching only, never for auth. */
export function bareAddress(header: string): string {
  const angle = header.match(/<([^>]+)>/);
  return normalizeAddress(angle ? angle[1]! : header);
}

/** Map the verified Primitive event onto our channel-neutral shape. */
export function toInbound(event: EmailReceivedEvent): InboundMessage {
  const e = event.email;
  const parsed = e.parsed.status === "complete" ? e.parsed : null;
  return {
    providerEventId: event.id,
    eventType: event.event,
    providerId: e.id,
    threadId: e.thread_id ?? null,
    messageId: e.headers.message_id,
    inReplyTo: parsed?.in_reply_to ?? [],
    references: parsed?.references ?? [],
    from: bareAddress(e.headers.from),
    subject: e.headers.subject,
    bodyText: parsed?.body_text ?? null,
    attachments: (parsed?.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      partIndex: a.part_index,
      tarPath: a.tar_path,
    })),
    attachmentsDownloadUrl: parsed?.attachments_download_url ?? null,
    senderAuthenticated: validateEmailAuth(e.auth).verdict === "legit",
  };
}

const attachmentMeta = (msg: InboundMessage) =>
  msg.attachments.map((a) => ({ filename: a.filename, content_type: a.contentType, size_bytes: a.sizeBytes, tar_path: a.tarPath }));

/** A human's reply to an approval email. Returns the job id to advance. */
async function handleApprovalReply(event: EmailReceivedEvent, msg: InboundMessage, approvalId: string): Promise<string | null> {
  const approval = await getApproval(approvalId);
  if (!approval) return null;

  // Authenticity is anchored to the approver's exact domain and address.
  const domain = approval.approver_email.split("@")[1] ?? "";
  const trust = isTrustedSender(event, { domain, sender: approval.approver_email });
  if (!trust.trusted && trust.retryable) throw new RetryLater("DMARC lookup failed; retry later");

  const stored = await insertMessage({
    job_id: approval.job_id,
    vendor_id: null,
    approval_id: approval.id,
    direction: "in",
    kind: "approval_reply",
    provider_email_id: msg.providerId,
    rfc_message_id: msg.messageId,
    thread_id: msg.threadId,
    from_address: msg.from,
    subject: msg.subject,
    body_text: msg.bodyText,
    attachments: attachmentMeta(msg),
    sender_authenticated: trust.trusted,
    parse_status: "none",
  });
  if (!stored) return null; // already handled this email
  if (!approval.thread_id && msg.threadId) await updateApproval(approval.id, { thread_id: msg.threadId });

  const verdict = verifyApproval(
    approval,
    { from: msg.from, senderTrusted: trust.trusted, threadMatched: true, bodyText: msg.bodyText },
    new Date(),
  );
  const decided = { decided_at: new Date().toISOString(), decision_message_id: stored.id };

  if (verdict.decision === "approve") {
    if (await transitionApproval(approval.id, "pending", { status: "approved", ...decided })) {
      await fireEvent(approval.job_id, { type: "approval_verified" }, { approval_id: approval.id });
    }
  } else if (verdict.decision === "decline") {
    if (await transitionApproval(approval.id, "pending", { status: "declined", ...decided })) {
      await fireEvent(approval.job_id, { type: "approval_declined" }, { approval_id: approval.id });
    }
  } else {
    // Wrong code, wrong sender, unauthenticated, quoted text only: stored, never acted on.
    await insertJobEvent(approval.job_id, "approval_reply_ignored", { approval_id: approval.id, reason: verdict.reason });
    await updateJobVersioned(approval.job_id);
  }
  return approval.job_id;
}

async function handleReceived(event: EmailReceivedEvent): Promise<string | null> {
  const msg = toInbound(event);
  const lookup = {
    threadId: msg.threadId,
    messageIds: [...msg.inReplyTo, ...msg.references],
    shortCode: subjectShortCode(msg.subject),
  };
  const [vendors, approvals] = await Promise.all([findVendorCandidates(lookup), findApprovalCandidates(lookup)]);
  const match = matchInbound(msg, vendors, approvals);

  if (match.kind === "approval") return handleApprovalReply(event, msg, match.approvalId);

  const base = {
    direction: "in" as const,
    kind: "reply" as const,
    provider_email_id: msg.providerId,
    rfc_message_id: msg.messageId,
    thread_id: msg.threadId,
    from_address: msg.from,
    subject: msg.subject,
    body_text: msg.bodyText,
    attachments: attachmentMeta(msg),
    attachments_download_url: msg.attachmentsDownloadUrl,
    sender_authenticated: msg.senderAuthenticated,
  };

  if (match.kind === "unmatched") {
    // Stored for audit, never acted on. An inbound email never creates a job.
    await insertMessage({ ...base, job_id: null, vendor_id: null, parse_status: "none" });
    return null;
  }

  const stored = await insertMessage({
    ...base,
    job_id: match.jobId,
    vendor_id: match.vendorId,
    parse_status: msg.bodyText || msg.attachments.length > 0 ? "pending" : "failed",
  });
  if (stored) {
    // Remember the thread so later replies match on rule 1.
    await updateVendor(match.vendorId, {
      last_message_at: new Date().toISOString(),
      ...(msg.threadId ? { thread_id: msg.threadId } : {}),
    });
  }
  return match.jobId;
}

/** A delivery failure report for one of our sends (DESIGN.md §10.6). */
async function handleBounce(event: EmailReceivedEvent): Promise<string | null> {
  const sentId = event.email.analysis.bounce?.sent_email_id;
  if (!sentId) return null;
  const vendor = await findVendorByOutboundEmailId(sentId);
  if (!vendor) return null;
  await updateVendor(vendor.id, { status: "bounced" });
  await insertJobEvent(vendor.job_id, "vendor_bounced", { vendor_id: vendor.id, type: event.email.analysis.bounce?.type });
  await updateJobVersioned(vendor.job_id);
  return vendor.job_id;
}

export async function handlePrimitiveWebhook(c: Context): Promise<Response> {
  let cfg;
  try {
    cfg = getConfig();
  } catch {
    return c.json({ error: "not configured" }, 503);
  }

  // 1. Verify on the raw bytes. Any failure is a 401 with no detail.
  const rawBody = await c.req.text();
  let event: EmailReceivedEvent;
  try {
    event = handleWebhook({ body: rawBody, headers: c.req.raw.headers, secret: cfg.PRIMITIVE_WEBHOOK_SECRET });
  } catch {
    return c.json({ error: "invalid signature" }, 401);
  }
  if (cfg.PRIMITIVE_ENDPOINT_ID && event.delivery.endpoint_id !== cfg.PRIMITIVE_ENDPOINT_ID) {
    return c.json({ error: "wrong endpoint" }, 401);
  }

  try {
    // 2. Dedupe.
    if (await webhookEventSeen(event.id)) return c.json({ ok: true, duplicate: true });

    // 3. Route.
    let jobId: string | null = null;
    if (event.event === "email.received") jobId = await handleReceived(event);
    else if (event.event === "email.bounced") jobId = await handleBounce(event);

    // 4. Record, then respond. Parsing runs in the background; if this process
    // dies, the next tool call or tick parses the pending message anyway.
    await recordWebhookEvent(event.id);
    if (jobId) {
      void advanceJob(jobId).catch((err) =>
        console.error(`[webhook] advanceJob failed:`, err instanceof Error ? err.message : err),
      );
    }
    return c.json({ ok: true });
  } catch (err) {
    console.error(`[webhook] processing failed:`, err instanceof Error ? err.message : err);
    // 5xx makes Primitive retry; the retry is safe because inserts are idempotent.
    return c.json({ error: err instanceof RetryLater ? "retry later" : "processing failed" }, 503);
  }
}
