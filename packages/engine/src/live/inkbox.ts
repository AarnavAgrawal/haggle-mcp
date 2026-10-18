// LIVE MODE (v5): Inkbox adapters for the engine ports. The buyer is one Inkbox agent identity
// (`haggle`); every job shares its mailbox and replies are matched by thread, In-Reply-To and the
// [HG-code] subject tag. This file is the only place Inkbox is called.
//
// Sender trust. Inkbox mail webhooks carry no DKIM/DMARC results, so an address alone proves
// nothing. A reply is trusted only when the sender is an Inkbox agent identity AND the same RFC
// Message-ID is found as an *outbound* message in that identity's own mailbox (it really sent it).
// Mail from outside Inkbox is stored but never becomes a quote ("unverified-external-sender").
// Seller content is untrusted data throughout.
import { CallMode, CallOrigin, Inkbox, InkboxAPIError, InkboxConnectionError, verifyWebhook as sdkVerifyWebhook, type A2AClient, type A2AResolvedTarget, type A2AWireMessage, type A2AWireTask, type MailWebhookPayload } from "@inkbox/sdk";
import { attachmentKind, imageContentType, MAX_IMAGE_BYTES, MAX_JSON_BYTES, MAX_PDF_BYTES, type ExtractedFile } from "../inbound/attachments.ts";
import { normalizeMessageId } from "../inbound/matching.ts";
import type { InboundMessage, TrustVerdict } from "../inbound/primitive.ts";
import { replySubject, type OutboundEmail, type SendOutcome } from "../outbound/primitiveSender.ts";
import type { MessageRow } from "../store/types.ts";
import { ChannelSendError, inlineAttachments, type A2AAgentMessage, type A2APort, type A2ATaskView, type AttachmentPort, type EmailPort, type IMessagePort, type PhoneCallRequest, type PhonePort, type SendFailureReason, type VoiceContextPort } from "../workflow/ports.ts";

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
      let sent;
      try {
        sent = await withRetry(() => api.send(buyerMailbox, {
          to: [msg.to],
          subject: msg.thread ? replySubject(msg.subject) : msg.subject,
          bodyText: msg.bodyText,
          ...(msg.thread ? { inReplyToMessageId: msg.thread.inReplyTo } : {}),
          ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, contentBase64: Buffer.from(a.content).toString("base64") })) } : {}),
          idempotencyKey: msg.idempotencyKey,
        }), opts.sleep);
      } catch (e) {
        throw mapInkboxError(e);
      }
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

/** AttachmentPort: fetch PDFs, images and JSON parts through Inkbox signed URLs, with size caps and a timeout. */
export function inkboxAttachments(api: InkboxMailApi, buyerMailbox: string, fetchImpl: typeof fetch = fetch): AttachmentPort {
  return {
    async load(m: MessageRow): Promise<ExtractedFile[]> {
      const files: ExtractedFile[] = await inlineAttachments.load(m);
      if (!m.provider_email_id) return files;
      let pdfBytes = 0;
      let imageBytes = 0;
      for (const a of m.attachments) {
        if (a.content_base64 || !a.filename) continue;
        const kind = attachmentKind({ tarPath: a.filename, contentType: a.content_type, filename: a.filename });
        if (!kind) continue;
        const cap = kind === "pdf" ? MAX_PDF_BYTES - pdfBytes : kind === "image" ? MAX_IMAGE_BYTES - imageBytes : MAX_JSON_BYTES;
        if (a.size_bytes > cap) continue;
        const { url } = await api.getAttachment(buyerMailbox, m.provider_email_id, a.filename);
        if (!isHttps(url)) throw new Error("attachment URL is not https");
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
        if (!res.ok) throw new Error(`attachment download failed (${res.status})`);
        const data = Buffer.from(await res.arrayBuffer());
        if (data.byteLength > cap) continue;
        if (kind === "pdf") pdfBytes += data.byteLength;
        if (kind === "image") imageBytes += data.byteLength;
        files.push({ kind, filename: a.filename, data, ...(kind === "image" ? { contentType: imageContentType(a.content_type, a.filename)! } : {}) });
      }
      return files;
    },
  };
}

// Inkbox error codes -> ChannelSendError (ported from haggle-testing src/comms/channels/types.ts
// mapInkboxError): retry the same channel later, move on to the next channel, or give up.
const RETRY_CODES: Record<string, [SendFailureReason, number]> = {
  idempotency_in_progress: ["provider_error", 20_000], send_outcome_ambiguous: ["provider_error", 20_000],
  hosted_agent_at_capacity: ["provider_error", 20_000], hosted_agent_unavailable: ["provider_error", 20_000], call_capacity_busy: ["provider_error", 20_000],
  mail_rate_limited: ["rate_limited", 120_000], sender_rate_limited: ["rate_limited", 120_000], concurrent_calls_limit: ["rate_limited", 120_000],
  new_external_recipient_limit: ["rate_limited", 120_000], sender_sms_pending: ["channel_not_configured", 120_000],
};
const HARD_CODES: Record<string, SendFailureReason> = {
  recipient_blocked: "invalid_address", invalid_receiver_number: "invalid_address", invalid_destination_number: "invalid_address", invalid_recipient: "invalid_address",
  recipient_not_opted_in: "not_opted_in", recipient_opted_out: "opted_out",
};

/** Classify any error thrown by an Inkbox send (after the SDK's own bounded retries). */
export function mapInkboxError(e: unknown): ChannelSendError {
  if (e instanceof ChannelSendError) return e;
  if (e instanceof InkboxConnectionError) return new ChannelSendError("provider_error", true, 30_000, "Inkbox unreachable");
  const status = (e as { statusCode?: number }).statusCode;
  const detail = (e as { detail?: unknown; code?: unknown; body?: unknown }) ?? {};
  const raw = detail.detail ?? detail.body;
  const code = String((raw && typeof raw === "object" ? ((raw as { error?: unknown; code?: unknown }).error ?? (raw as { code?: unknown }).code) : undefined) ?? detail.code ?? "").toLowerCase();
  const msg = (e as Error)?.message ?? "send failed";
  if (code && RETRY_CODES[code]) return new ChannelSendError(RETRY_CODES[code]![0], true, RETRY_CODES[code]![1], `${code}: ${msg}`);
  if (code && HARD_CODES[code]) return new ChannelSendError(HARD_CODES[code]!, false, 0, `${code}: ${msg}`);
  if (status === 429) return new ChannelSendError("rate_limited", true, 120_000, msg);
  if (status !== undefined && status >= 500) return new ChannelSendError("provider_error", true, 30_000, msg);
  if (status === 400 || status === 404 || status === 422) return new ChannelSendError("invalid_address", false, 0, msg);
  return new ChannelSendError("provider_error", false, 0, msg);
}

export type CallEnded = {
  callId: string;
  outcome: "completed" | "no_answer" | "declined" | "failed";
  transcript: string;
  endedAt?: string;
  /** The webhook's inline transcript was cut in the middle; fetch the full one before parsing. */
  abridged?: boolean;
  direction?: "outbound" | "inbound";
  remoteNumber?: string;
};

/** Map an Inkbox `call.ended` event to HaggleEngine.ingestCall input (transcript as plain text). */
export function inkboxCallEnded(payload: { data: Record<string, unknown> }): CallEnded | null {
  const d = payload.data as { call?: { id?: string; ended_at?: string | null; direction?: string; remote_phone_number?: string }; transcript?: { entries?: { party?: string; text?: string; marker?: string }[]; abridged?: boolean } | null; outcome?: string | null };
  if (!d.call?.id) return null;
  const outcome = (["completed", "no_answer", "declined", "failed"] as const).find((o) => o === d.outcome) ?? "failed";
  const transcript = (d.transcript?.entries ?? []).filter((e) => typeof e.text === "string").map((e) => `${e.party ?? "party"}: ${e.text}`).join("\n");
  return {
    callId: d.call.id, outcome, transcript, ...(d.call.ended_at ? { endedAt: d.call.ended_at } : {}),
    ...(d.transcript?.abridged ? { abridged: true } : {}),
    ...(d.call.direction === "inbound" || d.call.direction === "outbound" ? { direction: d.call.direction } : {}),
    ...(d.call.remote_phone_number ? { remoteNumber: d.call.remote_phone_number } : {}),
  };
}

/** The authoritative full transcript (the webhook's inline one may be abridged in the middle). */
export async function fullCallTranscript(identity: { listTranscripts(callId: string): Promise<{ seq: number; party: string; text: string }[]> }, callId: string): Promise<string> {
  const turns = await withRetry(() => identity.listTranscripts(callId));
  return [...turns].sort((a, b) => a.seq - b.seq).filter((t) => t.text).map((t) => `${t.party === "local" ? "haggle (AI assistant)" : t.party}: ${t.text}`).join("\n");
}

/** Where a buyer call originates: its own number, or Inkbox's shared iMessage line (no number needed). */
export type CallOriginChoice = "dedicated_number" | "shared_imessage_number";

/**
 * PhonePort over Inkbox Voice AI (hosted agent). NOT wired by default: live calls need explicit
 * approval (HAGGLE_ENABLE_CALLS=true) and may only go to simulated businesses or people who agreed.
 * `503 hosted_agent_at_capacity` and other 5xx are retried (bounded) with backoff.
 */
export function inkboxPhone(identity: { placeCall(o: { toNumber: string; origination?: CallOrigin; mode?: CallMode; reason?: string }): Promise<{ id: string }> }, origin: CallOriginChoice = "dedicated_number", sleep?: (ms: number) => Promise<void>): PhonePort {
  return {
    async placeCall(req: PhoneCallRequest) {
      try {
        const call = await withRetry(() => identity.placeCall({
          toNumber: req.toNumber, origination: origin === "shared_imessage_number" ? CallOrigin.SHARED_IMESSAGE_NUMBER : CallOrigin.DEDICATED_NUMBER,
          mode: CallMode.HOSTED_AGENT, reason: req.reason.slice(0, 2000),
        }), sleep);
        return { callId: call.id };
      } catch (e) {
        throw mapInkboxError(e);
      }
    },
  };
}

/**
 * VoiceContextPort over the buyer identity's Voice AI config: replaces the answering instructions
 * (full replace, keeping the saved voice) so a business calling back is matched to its request.
 */
export function inkboxVoiceContext(identity: { getHostedAgentConfig(): Promise<{ voice: string | null; instructions: string | null }>; setHostedAgentConfig(o: { voice?: string; instructions?: string }): Promise<unknown> }): VoiceContextPort {
  let last: string | null = null;
  return {
    async setInstructions(instructions) {
      if (instructions === last) return;
      const cur = await identity.getHostedAgentConfig();
      if (cur.instructions === instructions) {
        last = instructions;
        return;
      }
      await identity.setHostedAgentConfig({ ...(cur.voice ? { voice: cur.voice } : {}), instructions });
      last = instructions;
    },
  };
}

/** "ROLE_AGENT" / "agent" -> the seller's side. */
const isAgent = (role: unknown) => typeof role === "string" && /agent/i.test(role);

function toAgentMessage(m: A2AWireMessage): A2AAgentMessage {
  const parts = (m.parts ?? []) as { text?: unknown; data?: unknown }[];
  return {
    messageId: String(m.messageId),
    text: parts.flatMap((p) => (typeof p.text === "string" ? [p.text] : [])).join("\n"),
    data: parts.flatMap((p) => (p.data && typeof p.data === "object" && !Array.isArray(p.data) ? [p.data as Record<string, unknown>] : [])),
  };
}

/** A2A wire task -> engine view: agent messages from history + the final status message, deduped. */
export function a2aTaskView(t: A2AWireTask): A2ATaskView {
  const seen = new Set<string>();
  const msgs: A2AAgentMessage[] = [];
  const status = t.status as { state?: string; message?: A2AWireMessage };
  for (const m of [...(t.history ?? []), ...(status.message ? [status.message] : [])]) {
    if (!isAgent(m.role) || seen.has(String(m.messageId))) continue;
    seen.add(String(m.messageId));
    msgs.push(toAgentMessage(m));
  }
  const state = String(status.state ?? "").replace(/^TASK_STATE_/, "").toLowerCase() || "unknown";
  return { taskId: t.id, contextId: t.contextId, state: state === "input_required" ? "input_required" : state, agentMessages: msgs };
}

/**
 * A2APort over the buyer identity's agent-scoped A2A client. Cards are resolved once and only for
 * URLs the engine passes (the business's pinned card). Sends are retried with the SAME messageId.
 */
export function inkboxA2A(identity: { a2aClient(): Promise<A2AClient> }, sleep?: (ms: number) => Promise<void>): A2APort {
  let client: Promise<A2AClient> | null = null;
  const targets = new Map<string, Promise<A2AResolvedTarget>>();
  const target = async (cardUrl: string) => {
    if (!/^https:\/\//.test(cardUrl)) throw new Error("Agent Card URL must be https");
    const c = await (client ??= identity.a2aClient());
    if (!targets.has(cardUrl)) targets.set(cardUrl, c.fetchCard(cardUrl).catch((e) => { targets.delete(cardUrl); throw e; }));
    return { c, t: await targets.get(cardUrl)! };
  };
  return {
    async send(req) {
      const { c, t } = await target(req.cardUrl);
      const r = await withRetry(() => c.send(t, { parts: [{ text: req.text }, { data: req.data }], messageId: req.messageId, ...(req.contextId ? { contextId: req.contextId } : {}), ...(req.taskId ? { taskId: req.taskId } : {}) }), sleep);
      if (r.kind === "task") return { taskId: r.task.id, contextId: r.task.contextId, state: a2aTaskView(r.task).state };
      const m = r.message as A2AWireMessage & { taskId?: string; contextId?: string };
      if (!m.taskId) throw new Error("A2A agent answered without a task; Haggle needs a task to track the quote");
      return { taskId: m.taskId, contextId: m.contextId ?? "", state: "working" };
    },
    async getTask(req) {
      const { c, t } = await target(req.cardUrl);
      return a2aTaskView(await withRetry(() => c.getTask(t, req.taskId, { historyLength: 50 }), sleep));
    },
  };
}

/** One inbound iMessage, from the `imessage.received` webhook. */
export type IMessageReceived = { messageId: string; from: string; text: string; isGroup: boolean; conversationId: string; inbound: boolean };

export function inkboxIMessageReceived(payload: { data: Record<string, unknown> }): IMessageReceived | null {
  const m = (payload.data as { message?: { id?: string; direction?: string; sender_number?: string | null; remote_number?: string | null; content?: string | null; is_group?: boolean; conversation_id?: string } }).message;
  if (!m?.id) return null;
  return { messageId: m.id, from: (m.sender_number ?? m.remote_number ?? "").replace(/[\s().-]/g, ""), text: m.content ?? "", isGroup: m.is_group === true, conversationId: m.conversation_id ?? "", inbound: m.direction === "inbound" };
}

/** iMessage approval requests from the buyer identity (Inkbox router). NOT wired unless HAGGLE_ENABLE_IMESSAGE=true. */
export function inkboxIMessage(identity: { sendIMessage(o: { to: string; text: string; idempotencyKey?: string }): Promise<{ id: string }> }, sleep?: (ms: number) => Promise<void>): IMessagePort {
  return {
    async send(req) {
      const m = await withRetry(() => identity.sendIMessage({ to: req.to, text: req.text, idempotencyKey: req.idempotencyKey }), sleep);
      return { messageId: m.id };
    },
  };
}

/** Connect the buyer identity (default handle `haggle`). Its mailbox address comes from Inkbox, never derived. */
export async function connectInkboxBuyer(opts: { apiKey: string; handle: string }) {
  const inkbox = new Inkbox({ apiKey: opts.apiKey });
  const identity = await inkbox.getIdentity(opts.handle);
  const buyerMailbox = identity.emailAddress?.toLowerCase();
  if (!buyerMailbox) throw new Error(`Inkbox identity "${identity.agentHandle}" has no mailbox`);
  // Calls need a number: the identity's own, else Inkbox's shared iMessage line when iMessage is on.
  const callOrigin: CallOriginChoice | null = identity.phoneNumber ? "dedicated_number" : identity.imessageEnabled ? "shared_imessage_number" : null;
  return {
    api: inkboxMailApi(inkbox), buyerMailbox, callOrigin, imessageEnabled: identity.imessageEnabled,
    phone: () => (callOrigin ? inkboxPhone(identity as never, callOrigin) : null),
    a2a: () => inkboxA2A(identity as never),
    imessage: () => (identity.imessageEnabled ? inkboxIMessage(identity as never) : null),
    voice: () => inkboxVoiceContext(identity as never),
    identityInfo: { handle: identity.agentHandle, displayName: identity.displayName, phoneNumber: identity.phoneNumber?.number ?? null, imessageEnabled: identity.imessageEnabled },
    transcript: (callId: string) => fullCallTranscript(identity as never, callId),
  };
}
