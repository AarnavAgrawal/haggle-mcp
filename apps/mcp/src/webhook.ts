// POST /webhooks/inkbox for the buyer identity (mail + call.ended): verify the signature on the RAW
// body first, then one idempotent ingest. Unknown event types are acknowledged and ignored.
// Kept free of the HTTP framework so the route can be tested with Inkbox fakes.
import { inkboxCallEnded, inkboxSenderTrust, inkboxToInbound, RetryLater, trustForSender, verifyInkboxWebhook } from "@haggle/engine";
import type { Runtime } from "./runtime.ts";

export type WebhookResult = { status: 200 | 400 | 401 | 404 | 503; body: Record<string, unknown>; jobId?: string | null; outcome?: string };

export async function handleInkboxWebhook(rt: Runtime, raw: string, headers: Headers, requestId: string = crypto.randomUUID()): Promise<WebhookResult> {
  if (!rt.inkbox) return { status: 404, body: { error: "webhooks are disabled in mock mode" } };
  const v = verifyInkboxWebhook(raw, headers, rt.inkbox.webhookSecret);
  if (!v.ok) return { status: 401, body: { error: v.reason } };
  const { payload } = v;
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
    } else if (payload.event_type === "call.ended") {
      const call = inkboxCallEnded(payload);
      if (call) ({ jobId, outcome } = await rt.engine.ingestCall(call));
    }
    if (jobId) void rt.engine.advanceJob(jobId).catch((e) => console.error(JSON.stringify({ level: "error", event: "advance_failed", requestId, error: (e as Error).message })));
    console.log(JSON.stringify({ level: "info", event: "inkbox_webhook", requestId, type: payload.event_type, outcome, job_id: jobId }));
    return { status: 200, body: { ok: true }, jobId, outcome };
  } catch (e) {
    console.error(JSON.stringify({ level: "error", event: "inkbox_webhook_failed", requestId, retry: e instanceof RetryLater, error: (e as Error).message }));
    return { status: 503, body: { error: e instanceof RetryLater ? "retry later" : "processing failed" } };
  }
}
