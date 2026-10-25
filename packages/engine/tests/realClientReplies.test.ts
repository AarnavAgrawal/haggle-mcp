// Production pass 3 (2026-10-22): replies as real mail clients write them, run through the real
// engine (in-memory store, fake ports, no network). The reply shapes below are SIMULATED from the
// clients' documented quoting styles (Gmail web and mobile, Outlook desktop/web and mobile, Apple
// Mail on iOS, Gmail forwards); they are not captured mail. What IS observed from the live Inkbox
// account (read-only, 2026-10-22) is encoded here too: Inkbox sends through Amazon SES and stores
// the SES-assigned Message-ID (`<…@email.amazonses.com>`), which is what replies reference; inbound
// `body_text` keeps the sender's quoted history; the Free plan appends a "Sent via Inkbox" footer;
// no message or webhook field carries SPF/DKIM/DMARC results.
// Replace these with captured mail from apps/mcp/scripts/email-trial.ts once a trial has run.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type ExtractorPort } from "../src/index.ts";
import { replyToken } from "../src/inbound/senderAuth.ts";
import { cleanEmailBody } from "../src/inbound/emailBody.ts";
import type { TrustVerdict } from "../src/inbound/types.ts";

const SECRET = "test-reply-token-secret-0123456789";
const VENDOR = "orders@realcaterer.example";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });
const INKBOX_FOOTER = "\n\n--\nSent via Inkbox";

/** Reads "$N total" / "$N deposit" from whatever text the engine hands it (so quoted figures would leak through). */
const textExtractor: ExtractorPort = {
  async extract(i) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*total/i);
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

function setup(config: Partial<EngineConfig> = {}) {
  const emails: { to: string; subject: string; bodyText: string; idempotencyKey: string; messageId: string }[] = [];
  const repo = new InMemoryRepository();
  let n = 0;
  const engine = new HaggleEngine({
    repo, now: () => new Date(), extractor: textExtractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    // As observed: the Message-ID Inkbox stores (and recipients see) is SES-assigned, mixed case.
    email: { async send(m) { const messageId = `<0100019A${(++n).toString(16).padStart(4, "0")}Fe3B-${m.idempotencyKey.replace(/\W/g, "").slice(0, 12)}-000000@email.amazonses.com>`; emails.push({ ...m, bodyText: m.bodyText + INKBOX_FOOTER, messageId }); return { providerId: `msg_${n}`, status: "sent", idempotentReplay: false, messageId }; } },
    sms: { async send() { return { messageId: "sms" }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: "+14155550101", externalSenders: "reply_token", replyTokenSecret: SECRET, ...config,
    },
  });
  return { engine, repo, emails };
}

type Env = ReturnType<typeof setup>;
type Sent = Env["emails"][number];

const quote = (text: string) => text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
const reSubject = (s: string, prefix = "Re: ") => `${prefix}${s}`;

/** How each client lays out a reply (plain-text part). */
const clients = {
  gmailWeb: (own: string, rfq: Sent) => ({ subject: reSubject(rfq.subject), bodyText: `${own}\n\nOn Thu, Oct 22, 2026 at 10:15 AM Haggle <haggle@inkboxmail.test> wrote:\n\n${quote(rfq.bodyText)}\n` }),
  // Gmail wraps a long attribution line in the plain-text part.
  gmailWrapped: (own: string, rfq: Sent) => ({ subject: reSubject(rfq.subject), bodyText: `${own}\n\nOn Thu, Oct 22, 2026 at 10:15 AM Haggle AI Buyer Assistant <\nhaggle@inkboxmail.test> wrote:\n\n${quote(rfq.bodyText)}\n` }),
  outlookDesktop: (own: string, rfq: Sent) => ({ subject: reSubject(rfq.subject, "RE: "), bodyText: `${own}\n\n________________________________\nFrom: Haggle <haggle@inkboxmail.test>\nSent: Thursday, October 22, 2026 10:15 AM\nTo: ${VENDOR}\nSubject: ${rfq.subject}\n\n${rfq.bodyText}\n` }),
  // Newer Outlook (web, "new Outlook") quotes with a header block and no separator line.
  outlookWebNoSeparator: (own: string, rfq: Sent) => ({ subject: reSubject(rfq.subject, "RE: "), bodyText: `${own}\n\nFrom: Haggle <haggle@inkboxmail.test>\nSent: Thursday, October 22, 2026 10:15 AM\nTo: ${VENDOR}\nSubject: ${rfq.subject}\n\n${rfq.bodyText}\n` }),
  outlookMobile: (own: string, rfq: Sent) => ({ subject: reSubject(rfq.subject, "RE: "), bodyText: `${own}\n\nGet Outlook for iOS<https://aka.ms/o0ukef>\n________________________________\nFrom: Haggle <haggle@inkboxmail.test>\nSent: Thursday, October 22, 2026 10:15:00 AM\nTo: ${VENDOR}\nSubject: ${rfq.subject}\n\n${rfq.bodyText}\n` }),
  appleMailIos: (own: string, rfq: Sent) => ({ subject: reSubject(rfq.subject), bodyText: `${own}\n\nSent from my iPhone\n\n> On Oct 22, 2026, at 10:15 AM, Haggle <haggle@inkboxmail.test> wrote:\n>\n${quote(rfq.bodyText)}\n` }),
  gmailMobileTrimmed: (own: string, rfq: Sent) => ({ subject: reSubject(rfq.subject), bodyText: own }), // the quoted history deleted by the sender
};

async function dealWith(env: Env, config: { budgetHint?: boolean } = {}) {
  const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email: VENDOR }], ...(config.budgetHint ? {} : {}) });
  const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
  return { jobId: deal.job_id, b, rfq: env.emails[0]! };
}

let seq = 0;
function reply(env: Env, rfq: Sent, body: { subject: string; bodyText: string }, over: Partial<Parameters<HaggleEngine["ingest"]>[0]> = {}) {
  const n = ++seq;
  return env.engine.ingest({
    providerEventId: `evt_${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `thr_${n}`, messageId: `<CA+${n}abc@mail.gmail.com>`,
    inReplyTo: [rfq.messageId], references: [rfq.messageId], from: VENDOR, to: ["haggle@inkboxmail.test"], ...body, attachments: [], attachmentsDownloadUrl: null, ...over,
  }, external);
}

const OWN = "Hi, yes we can do it: $1,150 total, delivered. $345 deposit.\n\nThanks,\nMaria";

describe("replies as real clients write them (simulated shapes): legitimate replies become quotes", () => {
  for (const [name, layout] of Object.entries(clients)) {
    it(`${name}: verified, and only the business's own words are read`, async () => {
      const env = setup();
      const { jobId, b, rfq } = await dealWith(env);
      expect(rfq.subject).toContain(replyToken(SECRET, jobId, b.business_id));
      expect((await reply(env, rfq, layout(OWN, rfq))).outcome).toBe("stored");
      await env.engine.advanceJob(jobId);
      const q = (await env.engine.getQuotes(jobId)).quotes;
      expect(q.map((x) => x.total_usd)).toEqual([1150]);
      const m = (await env.repo.listMessages(jobId)).find((x) => x.direction === "in")!;
      expect(m).toMatchObject({ sender_trusted: true, trust_reason: "external-reply-token" });
    });
  }

  it("an edited subject still verifies through the quoted body; a reply with neither (quote deleted, subject rewritten) is a false rejection by design", async () => {
    const env = setup();
    const { rfq } = await dealWith(env);
    expect((await reply(env, rfq, { ...clients.gmailWeb(OWN, rfq), subject: "Catering quote for you" })).outcome).toBe("stored");
    const env2 = setup();
    const d2 = await dealWith(env2);
    expect((await reply(env2, d2.rfq, { subject: "Catering quote for you", bodyText: OWN })).outcome).toBe("quarantined:identity_unverified");
  });

  it("a short reply keeps the token in the Re: subject even with no quoted history", async () => {
    const env = setup();
    const { jobId, rfq } = await dealWith(env);
    expect((await reply(env, rfq, { subject: reSubject(rfq.subject), bodyText: "$1,150 total. $345 deposit." })).outcome).toBe("stored");
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes.map((x) => x.total_usd)).toEqual([1150]);
  });

  it("Message-IDs compare case-insensitively and with or without angle brackets (SES ids are mixed case)", async () => {
    const env = setup();
    const { rfq } = await dealWith(env);
    const bare = rfq.messageId.replace(/[<>]/g, "").toLowerCase();
    expect((await reply(env, rfq, clients.gmailWeb(OWN, rfq), { inReplyTo: [bare], references: [] })).outcome).toBe("stored");
  });

  it("only References (no In-Reply-To), as some clients and ticketing systems send, still counts as our thread", async () => {
    const env = setup();
    const { rfq } = await dealWith(env);
    expect((await reply(env, rfq, clients.outlookDesktop(OWN, rfq), { inReplyTo: [], references: ["<other@x.example>", rfq.messageId] })).outcome).toBe("stored");
  });

  it("a PDF quote with a one-line body is verified and stored for attachment parsing", async () => {
    const env = setup();
    const { jobId, rfq } = await dealWith(env);
    const r = await reply(env, rfq, clients.gmailWeb("Please see the attached quote.", rfq), { attachments: [{ filename: "quote.pdf", contentType: "application/pdf", sizeBytes: 20_000, partIndex: 0, tarPath: "quote.pdf" }] });
    expect(r.outcome).toBe("stored");
    const m = (await env.repo.listMessages(jobId)).find((x) => x.direction === "in")!;
    expect(m.attachments.map((a) => a.filename)).toEqual(["quote.pdf"]);
    expect(m.parse_status).toBe("pending");
  });

  it("the same reply delivered twice (webhook + sweep) is stored once; the business sending it twice yields one current quote", async () => {
    const env = setup();
    const { jobId, rfq } = await dealWith(env);
    const body = clients.gmailWeb(OWN, rfq);
    const first = await reply(env, rfq, body, { providerEmailId: "in_dup" });
    expect(first.outcome).toBe("stored");
    expect((await reply(env, rfq, body, { providerEmailId: "in_dup" })).outcome).toBe("duplicate");
    await env.engine.advanceJob(jobId);
    expect((await reply(env, rfq, body)).outcome).toBe("stored"); // a second, separate send of the same reply
    await env.engine.advanceJob(jobId);
    const quotes = (await env.engine.getQuotes(jobId)).quotes;
    expect(quotes.map((x) => x.total_usd)).toEqual([1150]);
  });
});

describe("suspicious replies stay quarantined, whatever the client", () => {
  it("a forward: someone else replying from another address, even with the token and thread, is quarantined", async () => {
    const env = setup();
    const { jobId, rfq } = await dealWith(env);
    const fwd = { subject: `Fwd: ${rfq.subject}`, bodyText: `$1 total.\n\n---------- Forwarded message ---------\nFrom: Haggle <haggle@inkboxmail.test>\nDate: Thu, Oct 22, 2026 at 10:15 AM\nSubject: ${rfq.subject}\nTo: <${VENDOR}>\n\n${rfq.bodyText}` };
    expect((await reply(env, rfq, fwd, { from: "colleague@gmail.example" })).outcome).toMatch(/^quarantined/);
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes).toHaveLength(0);
  });

  it("a fresh email from the pinned address carrying the token but no reference to our message is quarantined (not_in_our_thread)", async () => {
    const env = setup();
    const { rfq } = await dealWith(env);
    expect((await reply(env, rfq, { subject: rfq.subject, bodyText: OWN }, { inReplyTo: [], references: [], threadId: null })).outcome).toBe("quarantined:identity_unverified");
  });

  it("a forged reply naming a Message-ID that isn't ours, with a token for another business, is quarantined", async () => {
    const env = setup();
    const { jobId, rfq } = await dealWith(env);
    const other = replyToken(SECRET, jobId, "biz_other");
    expect((await reply(env, rfq, { subject: `Re: [HG-X] (ref ${other})`, bodyText: OWN }, { inReplyTo: [rfq.messageId] })).outcome).toBe("quarantined:identity_unverified");
  });
});

describe("only the business's own words are read: quoted RFQ text never becomes its quote", () => {
  // The RFQ can reveal a budget (policy-dependent). Quoted back without '>' markers, as Outlook does,
  // that figure must not be read as the business's price.
  const own = "Yes, we can do this. Let me check the menu and get back to you.";
  const rfqWithBudget = "Hi Real Caterer,\n\n- What: lunch\n- Budget: up to $2000.00 total\n\nThank you!\nAI assistant for a customer\n\nReference: HGR-AAAAAAAAAA (please keep it when you reply)\n\n--\nSent via Inkbox";
  const fake = { subject: "[HG-ABCD] Quote request: lunch (ref HGR-AAAAAAAAAA)", bodyText: rfqWithBudget, messageId: "<x@email.amazonses.com>", to: VENDOR, idempotencyKey: "k" };
  for (const [name, layout] of Object.entries(clients)) {
    it(`${name}`, () => {
      const cleaned = cleanEmailBody(layout(own, fake).bodyText);
      expect(cleaned).toContain("Let me check the menu");
      expect(cleaned).not.toMatch(/\$2000/);
      expect(cleaned).not.toMatch(/HGR-|AI assistant for/);
    });
  }
});
