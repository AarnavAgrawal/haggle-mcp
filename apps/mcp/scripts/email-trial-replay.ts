// Replays captured or fixture vendor email through the REAL inbound pipeline, offline: a signed
// Inkbox `message.received` webhook into apps/mcp/src/webhook.ts handleInkboxWebhook, the engine's
// matching, sender verification (reply token), opt-out/bounce checks, and the next advance's parse,
// against an in-memory engine and an in-memory Inkbox mailbox. Nothing here touches the network:
// no Inkbox, no Claude (the default reader is the engine's keyword heuristic), no database.
//
// Used by:
//   * email-trial.ts dry-run: replays a trial run's raw captures (<run>/raw/*.json) under the run's
//     own job/business ids and secret, so the token in the real replies verifies as it would live;
//   * the fixture tests (apps/mcp/tests/emailFixtures.test.ts, packages/engine/tests/fixtures-email):
//     placeholders ({{TOKEN}}, {{RFQ_MESSAGE_ID}}, …) are filled from a fresh deal.
import { createHmac } from "node:crypto";
import {
  disabledPayer, GOLDEN_REQUEST, HaggleEngine, heuristicExtractor, inkboxAttachments, inkboxEmail, InMemoryRepository, replyToken, StubBrain,
  type ExtractorPort, type InkboxListedMessage, type InkboxMailApi, type InkboxMessageDetail, type JobBusinessRow,
} from "@haggle/engine";
import { handleInkboxWebhook } from "../src/webhook.ts";
import type { Runtime } from "../src/runtime.ts";

const REPLAY_SECRET = "whsec_cmVwbGF5LW9ubHk"; // signs replayed events locally (not a real key) gitleaks:allow

/** Sign a webhook body the way Inkbox does (X-Inkbox-Signature over "<request id>.<timestamp>.<body>"). */
export function signReplay(body: string, secret = REPLAY_SECRET, ts = String(Math.floor(Date.now() / 1000))): Headers {
  const key = secret.replace(/^whsec_/, "");
  const sig = createHmac("sha256", key).update(`req_replay.${ts}.${body}`).digest("hex");
  return new Headers({ "x-inkbox-signature": `sha256=${sig}`, "x-inkbox-request-id": "req_replay", "x-inkbox-timestamp": ts });
}

type Stored = InkboxMessageDetail & { mailbox: string; direction: string };

/** An in-memory buyer mailbox (InkboxMailApi): outbound mail gets SES-style Message-IDs, like Inkbox. */
export class ReplayMailbox implements InkboxMailApi {
  messages = new Map<string, Stored>();
  sent: { to: string[]; subject: string; bodyText?: string; inReplyToMessageId?: string }[] = [];
  files = new Map<string, Uint8Array>();
  private n = 0;
  async send(mailbox: string, o: Parameters<InkboxMailApi["send"]>[1]) {
    const prior = [...this.messages.values()].find((m) => m.direction === "outbound" && (m as { key?: string }).key === o.idempotencyKey);
    if (prior) return { id: prior.id, messageId: prior.messageId, status: "sent" };
    const id = `out_${++this.n}`;
    const messageId = `<0100019a${String(this.n).padStart(8, "0")}-replay@email.amazonses.com>`;
    this.sent.push(o);
    this.messages.set(id, { id, mailbox, direction: "outbound", threadId: `thr_${o.to[0]}`, messageId, fromAddress: mailbox, toAddresses: o.to, subject: o.subject, bodyText: o.bodyText ?? null, inReplyTo: o.inReplyToMessageId ?? null, references: null, attachmentMetadata: null, status: "sent", key: o.idempotencyKey } as Stored);
    return { id, messageId, status: "sent" };
  }
  put(mailbox: string, d: InkboxMessageDetail) {
    this.messages.set(d.id, { ...d, mailbox, direction: d.direction ?? "inbound" });
  }
  async get(_mailbox: string, id: string) {
    const m = this.messages.get(id);
    if (!m) throw Object.assign(new Error("not found"), { statusCode: 404 });
    return m;
  }
  async getAttachment(_mailbox: string, id: string, filename: string) {
    return { url: `https://attachments.replay.invalid/${encodeURIComponent(id)}/${encodeURIComponent(filename)}` };
  }
  async *list(mailbox: string, o?: { direction?: "inbound" | "outbound" }): AsyncIterable<InkboxListedMessage> {
    for (const m of [...this.messages.values()].reverse()) if (m.mailbox === mailbox && (!o?.direction || m.direction === o.direction)) yield m as InkboxListedMessage;
  }
  /** fetch() for attachment URLs: the bytes registered with `files` (404 otherwise). */
  fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    const [, id, name] = u.pathname.split("/").map(decodeURIComponent);
    const bytes = this.files.get(`${id}/${name}`);
    return bytes ? new Response(bytes as BodyInit, { status: 200, headers: { "content-length": String(bytes.byteLength) } }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

export interface ReplayVendor { name: string; email: string }
export interface ReplayDeal {
  jobId: string;
  business: JobBusinessRow;
  token: string;
  rfqMessageId: string;
}

export interface ReplayResult {
  id: string;
  webhook_status: number;
  outcome: string;
  stored_as: string | null;
  trust_reason: string | null;
  quarantine_reason: string | null;
  sender_trusted: boolean | null;
  quote_total_usd: number | null;
  approvable: boolean | null;
  /** The keyword reader's (or the given extractor's) deposit and flags for this message's quote. */
  quote_deposit_usd?: number | null;
  quote_flags?: string[];
  /** Why the board would not offer Approve (null when approvable or no quote). */
  approval_block?: string | null;
}

/**
 * An offline pipeline: engine (live mode, reply tokens on, in memory) + mailbox + webhook route.
 * `vendors` get a deal each in `deals` (deal 0 has all of them; deal 1 has the first vendor again,
 * for cross-deal token tests).
 */
export async function replayPipeline(o: { buyer: string; vendors: ReplayVendor[]; secret?: string; extractor?: ExtractorPort; now?: () => Date }) {
  const secret = o.secret ?? "replay-reply-token-secret-0123456789";
  const mailbox = new ReplayMailbox();
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(mailbox, o.buyer), brain: new StubBrain(), payer: disabledPayer("replay"), extractor: o.extractor ?? heuristicExtractor,
    attachments: inkboxAttachments(mailbox, o.buyer, mailbox.fetch), ...(o.now ? { now: o.now } : {}),
    config: {
      mode: "live", inboxDomain: o.buyer.split("@")[1]!, sharedInbox: o.buyer, collectionWindowMs: 7 * 86_400_000, negotiationWindowMs: 3_600_000, approvalTtlMs: 1_800_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, externalSenders: "reply_token", replyTokenSecret: secret, outOfBandApprovalsOnly: true,
    },
  });
  const rt = { mode: "live", engine, missing: [], inkbox: { api: mailbox, buyerMailbox: o.buyer.toLowerCase(), webhookSecret: REPLAY_SECRET, senderTrust: { policy: "outbound-verified" } } } as unknown as Runtime;
  const { budget_usd, ...request } = GOLDEN_REQUEST;
  const open = async (vendors: ReplayVendor[]): Promise<ReplayDeal[]> => {
    const d = await engine.deal({ request, budget_usd, businesses: vendors });
    const rows = await repo.getBusinesses(d.job_id);
    return rows.map((business) => ({ jobId: d.job_id, business, token: replyToken(secret, d.job_id, business.business_id), rfqMessageId: business.rfq_message_id! }));
  };
  const deals = [await open(o.vendors), ...(o.vendors.length ? [await open([o.vendors[0]!])] : [])];

  let k = 0;
  /** Deliver one inbound message as Inkbox would (signed webhook), then advance its job and report what became of it. */
  async function deliver(detail: InkboxMessageDetail, opts: { eventId?: string; agentIdentities?: { bucket: string; address: string }[]; files?: Record<string, Uint8Array> } = {}): Promise<ReplayResult> {
    mailbox.put(o.buyer.toLowerCase(), detail);
    for (const [name, bytes] of Object.entries(opts.files ?? {})) mailbox.files.set(`${detail.id}/${name}`, bytes);
    const payload = {
      id: opts.eventId ?? `evt_replay_${++k}`, event_type: "message.received", timestamp: new Date().toISOString(),
      data: {
        message: { id: detail.id, mailbox_id: "mbx_replay", thread_id: detail.threadId, message_id: detail.messageId, from_address: detail.fromAddress, to_addresses: detail.toAddresses, cc_addresses: detail.ccAddresses ?? null, bcc_addresses: null, subject: detail.subject, snippet: (detail.bodyText ?? "").slice(0, 200), direction: "inbound", status: "received", has_attachments: !!detail.attachmentMetadata?.length, created_at: new Date().toISOString(), email_address: o.buyer },
        contacts: [], agent_identities: opts.agentIdentities ?? [],
      },
    };
    const raw = JSON.stringify(payload);
    const r = await handleInkboxWebhook(rt, raw, signReplay(raw));
    const row = await repo.findMessageByProviderId(detail.id);
    if (row?.job_id) await engine.advanceJob(row.job_id);
    const after = row ? await repo.getMessage(row.id) : null;
    // The quote read from this very message (not an earlier one from the same business).
    const own = after?.job_id ? (await repo.listQuotes(after.job_id)).find((q) => q.message_id === after.id) : undefined;
    const board = own && after?.job_id ? (await engine.getQuotes(after.job_id)).quotes.find((q) => q.quote_id === own.id) : undefined;
    return {
      id: detail.id, webhook_status: r.status, outcome: r.outcome ?? String(r.body.error ?? ""), stored_as: after?.kind ?? null, trust_reason: after?.trust_reason ?? null,
      quarantine_reason: after?.quarantine_reason ?? null, sender_trusted: after?.sender_trusted ?? null,
      quote_total_usd: own ? (own.total_cents === null ? null : own.total_cents / 100) : null, approvable: board ? board.approvable : null,
      quote_deposit_usd: own ? (own.deposit_cents === null ? null : own.deposit_cents / 100) : null, quote_flags: own ? [...(own.record.flags ?? [])] : [],
      approval_block: board?.approval_block?.reason ?? null,
    };
  }
  /**
   * A trial run's own conversation, so its real replies verify as they would live: a copy of deal 0's
   * job and first business under the run's job/business ids, its RFQ under the send-time Message-ID
   * (and, when they differ, the stored and SES ids the mailbox reported). The pipeline's secret must
   * be the run's secret.
   */
  async function seedTrial(run: { jobId: string; businessId: string; to: string; send: { id: string; messageId: string; threadId?: string | null } }, otherIds: string[] = []): Promise<ReplayDeal> {
    const base = deals[0]![0]!;
    const job = (await repo.getJob(base.jobId))!;
    await repo.insertJob({ ...job, id: run.jobId, short_code: "TRIAL" }); // email-trial-lib TRIAL_CODE (the test email carries no subject tag, like a real RFQ)
    const business = { ...base.business, job_id: run.jobId, business_id: run.businessId, email: run.to.toLowerCase(), thread_id: run.send.threadId ?? null, rfq_message_id: run.send.messageId, references: [run.send.messageId] };
    await repo.insertBusinesses([business]);
    for (const [i, id] of [run.send.messageId, ...otherIds].entries()) {
      await repo.insertMessage({
        job_id: run.jobId, business_id: run.businessId, approval_id: null, direction: "out", kind: i === 0 ? "rfq" : "followup", provider_email_id: i === 0 ? run.send.id : `${run.send.id}:alias${i}`, idempotency_key: `trial:${run.jobId}:${i}`,
        rfc_message_id: id, thread_id: run.send.threadId ?? null, from_address: o.buyer, to_address: run.to, subject: null, body_text: null, attachments: [], attachments_download_url: null,
        sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: 1, simulated: false,
      });
    }
    return { jobId: run.jobId, business, token: replyToken(secret, run.jobId, run.businessId), rfqMessageId: run.send.messageId };
  }

  return { engine, repo, mailbox, rt, deals, deliver, seedTrial, secret };
}

export type CaptureReplay = ReplayResult & { from: string; notes: string[] };

/**
 * A trial run's captured replies (raw messages.get details) through the pipeline under the run's own
 * conversation: what the live server would have done with each, offline. Only the send-time
 * Message-ID is known to the engine, as live. Attachment bytes aren't captured, so attachments are
 * left out of the replay (noted per message).
 */
export async function replayCaptures(run: { buyerMailbox: string; to: string; secret: string; jobId: string; businessId: string; send?: { id: string; messageId: string; threadId?: string | null } }, captures: InkboxMessageDetail[]): Promise<CaptureReplay[]> {
  if (!run.send) throw new Error("this run has no recorded send");
  const p = await replayPipeline({ buyer: run.buyerMailbox, vendors: [{ name: "Trial mailbox", email: run.to }], secret: run.secret });
  await p.seedTrial({ jobId: run.jobId, businessId: run.businessId, to: run.to, send: run.send });
  const out: CaptureReplay[] = [];
  for (const c of captures) {
    const notes: string[] = [];
    const detail: InkboxMessageDetail = { ...c, attachmentMetadata: null };
    if (c.attachmentMetadata?.length) notes.push(`${c.attachmentMetadata.length} attachment(s) not replayed offline`);
    const r = await p.deliver(detail);
    out.push({ ...r, from: (c.fromAddress ?? "").toLowerCase(), notes });
  }
  return out;
}

/** Fill a fixture's placeholders from the replay deals (deep, strings only). */
export function fillPlaceholders<T>(v: T, map: Record<string, string>): T {
  if (typeof v === "string") return v.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => map[k] ?? m) as T;
  if (Array.isArray(v)) return v.map((x) => fillPlaceholders(x, map)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillPlaceholders(x, map)])) as T;
  return v;
}
