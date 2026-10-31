// LIVE MODE (v5): Inkbox adapters for the engine ports. The buyer is one Inkbox agent identity
// (`haggle`); every job shares its mailbox and replies are matched by thread and In-Reply-To/References
// (Haggle's own Message-IDs; no code is sent). This file is the only place Inkbox is called.
//
// Sender trust. Inkbox mail webhooks carry no DKIM/DMARC results, so an address alone proves
// nothing. A reply is trusted only when the sender is an Inkbox agent identity AND the same RFC
// Message-ID is found as an *outbound* message in that identity's own mailbox (it really sent it).
// Mail from outside Inkbox is stored but never becomes a quote ("unverified-external-sender").
// Seller content is untrusted data throughout.
import { CallMode, CallOrigin, Inkbox, InkboxAPIError, InkboxConnectionError, verifyWebhook as sdkVerifyWebhook, type A2AClient, type A2AResolvedTarget, type A2AWireMessage, type A2AWireTask, type MailWebhookPayload } from "@inkbox/sdk";
import { attachmentKind, imageContentType, MAX_IMAGE_BYTES, MAX_JSON_BYTES, MAX_PDF_BYTES, verifiedKind, type ExtractedFile } from "../inbound/attachments.ts";
import { htmlToText } from "../inbound/htmlText.ts";
import { normalizeMessageId } from "../inbound/matching.ts";
import type { InboundMessage, TrustVerdict } from "../inbound/types.ts";
import { replySubject, type OutboundEmail, type SendOutcome } from "../outbound/email.ts";
import type { MessageRow } from "../store/types.ts";
import { ChannelSendError, inlineAttachments, type A2AAgentMessage, type A2APort, type A2ATaskView, type AttachmentPort, type EmailPort, type IMessagePort, type PhoneCallRequest, type PhonePort, type SendFailureReason, type SmsPort, type VoiceContextPort } from "../workflow/ports.ts";

/** The slice of the Inkbox SDK the engine uses (`inkbox.messages`), so tests can fake it. */
export interface InkboxMailApi {
  send(mailbox: string, o: { to: string[]; subject: string; bodyText?: string; inReplyToMessageId?: string; attachments?: { filename: string; contentType: string; contentBase64: string }[]; idempotencyKey?: string }): Promise<{ id: string; messageId: string; status: string }>;
  get(mailbox: string, id: string): Promise<InkboxMessageDetail>;
  getAttachment(mailbox: string, id: string, filename: string): Promise<{ url: string }>;
  list(mailbox: string, o?: { pageSize?: number; direction?: "inbound" | "outbound"; startDatetime?: string }): AsyncIterable<InkboxListedMessage>;
}

/** A message as `inkbox.messages.list` yields it, newest first (the fields Haggle uses). */
export type InkboxListedMessage = { id?: string; messageId: string; direction: string; createdAt?: Date | string; fromAddress?: string; toAddresses?: string[]; ccAddresses?: string[] | null; status?: string; subject?: string | null; isRead?: boolean };

export interface InkboxMessageDetail {
  id: string;
  threadId: string | null;
  messageId: string;
  fromAddress: string;
  toAddresses: string[];
  /** Cc recipients (SDK MessageDetail.ccAddresses): a reply-all often puts the buyer here. */
  ccAddresses?: string[] | null;
  subject: string | null;
  bodyText: string | null;
  /** HTML part; used only when there is no plain-text part (inbound/htmlText.ts). */
  bodyHtml?: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  attachmentMetadata: Record<string, unknown>[] | null;
  /** inbound: received; outbound: queued | sent | delivered | bounced | failed. */
  status?: string;
  direction?: string;
  sesMessageId?: string | null;
  createdAt?: Date | string;
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

/** Inkbox refused the call before dialing (capacity or rate limit): safe to try again. */
const NOT_PLACED_CODES = new Set(["hosted_agent_at_capacity", "hosted_agent_unavailable", "call_capacity_busy", "concurrent_calls_limit"]);
function callNotPlaced(e: unknown): boolean {
  if (!(e instanceof InkboxAPIError)) return false;
  if (e.statusCode === 429) return true;
  // The body may carry the code directly or nested once more ({"detail": {"code": "…"}}).
  const d = e.detail && typeof e.detail === "object" && "detail" in e.detail ? (e.detail as { detail?: unknown }).detail : e.detail;
  const raw = d && typeof d === "object" ? ((d as { error?: unknown; code?: unknown }).error ?? (d as { code?: unknown }).code) : d;
  return typeof raw === "string" && [...NOT_PLACED_CODES].some((c) => raw.toLowerCase().includes(c));
}

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

/**
 * Is this inbound message (fetched from the buyer mailbox) addressed to the buyer: in To or Cc.
 * Reply-all from Outlook and Gmail often puts Haggle in Cc when the vendor's own colleague is in To.
 * Bcc (invisible to other recipients) is not accepted: a vendor's real reply never Bccs Haggle.
 */
export function addressedToBuyer(detail: Pick<InkboxMessageDetail, "toAddresses" | "ccAddresses">, buyerMailbox: string): boolean {
  const me = lower(buyerMailbox);
  return [...(detail.toAddresses ?? []), ...(detail.ccAddresses ?? [])].some((a) => lower(a) === me);
}

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
    // HTML-only mail (no text part): its text, with <blockquote> history as "> " lines.
    bodyText: detail.bodyText?.trim() ? detail.bodyText : detail.bodyHtml?.trim() ? htmlToText(detail.bodyHtml) || detail.bodyText : detail.bodyText,
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

/** An attachment download failure carrying the HTTP status, so a 5xx/429 is retried later (parsing/parseErrors.ts) and a 4xx isn't. */
const downloadError = (what: string, status: number) => Object.assign(new Error(`attachment ${what} failed (${status})`), { status });

/** The body, or null as soon as it exceeds `cap` bytes (Content-Length first, then while streaming): metadata sizes can be 0 or wrong. */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) { await res.body?.cancel().catch(() => {}); return null; }
  if (!res.body) { const b = Buffer.from(await res.arrayBuffer()); return b.byteLength > cap ? null : b; }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * AttachmentPort: fetch PDFs, images and JSON parts through Inkbox signed URLs, with size caps (enforced
 * while downloading, whatever the metadata says), a timeout, and a check that the bytes are what they
 * claim (a "PDF" that isn't one is skipped rather than failing the whole reply's read). A provider
 * outage (5xx, 429, network) throws a retryable error; a missing attachment (4xx) a permanent one.
 */
export function inkboxAttachments(api: InkboxMailApi, buyerMailbox: string, fetchImpl: typeof fetch = fetch): AttachmentPort {
  return {
    async load(m: MessageRow): Promise<ExtractedFile[]> {
      const files: ExtractedFile[] = await inlineAttachments.load(m);
      if (!m.provider_email_id) return files;
      let pdfBytes = 0;
      let imageBytes = 0;
      for (const a of m.attachments) {
        if (a.content_base64 || !a.filename) continue;
        const declared = attachmentKind({ tarPath: a.filename, contentType: a.content_type, filename: a.filename });
        if (!declared) continue;
        const budget = (k: string) => (k === "pdf" ? MAX_PDF_BYTES - pdfBytes : k === "image" ? MAX_IMAGE_BYTES - imageBytes : MAX_JSON_BYTES);
        const cap = budget(declared);
        if (a.size_bytes > cap) continue;
        let url: string;
        try {
          ({ url } = await api.getAttachment(buyerMailbox, m.provider_email_id, a.filename));
        } catch (e) {
          if (e instanceof InkboxAPIError) throw downloadError("link", e.statusCode);
          if (e instanceof InkboxConnectionError) throw new Error("attachment link: fetch failed (Inkbox unreachable)");
          throw e;
        }
        if (!isHttps(url)) throw new Error("attachment URL is not https");
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
        if (!res.ok) { await res.body?.cancel().catch(() => {}); throw downloadError("download", res.status); }
        const data = await readCapped(res, cap);
        if (!data) continue;
        const real = verifiedKind(declared, data);
        if (!real || data.byteLength > budget(real.kind)) continue;
        if (real.kind === "pdf") pdfBytes += data.byteLength;
        if (real.kind === "image") imageBytes += data.byteLength;
        files.push({ kind: real.kind, filename: a.filename, data, ...(real.kind === "image" ? { contentType: real.contentType ?? imageContentType(a.content_type, a.filename)! } : {}) });
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
  // An idempotency-key conflict: an earlier attempt under this key may have been accepted, so the
  // send is ambiguous (recorded unknown, reviewed, never re-sent), not a bad address.
  if (status === 409 || /idempotenc/.test(code)) return new ChannelSendError("provider_error", false, 0, msg, true);
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
  const transcript = (d.transcript?.entries ?? []).filter((e) => typeof e.text === "string").map((e) => `${e.party === "local" ? "haggle (AI assistant)" : e.party ?? "party"}: ${e.text}`).join("\n");
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
 * placeCall has no idempotency key, so only a refusal that proves nothing rang is retried (bounded,
 * with backoff): `503 hosted_agent_at_capacity` (and the other capacity codes) or a 429.
 */
export function inkboxPhone(identity: { placeCall(o: { toNumber: string; origination?: CallOrigin; mode?: CallMode; reason?: string }): Promise<{ id: string }> }, origin: CallOriginChoice = "dedicated_number", sleep?: (ms: number) => Promise<void>): PhonePort {
  return {
    async placeCall(req: PhoneCallRequest) {
      // placeCall takes no idempotency key, so a failure after Inkbox may have dialed (any 5xx, a lost
      // connection) is ambiguous: never retried here, never re-placed by the engine (no second ring).
      // Only an explicit "not placed" refusal (capacity, rate limit) is retried.
      for (let attempt = 0; ; attempt++) {
        try {
          const call = await identity.placeCall({
            toNumber: req.toNumber, origination: origin === "shared_imessage_number" ? CallOrigin.SHARED_IMESSAGE_NUMBER : CallOrigin.DEDICATED_NUMBER,
            mode: CallMode.HOSTED_AGENT, reason: req.reason.slice(0, 2000),
          });
          return { callId: call.id };
        } catch (e) {
          const notPlaced = callNotPlaced(e);
          if (notPlaced && attempt < 2) {
            await (sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(250 * 2 ** attempt);
            continue;
          }
          const mapped = mapInkboxError(e);
          const ambiguous = !notPlaced && (e instanceof InkboxConnectionError || (e instanceof InkboxAPIError && e.statusCode >= 500) || /^(send_outcome_ambiguous|idempotency_in_progress):/.test(mapped.message));
          if (!ambiguous) throw mapped;
          throw new ChannelSendError(mapped.reason, false, 0, `call outcome unknown: ${mapped.message}`, true);
        }
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

/** An inbound SMS to the buyer's number (Inkbox text.received). */
export function inkboxTextReceived(payload: { data: Record<string, unknown> }): { messageId: string; from: string; text: string; inbound: boolean; to?: string } | null {
  const m = (payload.data as { text_message?: { id?: string; direction?: string; local_phone_number?: string | null; remote_phone_number?: string | null; sender_phone_number?: string | null; text?: string | null } }).text_message;
  if (!m?.id) return null;
  // `to`: Haggle's own line the text arrived on, so the engine routes per line (text_routes).
  return { messageId: m.id, from: (m.remote_phone_number ?? m.sender_phone_number ?? "").replace(/[\s().-]/g, ""), text: m.text ?? "", inbound: m.direction === "inbound", ...(m.local_phone_number ? { to: m.local_phone_number } : {}) };
}

/** SMS from the buyer identity's own number. NOT wired unless HAGGLE_ENABLE_SMS=true (and the number is SMS-ready). */
export function inkboxSms(
  identity: {
    sendText(o: { to: string; text: string; idempotencyKey?: string }): Promise<{ id: string }>;
    listTexts?(o?: { limit?: number }): Promise<{ direction: string; remotePhoneNumber: string | null; deliveryStatus: string | null; createdAt: Date | string }[]>;
  },
  sleep?: (ms: number) => Promise<void>,
): SmsPort {
  return {
    async send(req) {
      const m = await withRetry(() => identity.sendText({ to: req.to, text: req.text, idempotencyKey: req.idempotencyKey }), sleep);
      return { messageId: m.id };
    },
    // Inkbox's spam filter refuses an 11th text to a number that hasn't replied: count the recent
    // outbound texts to it since its last inbound one (refused texts don't count).
    ...(identity.listTexts
      ? {
          async unanswered(to: string) {
            const norm = (n: string | null) => (n ?? "").replace(/[\s().-]/g, "");
            const mine = (await identity.listTexts!({ limit: 100 })).filter((t) => norm(t.remotePhoneNumber) === to).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            let n = 0;
            for (const t of mine) {
              if (t.direction === "inbound") break;
              if (!/blocked/i.test(String(t.deliveryStatus ?? ""))) n++;
            }
            return n;
          },
        }
      : {}),
  };
}

/**
 * The slice of Inkbox the operator's email trial (apps/mcp/scripts/email-trial.ts) uses: the buyer
 * mailbox's send/list/get, markUnread (get marks inbound mail read), and the webhook subscriptions
 * (read-only). Not used by the server.
 */
export async function connectInkboxTrial(opts: { apiKey: string; handle: string }) {
  const inkbox = new Inkbox({ apiKey: opts.apiKey });
  const identity = await inkbox.getIdentity(opts.handle);
  const buyerMailbox = identity.emailAddress?.toLowerCase();
  if (!buyerMailbox) throw new Error(`Inkbox identity "${identity.agentHandle}" has no mailbox`);
  return {
    buyerMailbox, identityId: (identity as { id?: string }).id ?? null,
    /** The handle Inkbox returned (the trial refuses to go on if it isn't the one it asked for). */
    handle: String(identity.agentHandle ?? ""),
    // "whitelist": only allowed senders' mail is delivered (real vendors and trial mailboxes must be on it).
    mailInboundFilterMode: String((identity as { mailInboundFilterMode?: unknown }).mailInboundFilterMode ?? "unknown"),
    send: (o: { to: string[]; subject: string; bodyText: string; idempotencyKey: string }) => inkbox.messages.send(buyerMailbox, o as never) as unknown as Promise<{ id: string; messageId: string; status: string; threadId?: string | null }>,
    list: (o: { direction: "inbound" | "outbound"; startDatetime: string; pageSize?: number }) => inkbox.messages.list(buyerMailbox, o as never) as unknown as AsyncIterable<InkboxListedMessage & { isRead?: boolean }>,
    get: (id: string) => inkbox.messages.get(buyerMailbox, id) as unknown as Promise<InkboxMessageDetail>,
    markUnread: (id: string) => inkbox.messages.markUnread(buyerMailbox, id).then(() => undefined),
    // The buyer's subscription is identity-owned and mixed (mail + call + iMessage + A2A events): a
    // plain list() leaves mixed rows out (SDK 0.7.x), so ask for the identity scope first.
    listSubscriptions: async () => {
      type Sub = { id: string; url: string; eventTypes: string[]; status?: string; agentIdentityId?: string | null; ownerIdentityId?: string | null };
      const id = (identity as { id?: string }).id;
      if (id) {
        try {
          return (await inkbox.webhooks.subscriptions.list({ agentIdentityId: id, scope: "identity" })) as unknown as Sub[];
        } catch { /* a server without identity scope: fall back to the legacy view */ }
      }
      return (await inkbox.webhooks.subscriptions.list()) as unknown as Sub[];
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
    // SMS needs the identity's own number with carrier provisioning finished (smsStatus "ready").
    sms: () => (identity.phoneNumber && String((identity.phoneNumber as { smsStatus?: string }).smsStatus ?? "ready") === "ready" ? inkboxSms(identity as never) : null),
    voice: () => inkboxVoiceContext(identity as never),
    identityInfo: { handle: identity.agentHandle, displayName: identity.displayName, phoneNumber: identity.phoneNumber?.number ?? null, imessageEnabled: identity.imessageEnabled },
    transcript: (callId: string) => fullCallTranscript(identity as never, callId),
    /** E.164 numbers with an active iMessage connection to this identity (they texted `connect @<handle>`). */
    connectedNumbers: async (): Promise<Set<string>> => {
      const rows = await withRetry(() => identity.listIMessageAssignments({ limit: 200 }));
      return new Set(rows.filter((a) => String(a.status) === "active" && !a.releasedAt).map((a) => a.remoteNumber));
    },
    connectCommand: `connect @${identity.agentHandle}`,
    // Inbound reconciliation (reconcile.ts): this org's identity addresses (what a mail webhook's
    // agent_identities says about the sender), and the buyer identity's own texts and calls.
    identityAddresses: async () => (await inkbox.listIdentities()).map((i) => i.emailAddress ?? "").filter(Boolean),
    listTexts: (o: { startDatetime?: string; limit?: number }) => withRetry(() => identity.listTexts(o)),
    listCalls: (o: { startDatetime?: string; limit?: number }) => withRetry(() => identity.listCalls(o)),
  };
}
