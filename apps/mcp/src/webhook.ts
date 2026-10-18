// POST /webhooks/inkbox for the buyer identity (mail, call.ended, imessage.received, text.received,
// a2a.sent_task.updated): verify the signature on the RAW body first, then one idempotent ingest.
// Unknown event types are acknowledged and ignored.
//
// Status codes. Permanent problems answer 4xx (bad signature 401, malformed payload 400, a message
// Inkbox says doesn't exist 422) or 200 (not for the buyer, ignored). A transient failure (database
// pool full / connection reset, Inkbox 5xx or unreachable, Anthropic overloaded, a timeout) answers
// 503 + Retry-After; anything unexpected 500. Either way nothing is lost: Inkbox delivers each event
// once (its delivery log has one attempt per event; replay is manual and keeps the event id), so the
// live runtime's InboundReconciler lists the mailbox, texts and calls and ingests what is missing.
// Ingest is idempotent by provider id, so a replay or a sweep after a 503 never double-ingests.
// Kept free of the HTTP framework so the route can be tested with Inkbox fakes.
import { classifyFailure, inkboxCallEnded, inkboxIMessageReceived, inkboxSenderTrust, inkboxTextReceived, inkboxToInbound, RetryLater, trustForSender, verifyInkboxWebhook } from "@haggle/engine";
import type { Runtime } from "./runtime.ts";

export type WebhookResult = { status: 200 | 400 | 401 | 404 | 422 | 500 | 503; body: Record<string, unknown>; jobId?: string | null; outcome?: string; retryAfterS?: number };

export async function handleInkboxWebhook(rt: Runtime, raw: string, headers: Headers, requestId: string = crypto.randomUUID()): Promise<WebhookResult> {
  if (!rt.inkbox) return { status: 404, body: { error: "webhooks are disabled in mock mode" } };
  const v = verifyInkboxWebhook(raw, headers, rt.inkbox.webhookSecret);
  if (!v.ok) return { status: 401, body: { error: v.reason } };
  const { payload } = v;
  let handled: string | null = null; // the reconciler's key for this item, once ingested
  try {
    let jobId: string | null = null;
    let outcome = "ignored";
    if (payload.event_type === "message.received") {
      const id = (payload.data.message as { id?: string } | undefined)?.id;
      if (!id) return { status: 400, body: { error: "bad payload" } };
      const detail = await rt.inkbox.api.get(rt.inkbox.buyerMailbox, id);
      if (!detail.toAddresses.map((a) => a.toLowerCase()).includes(rt.inkbox.buyerMailbox)) {
        outcome = "not_for_buyer";
      } else {
        const msg = inkboxToInbound(payload, detail);
        const trust = await inkboxSenderTrust(rt.inkbox.api, payload as never, detail, rt.inkbox.senderTrust);
        if (!trust.trusted && trust.retryable) throw new RetryLater("sender verification temporarily unavailable");
        ({ jobId, outcome } = await rt.engine.ingest(msg, trustForSender(trust, msg.from)));
      }
      handled = `mail:${id}`;
    } else if (payload.event_type === "call.ended") {
      const call = inkboxCallEnded(payload);
      if (call) {
        // The inline transcript can be cut in the middle (where the price often is): fetch the full one.
        if (call.abridged && call.outcome === "completed" && rt.inkbox.transcript) call.transcript = await rt.inkbox.transcript(call.callId);
        ({ jobId, outcome } = await rt.engine.ingestCall(call));
        handled = `call:${call.callId}`;
      }
    } else if (payload.event_type === "imessage.received") {
      const m = inkboxIMessageReceived(payload);
      if (m) ({ jobId, outcome } = await rt.engine.ingestIMessage(m));
    } else if (payload.event_type === "text.received") {
      const m = inkboxTextReceived(payload);
      if (m) {
        ({ jobId, outcome } = await rt.engine.ingestText(m));
        handled = `text:${m.messageId}`;
      }
    } else if (payload.event_type === "a2a.sent_task.updated") {
      const taskId = (payload.data as { task_id?: string }).task_id;
      if (taskId) ({ jobId, outcome } = await rt.engine.ingestA2aTask(taskId));
    }
    if (handled) rt.reconciler?.noteHandled(handled);
    if (jobId) void rt.engine.advanceJob(jobId).catch((e) => console.error(JSON.stringify({ level: "error", event: "advance_failed", requestId, error: (e as Error).message })));
    console.log(JSON.stringify({ level: "info", event: "inkbox_webhook", requestId, type: payload.event_type, outcome, job_id: jobId }));
    return { status: 200, body: { ok: true }, jobId, outcome };
  } catch (e) {
    const kind = classifyFailure(e);
    const recovery = rt.reconciler ? "the inbound sweep picks it up" : "replay it from the Inkbox delivery log";
    console.error(JSON.stringify({ level: "error", event: "inkbox_webhook_failed", requestId, type: payload.event_type, kind, retry: kind !== "permanent", recovery, error: (e as Error).message }));
    if (kind === "transient") return { status: 503, body: { error: "retry later", retry: true }, retryAfterS: 30 };
    if (kind === "permanent") return { status: 422, body: { error: "cannot process this event", retry: false } };
    return { status: 500, body: { error: "processing failed", retry: true } };
  }
}
