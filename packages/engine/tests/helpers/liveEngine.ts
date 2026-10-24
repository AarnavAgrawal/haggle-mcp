// A live-mode engine for inbound/vendor-contact tests: real engine, fake email/SMS ports, a test
// clock, reply tokens on (HAGGLE_EXTERNAL_SENDERS=reply_token), any repository. No network.
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type ExtractorPort, type Repository } from "../../src/index.ts";
import { replyToken } from "../../src/inbound/senderAuth.ts";
import type { InboundMessage, TrustVerdict } from "../../src/inbound/primitive.ts";
// Provider message ids are unique per process: suites share one Postgres database in parallel.
const RUN = Math.random().toString(36).slice(2, 10);

export const APPROVER = "+14155550101";
export const TOKEN_SECRET = "test-reply-token-secret-0123456789";
export const BUYER = "haggle@inkboxmail.test";
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
/** What Inkbox says about any mail from outside Inkbox: it can't authenticate it. */
export const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });

/** Reads "$1,150 total" / "$345 deposit" from the business's own words. */
export const textExtractor: ExtractorPort = {
  async extract(i) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[ -]in)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

export type SentEmail = { to: string; subject: string; bodyText: string; idempotencyKey: string; thread?: { inReplyTo: string } };

export function liveEngine(o: { config?: Partial<EngineConfig>; repo?: Repository; start?: Date; extractor?: ExtractorPort } = {}) {
  let t = (o.start ?? new Date()).getTime();
  const clock = { now: () => new Date(t), set: (d: Date) => { t = d.getTime(); }, advance: (ms: number) => { t += ms; } };
  const emails: SentEmail[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = o.repo ?? new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: o.extractor ?? textExtractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m as SentEmail); return { providerId: `em_${m.idempotencyKey}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}_${m.idempotencyKey.replace(/\W/g, "")}@email.amazonses.com>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}_${RUN}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, externalSenders: "reply_token", replyTokenSecret: TOKEN_SECRET, ...o.config,
    },
  });
  return { engine, repo, clock, emails, texts };
}
export type LiveEnv = ReturnType<typeof liveEngine>;

const { budget_usd, ...request } = GOLDEN_REQUEST;
export { request as GOLDEN_REQUEST_NO_BUDGET, budget_usd as GOLDEN_BUDGET };

export async function dealWith(env: LiveEnv, vendors: { name: string; email: string }[]) {
  const deal = await env.engine.deal({ request, budget_usd, businesses: vendors });
  const businesses = await env.repo.getBusinesses(deal.job_id);
  const token = (businessId: string) => replyToken(TOKEN_SECRET, deal.job_id, businessId);
  return { jobId: deal.job_id, businesses, token };
}

let n = 0;
/** An inbound email; by default a well-formed reply in the business's RFQ thread quoting its token. */
export function vendorReply(env: LiveEnv, b: { email: string | null; rfq_message_id: string | null }, token: string, over: Partial<InboundMessage> = {}, trust: (e: string) => TrustVerdict = external) {
  const k = `${Date.now().toString(36)}_${++n}`;
  return env.engine.ingest({
    providerEventId: `ev_${k}`, eventType: "message.received", providerEmailId: `in_${k}`, threadId: `th_${k}`, messageId: `<in_${k}@mail.gmail.com>`,
    inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: b.email!, to: [BUYER], subject: `Re: Quote request (ref ${token})`,
    bodyText: "We can do it: $1,150 total, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null, ...over,
  }, trust);
}
