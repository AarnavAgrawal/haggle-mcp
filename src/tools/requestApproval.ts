// request_approval (DESIGN.md §8.3, §13.1): email the human a summary of the
// chosen quote with a one-time code. Payment stays blocked until they reply
// "APPROVE <code>" from their own, authenticated address.
import { randomInt } from "node:crypto";
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getConfig } from "../config.js";
import {
  getCurrentQuotes,
  getJob,
  getPendingApproval,
  getQuote,
  getVendors,
  insertApproval,
  insertMessage,
  transitionApproval,
  updateApproval,
} from "../db/queries.js";
import { emailChannel } from "../channels/email.js";
import { buildApprovalEmail } from "../approvals/requestApproval.js";
import { advanceJob, fireEvent } from "../jobs/advanceJob.js";
import { currentCaller, loadOwnedJob } from "./access.js";
import { toolError } from "./errors.js";
import { maskEmail, money, ok, runTool } from "./format.js";

const inputSchema = z.object({ job_id: z.string().uuid(), quote_id: z.string().uuid() });

const outputSchema = z.object({
  approval_id: z.string(),
  status: z.string(),
  vendor: z.string(),
  deposit: z.string().nullable(),
  sent_to: z.string(),
  expires_at: z.string(),
  next: z.string(),
});

const NEXT = "Call wait_for_job with until='approval_decided'.";

export function registerRequestApproval(server: MCPServer) {
  return server.tool(
    {
      name: "request_approval",
      description: "Email the human a summary of the chosen quote and ask them to approve the deposit. Payment is blocked until they approve.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id, quote_id }, ctx) =>
      runTool("request_approval", async () => {
        const cfg = getConfig();
        const caller = currentCaller(ctx);
        await loadOwnedJob(job_id, caller);

        // Who approves: the signed-in user (oauth), or the operator's BUYER_EMAIL (token).
        // Never anything from tool input, so the agent can't route approval to itself.
        const approverEmail = cfg.AUTH_MODE === "oauth" ? caller.email : cfg.BUYER_EMAIL?.toLowerCase();
        if (!approverEmail) {
          throw cfg.AUTH_MODE === "oauth"
            ? toolError("CONFIG_MISSING", "Your sign-in has no email address, so there is nowhere to send the approval.", "Sign in again with an account that has an email address.")
            : toolError("CONFIG_MISSING", "No approver email is configured.", "Ask the server operator to set BUYER_EMAIL.", { details: { missing: ["BUYER_EMAIL"] } });
        }

        await advanceJob(job_id);
        const job = (await getJob(job_id))!;

        const vendors = await getVendors(job_id);
        const names = new Map(vendors.map((v) => [v.id, v.name]));

        // Idempotent retry: the same quote already has a pending approval.
        if (job.status === "awaiting_approval") {
          const pending = await getPendingApproval(job_id);
          if (pending && pending.quote_id === quote_id) {
            return ok({
              approval_id: pending.id,
              status: "pending",
              vendor: names.get(pending.vendor_id) ?? "unknown",
              deposit: money(pending.amount_cents),
              sent_to: maskEmail(pending.approver_email),
              expires_at: pending.expires_at,
              next: NEXT,
            });
          }
          throw toolError("APPROVAL_ALREADY_PENDING", "Another approval is already waiting for the human.", "Call wait_for_job with until='approval_decided' first.", { retryable: true });
        }
        if (job.status !== "ready") {
          throw toolError("JOB_NOT_READY", `The job is ${job.status}, not ready.`, "Call wait_for_job with until='ready', then list_quotes.", { retryable: true });
        }

        const quote = await getQuote(quote_id);
        if (!quote || quote.job_id !== job_id) throw toolError("QUOTE_NOT_FOUND", "No quote with that id on this job.", "Call list_quotes and use one of its quote_id values.");
        if (!quote.is_current || !quote.available) {
          throw toolError("QUOTE_NOT_CURRENT", "That quote was replaced by a newer one or the vendor is unavailable.", "Call list_quotes for the current quote_id values.");
        }
        if (quote.deposit_cents === null || quote.deposit_cents <= 0) {
          throw toolError("QUOTE_NOT_CURRENT", "The vendor did not state a deposit, so there is nothing exact to approve.", "Pick another quote from list_quotes, or wait for the vendor to clarify.");
        }
        if (quote.deposit_cents > cfg.SPEND_CAP_CENTS) {
          throw toolError("OVER_SPEND_CAP", `The ${money(quote.deposit_cents)} deposit is over the ${money(cfg.SPEND_CAP_CENTS)} spending cap.`, "Pick a quote with a smaller deposit.");
        }

        // 1. Record the approval (one pending per job, enforced by the database).
        const expiresAt = new Date(Date.now() + cfg.approvalTtlSeconds * 1000);
        const approval = await insertApproval({
          job_id,
          quote_id,
          vendor_id: quote.vendor_id,
          amount_cents: quote.deposit_cents,
          code: String(randomInt(1000, 10000)),
          approver_email: approverEmail,
          expires_at: expiresAt.toISOString(),
        });
        if (!approval) throw toolError("APPROVAL_ALREADY_PENDING", "Another approval is already waiting for the human.", NEXT, { retryable: true });

        // 2. Email the human. If this fails, the approval is retired and the job stays ready.
        const others = (await getCurrentQuotes(job_id))
          .filter((q) => q.id !== quote.id && q.available)
          .map((q) => ({ vendorName: names.get(q.vendor_id) ?? "unknown", perHeadCents: q.price_per_head_cents, totalCents: q.total_cents }));
        const { subject, bodyText } = buildApprovalEmail({
          shortCode: job.short_code,
          vendorName: names.get(quote.vendor_id) ?? "the vendor",
          event: job.event,
          perHeadCents: quote.price_per_head_cents,
          totalCents: quote.total_cents,
          depositCents: quote.deposit_cents,
          others,
          code: approval.code,
          expiresAt,
        });
        try {
          const sent = await emailChannel.send({
            jobId: job_id,
            approvalId: approval.id,
            to: approval.approver_email,
            subject,
            bodyText,
            idempotencyKey: `approval:${approval.id}`,
          });
          await updateApproval(approval.id, { outbound_email_id: sent.providerId, outbound_message_id: sent.messageId ?? null });
          await insertMessage({
            job_id,
            vendor_id: null,
            approval_id: approval.id,
            direction: "out",
            kind: "approval_request",
            provider_email_id: sent.providerId,
            rfc_message_id: sent.messageId ?? null,
            thread_id: null,
            from_address: cfg.PRIMITIVE_FROM_ADDRESS,
            subject,
            // The body holds the one-time code; it is stored but never returned to the agent.
            body_text: bodyText,
            attachments: [],
            sender_authenticated: null,
            parse_status: "none",
          });
        } catch (err) {
          await transitionApproval(approval.id, "pending", { status: "expired" });
          console.error("[request_approval] approval email failed:", err instanceof Error ? err.message : err);
          // Most likely cause on a restricted Primitive account: the approver's
          // address has never emailed the broker, so Primitive won't send to it yet.
          throw toolError(
            "APPROVER_UNREACHABLE",
            "Could not email the approval request to the human.",
            `Ask the human to send any short email from the address they signed in with to ${cfg.PRIMITIVE_FROM_ADDRESS} (a one-time step so approvals can reach them), wait a minute, then call request_approval again.`,
            { retryable: true },
          );
        }

        // 3. Move the job to awaiting_approval.
        const r = await fireEvent(job_id, { type: "approval_requested" }, { approval_id: approval.id, quote_id });
        if (r.status !== "applied") {
          await transitionApproval(approval.id, "pending", { status: "expired" });
          throw toolError("JOB_NOT_READY", "The job changed while requesting approval.", "Call get_job, then retry request_approval.", { retryable: true });
        }

        return ok({
          approval_id: approval.id,
          status: "pending",
          vendor: names.get(quote.vendor_id) ?? "unknown",
          deposit: money(approval.amount_cents),
          sent_to: maskEmail(approval.approver_email),
          expires_at: approval.expires_at,
          next: NEXT,
        });
      }),
  );
}
