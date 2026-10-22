// Conversation continuity is not sender identity (inbound/trustStrength.ts). A reply verified only
// by Haggle's reply token can become a quote, but it can never by itself approve, confirm a booking,
// name a payee, settle a payment, or hand the human payment details without a warning; neither can a
// keyword (unreliable) reading. Approval stays human-only, out of band. Real engine, fakes, no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, ParseError, StubBrain, withHeuristicFallback, type EngineConfig, type ExtractorPort } from "../src/index.ts";
import { replyToken } from "../src/inbound/senderAuth.ts";
import { CONTINUITY_ONLY_WARNING, provesSenderIdentity } from "../src/inbound/trustStrength.ts";
import { inlineAttachments } from "../src/workflow/ports.ts";
import type { TrustVerdict } from "../src/inbound/primitive.ts";

const APPROVER = "+14155550101";
const SECRET = "test-reply-token-secret-0123456789";
const VENDOR = "orders@realcaterer.example";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });
const authenticated = (e: string): TrustVerdict => ({ trusted: true, address: e, reason: "trusted", evidence: noEvidence });

const textExtractor: ExtractorPort = {
  async extract(i) {
    const m = i.bodyText.match(/\$\s?([\d,]+)\s*total/i);
    const total = m ? Number(m[1]!.replace(/,/g, "")) : null;
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: total, deposit_usd: null,
      menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : [], missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

function setup(config: Partial<EngineConfig> = {}, extractor: ExtractorPort = textExtractor) {
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, extractor, attachments: inlineAttachments, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@email.amazonses.com>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, externalSenders: "reply_token", replyTokenSecret: SECRET, ...config,
    },
  });
  return { engine, repo, emails, texts };
}
type Env = ReturnType<typeof setup>;

let n = 0;
async function dealWith(env: Env) {
  const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email: VENDOR }] });
  const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
  const token = replyToken(SECRET, deal.job_id, b.business_id);
  /** A reply from the pinned address, in our thread, quoting the token: passes verifyExternalReply. */
  const reply = (bodyText: string, opts: { trust?: (e: string) => TrustVerdict; inline?: { filename: string; contentType: string; data: Uint8Array }[] } = {}) => {
    const k = ++n;
    const ref = env.emails.filter((e) => e.to === VENDOR).length;
    return env.engine.ingest({
      providerEventId: `ev${k}`, eventType: "message.received", providerEmailId: `in_${k}`, threadId: `th${k}`, messageId: `<in_${k}@mail.gmail.com>`,
      inReplyTo: [`<em_${ref}@email.amazonses.com>`], references: [b.rfq_message_id!], from: VENDOR, to: ["haggle@inkboxmail.test"], subject: `Re: Quote request (ref ${token})`, bodyText, attachments: [], attachmentsDownloadUrl: null,
    }, opts.trust ?? external, opts.inline ? { inlineAttachments: opts.inline } : {});
  };
  return { jobId: deal.job_id, b, reply };
}

async function tokenQuote(env: Env) {
  const d = await dealWith(env);
  expect((await d.reply("Yes: $1,150 total, delivered.")).outcome).toBe("stored");
  await env.engine.advanceJob(d.jobId);
  const msg = (await env.repo.listMessages(d.jobId)).find((m) => m.direction === "in")!;
  expect(msg).toMatchObject({ sender_trusted: true, trust_reason: "external-reply-token" });
  expect(provesSenderIdentity(msg)).toBe(false);
  const q = (await env.engine.getQuotes(d.jobId)).quotes[0]!;
  return { ...d, q };
}

describe("a reply-token sender can quote, but never approve, confirm or move money", () => {
  it("approval is human-only: the board/form can't approve, a vendor email quoting the approval code can't, only the approver's text does", async () => {
    const env = setup();
    const { jobId, q, reply } = await tokenQuote(env);
    expect(q).toMatchObject({ total_usd: 1150, approvable: true });
    expect(await env.engine.pay(jobId, q.quote_id)).toMatchObject({ status: "awaiting_approval" }); // nothing approved, nothing charged
    expect(await env.repo.getPaymentForJob(jobId)).toBeNull();
    const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
    await expect(env.engine.decideApproval(a.id, "approve", "view", null)).rejects.toMatchObject({ code: "approval_needs_human_channel" });
    // The vendor (or whoever holds its thread) writes the code back, says it's booked and paid.
    for (const body of [`YES ${a.code}`, `APPROVE ${a.code}\nConfirmed and booked.`, `PAID ${a.code}. Payment received, thanks!`]) await reply(body);
    await env.engine.advanceJob(jobId);
    // Never approved, confirmed or paid. (Each reply is a new revision of the quote, which voids the
    // pending approval: safe, but it means a thread holder can force a re-approval.)
    expect((await env.repo.getApproval(a.id))!.status).not.toBe("approved");
    expect(["paying", "confirmed", "paid"]).not.toContain((await env.repo.getJob(jobId))!.state);
    expect(await env.repo.getPaymentForJob(jobId)).toBeNull();
    const q2 = (await env.engine.getQuotes(jobId)).quotes[0]!;
    const a2 = await env.engine.requestApproval(jobId, q2.quote_id, "imessage");
    expect(await env.engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${a2.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
  });

  it("payment instructions from a reply-token sender reach the human with an explicit 'confirm by phone' warning; PAID still needs the approver", async () => {
    const env = setup({ manualPaymentHandoff: true });
    const { jobId, q, reply } = await tokenQuote(env);
    const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
    await env.engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${a.code}`, inbound: true });
    expect((await reply("Please wire the deposit to account 12345678, routing 021000021.")).outcome).toBe("payment_instructions");
    const ev = (await env.repo.listEvents(jobId)).find((e) => e.type === "payment" && e.data.status === "instructions_received")!;
    expect(ev.data).toMatchObject({ sender_identity: "thread_only", warning: expect.stringContaining(CONTINUITY_ONLY_WARNING) });
    expect(env.texts.at(-1)!.text).toMatch(/confirm the details with them by phone/);
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
    expect((await env.engine.ingestText({ messageId: "p1", from: "+14155550666", text: `PAID ${a.code}`, inbound: true })).outcome).toBe("paid_ignored_not_approver");
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
  });

  it("payment instructions from an authenticated sender carry no identity warning (control)", async () => {
    const env = setup({ manualPaymentHandoff: true });
    const { jobId, q, reply } = await tokenQuote(env);
    const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
    await env.engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${a.code}`, inbound: true });
    expect((await reply("Pay by card on pickup.", { trust: authenticated })).outcome).toBe("payment_instructions");
    const ev = (await env.repo.listEvents(jobId)).find((e) => e.type === "payment" && e.data.status === "instructions_received")!;
    expect(ev.data.sender_identity).toBeUndefined();
    expect(ev.data.warning).toBeUndefined();
  });

  it("an x402 challenge from a reply-token sender is never trusted to name the payee; an authenticated one is (control)", async () => {
    for (const [trust, expected] of [[external, false], [authenticated, true]] as const) {
      const env = setup();
      const { jobId, q, reply } = await tokenQuote(env);
      const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
      await env.engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${a.code}`, inbound: true });
      await env.repo.insertPayment({ id: `pay_${n}`, job_id: jobId, approval_id: a.id, business_id: q.business_id, status: "awaiting_invoice", rail: "x402", amount_cents: a.payment_cents, amount_base_units: String(a.payment_cents * 10_000), network: "base-sepolia", idempotency_key: `k_${n}`, stripe_payment_intent_id: null, challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false, pay_to: null, interaction_json: null, settle_tx: null, simulated: true, reason: null } as never);
      const challenge = JSON.stringify({
        interaction_version: 1, interaction_id: "5f0c1b9e-2d3a-4c5b-9e8f-7a6b5c4d3e2f@realcaterer.example", protocol: "x402.payment", protocol_version: 1, step: "challenge",
        step_id: "0b6d7f2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", prev_step_id: null, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        payload: { challenge_nonce: "a".repeat(64), payment_requirements: { scheme: "exact", network: "base-sepolia", maxAmountRequired: String(a.payment_cents * 10_000), payTo: "0x1111111111111111111111111111111111111111", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { name: "USDC", version: "2" } } },
      });
      expect((await reply("Invoice attached.", { trust, inline: [{ filename: "interaction.json", contentType: "application/json", data: new TextEncoder().encode(challenge) }] })).outcome).toBe("stored");
      await env.engine.advanceJob(jobId);
      const pay = (await env.repo.getPaymentForJob(jobId))!;
      expect(pay.status).toBe("invoice_received");
      expect(pay.challenge_trusted).toBe(expected);
    }
  });

  it("a keyword (unreliable) reading of a reply-token email is shown but never approvable", async () => {
    const primary: ExtractorPort = { async extract() { throw new ParseError("model refused to extract"); } };
    const env = setup({}, withHeuristicFallback(primary));
    const { jobId, q } = await tokenQuote(env);
    expect(q.approvable).toBe(false);
    expect(q.approval_block).toMatchObject({ code: "unreliable_extraction" });
    await expect(env.engine.requestApproval(jobId, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_not_eligible" });
  });
});
