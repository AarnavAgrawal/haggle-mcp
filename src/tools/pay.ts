// pay (DESIGN.md §8.3, §14): charge the approved deposit. The tool input has
// no amount: the charge is always approval.amount_cents from the database,
// and only after the pure guard says every rule passes.
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getConfig } from "../config.js";
import {
  getApproval,
  getJob,
  getLatestInboundFromVendor,
  getPaymentByApproval,
  getQuote,
  getVendors,
  insertJobEvent,
  insertMessage,
  insertPayment,
  transitionApproval,
  type ApprovalRow,
  type JobRow,
  type PaymentRow,
} from "../db/queries.js";
import { db } from "../db/client.js";
import { emailChannel } from "../channels/email.js";
import { checkPaymentAllowed, type GuardCode } from "../payments/guard.js";
import { chargeDeposit } from "../payments/stripe.js";
import { paymentAccountFor } from "../payments/customers.js";
import { advanceJob, fireEvent } from "../jobs/advanceJob.js";
import { currentCaller, loadOwnedJob } from "./access.js";
import { toolError, type ErrorCode } from "./errors.js";
import { money, ok, runTool } from "./format.js";

const inputSchema = z.object({ job_id: z.string().uuid(), approval_id: z.string().uuid() });

const outputSchema = z.object({
  payment_id: z.string(),
  status: z.string(),
  vendor: z.string(),
  amount: z.string().nullable(),
  stripe_payment_intent: z.string().nullable(),
  receipts_sent: z.boolean(),
  next: z.string(),
});

const GUARD_ERRORS: Record<GuardCode, { message: string; next: string; retryable: boolean }> = {
  APPROVAL_NOT_FOUND: { message: "No approval with that id on this job.", next: "Call request_approval first, then wait_for_job with until='approval_decided'.", retryable: false },
  APPROVAL_PENDING: { message: "The human has not replied to the approval email yet.", next: "Call wait_for_job with until='approval_decided', then call pay again.", retryable: true },
  APPROVAL_DECLINED: { message: "The human declined this deposit.", next: "Call list_quotes and request_approval for a different quote, or cancel_job.", retryable: false },
  APPROVAL_EXPIRED: { message: "This approval expired or was already used.", next: "Call request_approval again to get a fresh approval.", retryable: false },
  AMOUNT_MISMATCH: { message: "The quote changed since the human approved it.", next: "Call list_quotes and request_approval again for the current quote.", retryable: false },
  OVER_SPEND_CAP: { message: "The deposit is over the spending cap.", next: "Pick a quote with a smaller deposit.", retryable: false },
  JOB_NOT_READY: { message: "The job is not in a payable state.", next: "Call get_job to see the current state.", retryable: false },
};

async function sendReceipts(job: JobRow, approval: ApprovalRow, payment: PaymentRow, vendorName: string): Promise<boolean> {
  const amount = money(payment.amount_cents);
  let allSent = true;

  const send = async (parentId: string | null | undefined, text: string, key: string, vendorId: string | null) => {
    if (!parentId) return (allSent = false);
    try {
      const res = await emailChannel.replyTo(parentId, text, key);
      await insertMessage({
        job_id: job.id,
        vendor_id: vendorId,
        approval_id: approval.id,
        direction: "out",
        kind: "receipt",
        provider_email_id: res.providerId,
        thread_id: null,
        from_address: getConfig().PRIMITIVE_FROM_ADDRESS,
        subject: null,
        body_text: text,
        attachments: [],
        sender_authenticated: null,
        parse_status: "none",
      });
    } catch (err) {
      allSent = false;
      console.error(`[pay] receipt ${key} failed:`, err instanceof Error ? err.message : err);
    }
  };

  // To the human: a reply on the approval thread (to the email they approved with).
  const decision = approval.decision_message_id
    ? ((await db().from("messages").select("provider_email_id").eq("id", approval.decision_message_id).maybeSingle()).data as { provider_email_id: string } | null)
    : null;
  await send(
    decision?.provider_email_id,
    `Done: paid the $${amount} deposit to ${vendorName} (Stripe test mode). Reference: ${payment.stripe_payment_intent_id}.`,
    `receipt:${payment.id}:buyer`,
    null,
  );

  // To the vendor: a reply in their thread.
  const vendorParent = await getLatestInboundFromVendor(approval.vendor_id);
  await send(
    vendorParent?.provider_email_id,
    `Hi ${vendorName},\n\nGreat news: the client accepted your quote and the $${amount} deposit has been paid. Reference: ${payment.stripe_payment_intent_id}. We'll be in touch with final details.\n\nThank you!`,
    `receipt:${payment.id}:vendor`,
    approval.vendor_id,
  );
  return allSent;
}

export function registerPay(server: MCPServer) {
  return server.tool(
    {
      name: "pay",
      description: "Pay the approved deposit. Works only after the human approved this exact vendor and amount.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id, approval_id }, ctx) =>
      runTool("pay", async () => {
        const cfg = getConfig();
        const caller = currentCaller(ctx);
        await loadOwnedJob(job_id, caller);
        await advanceJob(job_id);
        const job = (await getJob(job_id))!;

        const approval = await getApproval(approval_id);
        const [quote, existing, vendors] = await Promise.all([
          approval ? getQuote(approval.quote_id) : Promise.resolve(null),
          approval ? getPaymentByApproval(approval.id) : Promise.resolve(null),
          getVendors(job_id),
        ]);
        const vendorName = vendors.find((v) => v.id === approval?.vendor_id)?.name ?? "the vendor";

        const verdict = checkPaymentAllowed({
          job,
          approval,
          quote,
          existingPayment: existing,
          spendCapCents: cfg.SPEND_CAP_CENTS,
          now: new Date(),
        });
        if (!verdict.ok) {
          const e = GUARD_ERRORS[verdict.code];
          await insertJobEvent(job_id, "payment_refused", { code: verdict.code, approval_id });
          throw toolError(verdict.code as ErrorCode, e.message, e.next, { retryable: e.retryable });
        }

        // Idempotent repeat: already paid for this approval.
        if (verdict.existingPayment && existing) {
          return ok({
            payment_id: existing.id,
            status: "succeeded",
            vendor: vendorName,
            amount: money(existing.amount_cents),
            stripe_payment_intent: existing.stripe_payment_intent_id,
            receipts_sent: true,
            next: "Done. The job is paid.",
          });
        }

        // The guard passed, so approval is non-null and its amount matches the quote.
        const ap = approval!;
        // Same key for concurrent or retried calls at this job version, so Stripe
        // never charges twice. After a recorded failure the version moves on,
        // which lets a deliberate retry try the card again.
        const idempotencyKey = `pay:${ap.id}:v${job.version}`;
        const charge = await chargeDeposit({
          amountCents: ap.amount_cents,
          idempotencyKey,
          metadata: { job_id, approval_id: ap.id, vendor_id: ap.vendor_id },
          description: `Catering deposit to ${vendorName} (job ${job.short_code})`,
          account: await paymentAccountFor(caller),
        });

        if (!charge.ok) {
          await insertJobEvent(job_id, "payment_failed", { approval_id: ap.id, reason: charge.reason });
          await fireEvent(job_id, { type: "payment_failed" }, { approval_id: ap.id });
          throw toolError("PAYMENT_FAILED", `The charge failed (${charge.reason}).`, "Call pay again to retry, or cancel_job.", { retryable: true });
        }

        // Record exactly one payment per approval (unique approval_id).
        const payment =
          (await insertPayment({
            job_id,
            approval_id: ap.id,
            amount_cents: ap.amount_cents,
            stripe_payment_intent_id: charge.paymentIntentId,
            status: "succeeded",
            idempotency_key: idempotencyKey,
          })) ?? (await getPaymentByApproval(ap.id))!;
        await transitionApproval(ap.id, "approved", { status: "used" });
        await fireEvent(job_id, { type: "payment_succeeded" }, { approval_id: ap.id, payment_id: payment.id });

        const receiptsSent = await sendReceipts(job, ap, payment, vendorName);
        return ok({
          payment_id: payment.id,
          status: "succeeded",
          vendor: vendorName,
          amount: money(payment.amount_cents),
          stripe_payment_intent: payment.stripe_payment_intent_id,
          receipts_sent: receiptsSent,
          next: "Done. The job is paid.",
        });
      }),
  );
}
