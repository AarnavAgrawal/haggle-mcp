// LIVE MODE (v5): Inkbox adapters for the engine ports. The buyer is one Inkbox agent identity
// (`haggle`); every job shares its mailbox and replies are matched by thread, In-Reply-To and the
// [HG-code] subject tag. This file is the only place Inkbox is called.
//
// Sender trust. Inkbox mail webhooks carry no DKIM/DMARC results, so an address alone proves
// nothing. A reply is trusted only when the sender is an Inkbox agent identity AND the same RFC
// Message-ID is found as an *outbound* message in that identity's own mailbox (it really sent it).
// Mail from outside Inkbox is stored but never becomes a quote ("unverified-external-sender").
// Seller content is untrusted data throughout.
import { CallMode, Inkbox, InkboxAPIError, InkboxConnectionError, verifyWebhook as sdkVerifyWebhook, type MailWebhookPayload } from "@inkbox/sdk";
import { attachmentKind, MAX_JSON_BYTES, MAX_PDF_BYTES, type ExtractedFile } from "../inbound/attachments.ts";
import { normalizeMessageId } from "../inbound/matching.ts";
import type { InboundMessage, TrustVerdict } from "../inbound/primitive.ts";
import { replySubject, type OutboundEmail, type SendOutcome } from "../outbound/primitiveSender.ts";
import type { MessageRow } from "../store/types.ts";
import type { AttachmentPort, EmailPort, PhoneCallRequest, PhonePort } from "../workflow/ports.ts";

/** The slice of the Inkbox SDK the engine uses (`inkbox.messages`), so tests can fake it. */
export interface InkboxMailApi {
  send(mailbox: string, o: { to: string[]; subject: string; bodyText?: string; inReplyToMessageId?: string; attachments?: { filename: string; contentType: string; contentBase64: string }[]; idempotencyKey?: string }): Promise<{ id: string; messageId: string; status: string }>;
  get(mailbox: string, id: string): Promise<InkboxMessageDetail>;
  getAttachment(mailbox: string, id: string, filename: string): Promise<{ url: string }>;
  list(mailbox: string, o?: { pageSize?: number; direction?: "inbound" | "outbound"; startDatetime?: string }): AsyncIterable<{ messageId: string; direction: string }>;
}

export interface InkboxMessageDetail {
  id: string;
  threadId: string | null;
  messageId: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  bodyText: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  attachmentMetadata: Record<string, unknown>[] | null;
}

export function inkboxMailApi(inkbox: Inkbox): InkboxMailApi {
  const m = inkbox.messages;
  return {
    send: (mailbox, o) => m.send(mailbox, o as never) as never,
    get: (mailbox, id) => m.get(mailbox, id) as never,
    getAttachment: (mailbox, id, filename) => m.getAttachment(mailbox, id, filename),
    list: (mailbox, o) => m.list(mailbox, o as never) as never,
  };
}

const retryable = (e: unknown) => e instanceof InkboxConnectionError || (e instanceof InkboxAPIError && (e.statusCode === 429 || e.statusCode >= 500));

/** Bounded retries (3 attempts) with the SAME idempotency key, so a retry can never double-send. */
async function withRetry<T>(fn: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 2 || !retryable(e)) throw e;
      await sleep(250 * 2 ** attempt);
    }
  }
}

/** EmailPort over the buyer identity's mailbox. In-thread messages reply with inReplyToMessageId. */
export function inkboxEmail(api: InkboxMailApi, buyerMailbox: string, opts: { sleep?: (ms: number) => Promise<void> } = {}): EmailPort {
  return {
    async send(msg: OutboundEmail): Promise<SendOutcome> {
      if (msg.from.toLowerCase() !== buyerMailbox.toLowerCase()) throw new Error("outbound mail must come from the buyer identity mailbox");
      const sent = await withRetry(() => api.send(buyerMailbox, {
        to: [msg.to],
        subject: msg.thread ? replySubject(msg.subject) : msg.subject,
        bodyText: msg.bodyText,
        ...(msg.thread ? { inReplyToMessageId: msg.thread.inReplyTo } : {}),
        ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, contentBase64: Buffer.from(a.content).toString("base64") })) } : {}),
        idempotencyKey: msg.idempotencyKey,
      }), opts.sleep);
      return { providerId: sent.id, status: sent.status, idempotentReplay: false, messageId: sent.messageId || null };
    },
  };
}

export type InkboxWebhookVerdict =
  | { ok: true; payload: { id: string; event_type: string; timestamp?: string; data: Record<string, unknown> } }
  | { ok: false; reason: "invalid_signature" | "stale_timestamp" | "bad_payload" };

/**
 * Verify X-Inkbox-Signature on the RAW body (the identity's signing key), reject stale deliveries
 * (> toleranceS old when the timestamp header is parseable), then parse. Replays of a fresh
 * delivery are stopped by event-id dedupe (Repository.recordInboundEvent).
 */
export function verifyInkboxWebhook(rawBody: string, headers: Headers, secret: string, now = new Date(), toleranceS = 300): InkboxWebhookVerdict {
  const h: Record<string, string> = {};
  headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  let valid = false;
  try {
    valid = sdkVerifyWebhook({ payload: rawBody, headers: h, secret });
  } catch {
    valid = false; // e.g. signature of the wrong length
  }
  if (!valid) return { ok: false, reason: "invalid_signature" };
  const ts = h["x-inkbox-timestamp"];
  if (ts) {
    const n = Number(ts);
    const ms = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(ts);
    if (Number.isFinite(ms) && Math.abs(now.getTime() - ms) > toleranceS * 1000) return { ok: false, reason: "stale_timestamp" };
  }
  try {
    const p = JSON.parse(rawBody) as { id?: unknown; event_type?: unknown; data?: unknown };
    if (typeof p.id !== "string" || typeof p.event_type !== "string" || typeof p.data !== "object" || p.data === null) return { ok: false, reason: "bad_payload" };
    return { ok: true, payload: p as never };
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
}

const lower = (s: string) => s.trim().toLowerCase();
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Map an Inkbox `message.received` event + the full message (fetched by id) to the engine's InboundMessage. */
export function inkboxToInbound(payload: { id: string; event_type: string }, detail: InkboxMessageDetail): InboundMessage {
  const attachments = (detail.attachmentMetadata ?? []).flatMap((a, i) => {
    const filename = str(a.filename) ?? str(a.name);
    if (!filename) return [];
    const contentType = str(a.content_type) ?? str(a.contentType) ?? str(a.mime_type) ?? "application/octet-stream";
    const size = Number(a.size ?? a.size_bytes ?? a.sizeBytes ?? 0);
    // tarPath carries the Inkbox attachment filename (the key getAttachment() needs).
    return [{ filename, contentType, sizeBytes: Number.isFinite(size) ? size : 0, partIndex: i, tarPath: filename }];
  });
  return {
    providerEventId: payload.id,
    eventType: payload.event_type,
    providerEmailId: detail.id,
    threadId: detail.threadId,
    messageId: detail.messageId || null,
    inReplyTo: detail.inReplyTo ? [detail.inReplyTo] : [],
    references: detail.references ?? [],
    from: detail.fromAddress ? lower(detail.fromAddress) : null,
    to: detail.toAddresses.map(lower),
    subject: detail.subject,
    bodyText: detail.bodyText,
    attachments,
    attachmentsDownloadUrl: null,
  };
}

const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] as string[] };

/**
 * Sender-trust policy for Inkbox mail.
 * - "outbound-verified" (default, strongest): the sender is a same-org Inkbox identity AND its own
 *   mailbox holds the same Message-ID as an outbound message. Needs a key that can read the
 *   seller's mailbox (admin-scoped); an agent-scoped buyer key gets 403 -> not verifiable.
 * - "pinned-org-identity" (operator opt-in for an agent-scoped buyer key): the sender is a
 *   same-org Inkbox identity (webhook from-bucket match) AND on `allowedSenders` (the demo fleet).
 *   Weaker: the identity match is by address and inkboxmail.com publishes DMARC p=none, so it is
 *   recorded as "inkbox-org-identity" (outbound not verified), never as fully verified.
 */
export type InkboxTrustPolicy = { policy: "outbound-verified"; lookbackMessages?: number } | { policy: "pinned-org-identity"; allowedSenders: string[] };

/**
 * Is this inbound message really from its From address? See InkboxTrustPolicy. API failures are
 * retryable (the webhook answers 503 so Inkbox redelivers); a 403/404 (key can't see that mailbox)
 * is not.
 */
export async function inkboxSenderTrust(api: InkboxMailApi, payload: Pick<MailWebhookPayload, "data">, detail: InkboxMessageDetail, opts: { lookbackMessages?: number } | InkboxTrustPolicy = {}): Promise<TrustVerdict> {
  const from = detail.fromAddress ? lower(detail.fromAddress) : "";
  if (!from) return { trusted: false, retryable: false, reason: "no-expected-address", evidence: noEvidence };
  const ids = (payload.data.agent_identities ?? []) as { bucket: string; address: string }[];
  const isIdentity = ids.some((x) => x.bucket === "from" && lower(x.address) === from);
  if (!isIdentity) return { trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence };
  if ("policy" in opts && opts.policy === "pinned-org-identity") {
    const pinned = opts.allowedSenders.some((a) => lower(a) === from);
    return pinned
      ? { trusted: true, address: from, reason: "inkbox-org-identity", evidence: { ...noEvidence, dmarc: "inkbox-org-identity (outbound not verified)" } }
      : { trusted: false, retryable: false, reason: "sender-not-verifiable", evidence: noEvidence };
  }
  const lookback = "lookbackMessages" in opts ? opts.lookbackMessages : undefined;
  const want = normalizeMessageId(detail.messageId ?? "");
  if (!want) return { trusted: false, retryable: false, reason: "sender-not-verifiable", evidence: noEvidence };
  try {
    let seen = 0;
    for await (const m of api.list(from, { direction: "outbound", pageSize: 25 })) {
      if (normalizeMessageId(m.messageId ?? "") === want) return { trusted: true, address: from, reason: "trusted", evidence: { ...noEvidence, dmarc: "inkbox-identity-outbound-match" } };
      if (++seen >= (lookback ?? 50)) break;
    }
    return { trusted: false, retryable: false, reason: "sender-not-verifiable", evidence: noEvidence };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 403 || status === 404) return { trusted: false, retryable: false, reason: "sender-not-verifiable", evidence: noEvidence };
    return { trusted: false, retryable: true, reason: "inkbox-verify-unavailable", evidence: noEvidence };
  }
}

/** Per-expected-address trust callback for HaggleEngine.ingest, from one precomputed verdict. */
export function trustForSender(verdict: TrustVerdict, from: string | null): (expected: string) => TrustVerdict {
  return (expected) => (from && lower(expected) === lower(from) ? verdict : { trusted: false, retryable: false, reason: "sender-mismatch", evidence: noEvidence });
}

/** True for an https URL (Inkbox hands out short-lived signed URLs; no credentials are sent to them). */
function isHttps(url: string) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** AttachmentPort: fetch PDFs and JSON parts through Inkbox signed URLs, with size caps and a timeout. */
export function inkboxAttachments(api: InkboxMailApi, buyerMailbox: string, fetchImpl: typeof fetch = fetch): AttachmentPort {
  return {
    async load(m: MessageRow): Promise<ExtractedFile[]> {
      const files: ExtractedFile[] = m.attachments.filter((a) => a.content_base64).map((a) => ({ kind: a.content_type === "application/pdf" ? ("pdf" as const) : ("json" as const), filename: a.filename ?? "attachment", data: Buffer.from(a.content_base64!, "base64") }));
      if (!m.provider_email_id) return files;
      let pdfBytes = 0;
      for (const a of m.attachments) {
        if (a.content_base64 || !a.filename) continue;
        const kind = attachmentKind({ tarPath: a.filename, contentType: a.content_type, filename: a.filename });
        if (!kind) continue;
        const cap = kind === "pdf" ? MAX_PDF_BYTES - pdfBytes : MAX_JSON_BYTES;
        if (a.size_bytes > cap) continue;
        const { url } = await api.getAttachment(buyerMailbox, m.provider_email_id, a.filename);
        if (!isHttps(url)) throw new Error("attachment URL is not https");
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
        if (!res.ok) throw new Error(`attachment download failed (${res.status})`);
        const data = Buffer.from(await res.arrayBuffer());
        if (data.byteLength > cap) continue;
        if (kind === "pdf") pdfBytes += data.byteLength;
        files.push({ kind, filename: a.filename, data });
      }
      return files;
    },
  };
}

/** Map an Inkbox `call.ended` event to HaggleEngine.ingestCall input (transcript as plain text). */
export function inkboxCallEnded(payload: { data: Record<string, unknown> }): { callId: string; outcome: "completed" | "no_answer" | "declined" | "failed"; transcript: string; endedAt?: string } | null {
  const d = payload.data as { call?: { id?: string; ended_at?: string | null }; transcript?: { entries?: { party?: string; text?: string }[] } | null; outcome?: string | null };
  if (!d.call?.id) return null;
  const outcome = (["completed", "no_answer", "declined", "failed"] as const).find((o) => o === d.outcome) ?? "failed";
  const transcript = (d.transcript?.entries ?? []).filter((e) => typeof e.text === "string").map((e) => `${e.party ?? "party"}: ${e.text}`).join("\n");
  return { callId: d.call.id, outcome, transcript, ...(d.call.ended_at ? { endedAt: d.call.ended_at } : {}) };
}

/**
 * PhonePort over Inkbox Voice AI (hosted agent). NOT wired by default: live calls need explicit
 * approval (HAGGLE_ENABLE_CALLS=true) and may only go to simulated businesses or people who agreed.
 */
export function inkboxPhone(identity: { placeCall(o: { toNumber: string; mode?: CallMode; reason?: string }): Promise<{ id: string }> }): PhonePort {
  return {
    async placeCall(req: PhoneCallRequest) {
      const call = await withRetry(() => identity.placeCall({ toNumber: req.toNumber, mode: CallMode.HOSTED_AGENT, reason: req.reason.slice(0, 2000) }));
      return { callId: call.id };
    },
  };
}

/** Connect the buyer identity (default handle `haggle`). Its mailbox address comes from Inkbox, never derived. */
export async function connectInkboxBuyer(opts: { apiKey: string; handle: string }) {
  const inkbox = new Inkbox({ apiKey: opts.apiKey });
  const identity = await inkbox.getIdentity(opts.handle);
  const buyerMailbox = identity.emailAddress?.toLowerCase();
  if (!buyerMailbox) throw new Error(`Inkbox identity "${identity.agentHandle}" has no mailbox`);
  return { api: inkboxMailApi(inkbox), buyerMailbox, phone: () => inkboxPhone(identity as never) };
}
