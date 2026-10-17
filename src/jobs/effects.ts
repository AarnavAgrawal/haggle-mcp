// Execute the effects a committed transition asked for (DESIGN.md §7.2).
// Every send has an idempotency key, so re-running an effect never sends
// a second copy.
import {
  getCurrentQuotes,
  getLatestInboundFromVendor,
  getPendingApproval,
  getVendors,
  insertJobEvent,
  insertMessage,
  transitionApproval,
  type JobRow,
} from "../db/queries.js";
import { emailChannel } from "../channels/email.js";
import { planCounteroffers } from "../negotiator/counteroffer.js";
import { getConfig } from "../config.js";
import type { Effect } from "./stateMachine.js";

const CANCEL_NOTE = [
  "Hi,",
  "",
  "Thank you for your quote. The client has cancelled this catering request, so we won't be moving forward. Sorry for the trouble, and thanks for your time.",
].join("\n");

async function sendCounteroffers(job: JobRow, round: number): Promise<void> {
  const [quotes, vendors] = await Promise.all([getCurrentQuotes(job.id), getVendors(job.id)]);
  const names = new Map(vendors.map((v) => [v.id, v.name]));
  const deadline = new Date(job.collect_until ?? Date.now());

  const plan = planCounteroffers(
    quotes.map((q) => ({
      vendorId: q.vendor_id,
      vendorName: names.get(q.vendor_id) ?? "there",
      perHeadCents: q.price_per_head_cents,
      available: q.available,
    })),
    deadline,
  );

  let sent = 0;
  for (const counter of plan) {
    // Reply to the vendor's latest email so the counteroffer lands in their thread.
    const parent = await getLatestInboundFromVendor(counter.vendorId);
    if (!parent?.provider_email_id) continue;
    try {
      const res = await emailChannel.replyTo(parent.provider_email_id, counter.text, `counter:${counter.vendorId}:${round}`);
      await insertMessage({
        job_id: job.id,
        vendor_id: counter.vendorId,
        direction: "out",
        kind: "counter",
        round,
        provider_email_id: res.providerId,
        rfc_message_id: res.messageId ?? null,
        thread_id: parent.thread_id,
        from_address: getConfig().PRIMITIVE_FROM_ADDRESS,
        subject: parent.subject ? `Re: ${parent.subject.replace(/^(re:\s*)+/i, "")}` : null,
        body_text: counter.text,
        attachments: [],
        sender_authenticated: null,
        parse_status: "none",
      });
      sent++;
    } catch (err) {
      console.error(`[effects] counteroffer to ${counter.vendorId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  // Marks the round as dispatched; advanceJob waits for this before treating
  // "all countered vendors replied" as true.
  await insertJobEvent(job.id, "counteroffers_sent", { round, count: sent, planned: plan.length });
}

async function notifyCancelled(job: JobRow): Promise<void> {
  const pending = await getPendingApproval(job.id);
  if (pending) await transitionApproval(pending.id, "pending", { status: "expired", decided_at: new Date().toISOString() });

  for (const v of await getVendors(job.id)) {
    if (v.status !== "replied" && v.status !== "declined") continue;
    const parent = await getLatestInboundFromVendor(v.id);
    if (!parent?.provider_email_id) continue;
    try {
      const res = await emailChannel.replyTo(parent.provider_email_id, CANCEL_NOTE, `cancel:${v.id}`);
      await insertMessage({
        job_id: job.id,
        vendor_id: v.id,
        direction: "out",
        kind: "cancel_note",
        provider_email_id: res.providerId,
        thread_id: parent.thread_id,
        from_address: getConfig().PRIMITIVE_FROM_ADDRESS,
        subject: null,
        body_text: CANCEL_NOTE,
        attachments: [],
        sender_authenticated: null,
        parse_status: "none",
      });
    } catch (err) {
      console.error(`[effects] cancel note to ${v.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export async function runEffects(job: JobRow, effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "send_counteroffers") await sendCounteroffers(job, effect.round);
    else if (effect.type === "notify_cancelled") await notifyCancelled(job);
  }
}
