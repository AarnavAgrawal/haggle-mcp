// SIMULATED end-to-end purchase (workstream D): no vendor, approver, provider or payment rail is real.
// The real engine runs in live mode over the in-memory store with fake ports: email (records what
// would be sent), SMS to the approver, a fake attachment port serving one PDF quote, and a
// deterministic rule-based extractor standing in for Claude. Vendor replies are written the way real
// clients format them (Gmail "On … wrote:" quoting, Outlook header blocks, an iPhone signature), and
// arrive as outside mail that proves itself only with Haggle's reply token (HAGGLE_EXTERNAL_SENDERS
// =reply_token). Money never moves: HAGGLE_PAYMENTS=manual, and the deal ends with the customer's
// reported payment and the business's own confirmation of receipt.
//
// Story: 60-person offsite lunch, at least 12 vegetarian, delivered by 11:30, $2,500 budget.
//   Harbor Table  (Gmail)   $2,180, 14 veg, delivered by 11:00, $500 deposit, valid until 2026-10-29: compliant
//   Golden Grill  (iPhone)  $1,650 but only 6 vegetarian: cheaper, noncompliant, must never win
//   Sunset Kitchen(Outlook) asks a question first; then a PDF quote, $2,050, vegetarian count not stated: unconfirmed
// Haggle recommends Harbor; the human lets the suggestion lapse; 8 days later the agent approves Harbor:
// the quote is past its valid-until date, so Harbor is asked to re-confirm first; it does, the human
// approves by text, Harbor confirms the booking and sends payment instructions (with a link), the
// human pays directly and texts PAID, and Harbor confirms receipt.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain, type ExtractorPort } from "../src/index.ts";
import { replyToken } from "../src/inbound/senderAuth.ts";
import { vendorOwnWords } from "../src/approvals/bookingReply.ts";
import type { InboundAttachmentMeta, TrustVerdict } from "../src/inbound/primitive.ts";
import type { MessageRow } from "../src/store/types.ts";

const APPROVER = "+14155550101";
const SECRET = "e2e-reply-token-secret-0123456789abcdef";
const T0 = Date.parse("2026-10-22T16:00:00Z");
const VENDORS = { harbor: "events@harbortable.example", grill: "goldengrill.sf@gmail.example", sunset: "catering@sunsetkitchen.example" } as const;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
/** Inkbox can't authenticate outside mail: every vendor here proves itself only with the reply token. */
const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });

/** The (fake) PDF Sunset attaches: plain text standing in for the parsed PDF pages. */
const SUNSET_PDF = Buffer.from([
  "SUNSET KITCHEN CATERING - QUOTE #SK-1114 (SIMULATED)",
  "Page 1: Mediterranean buffet for 60 guests, vegetarian options available. Delivered by 11:00. Delivery and sales tax included.",
  "Total $2,050.00",
  "Page 2: Terms. Deposit 25% ($512.50) due at booking. Valid until 2026-11-30.",
].join("\n"));

/**
 * A deterministic stand-in for Claude's extraction: reads totals, deposits, vegetarian counts,
 * delivery time, valid-until and questions from the vendor's own words (and the PDF text).
 */
const extractor: ExtractorPort = {
  async extract(i) {
    const pdf = i.pdfs.map((p) => p.data.toString("utf8")).join("\n");
    const t = `${vendorOwnWords(i.bodyText)}\n${pdf}`;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/total[^$\d]{0,20}\$\s?([\d,]+(?:\.\d{2})?)/i) ?? money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:all[- ]in\s*)?total/i);
    const deposit = money(/\(\$\s?([\d,]+(?:\.\d{2})?)\)\s*due/i) ?? money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const veg = t.match(/(\d+)\s*(?:vegetarian|veg\b)/i);
    const vegCount = veg ? Number(veg[1]) : null;
    const vegMentioned = /vegetarian/i.test(t);
    const byTime = /deliver\w*[^.\n]{0,40}\bby (1[01]:\d{2})/i.exec(t);
    const valid = /valid until (\d{4}-\d{2}-\d{2})/i.exec(t)?.[1] ?? null;
    const source = pdf ? "pdf p.1" : "email body";
    const questions = vendorOwnWords(i.bodyText).split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?")).map((text) => ({ text: text.trim(), needs_answer_to_quote: true }));
    const reqs = i.request.requirementList ?? [];
    const checks = reqs.map((r) => {
      if (r.kind === "dietary") return vegCount === null ? { requirement_id: r.id, met: null, evidence: "", note: vegMentioned ? "vegetarian offered, count not stated" : "not stated" } : { requirement_id: r.id, met: vegCount >= (r.min_count ?? 0), evidence: `${vegCount} vegetarian`, note: `offered ${vegCount}` };
      if (r.kind === "delivery") return byTime ? { requirement_id: r.id, met: byTime[1]! <= "11:30", evidence: byTime[0], note: `delivered by ${byTime[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "delivery time not stated" };
      return { requirement_id: r.id, met: null, evidence: "", note: "not addressed" };
    });
    return {
      available: !/\b(can't|cannot|unable to)\b/i.test(t), price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null,
      delivery_included: /deliver/i.test(t) ? true : null, tax_usd: null, tax_status: /tax included|including tax|incl\.? tax|sales tax included|and tax/i.test(t) ? "included" : "not_mentioned", tax_rate_percent: null, tax_evidence: "",
      total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: vegCount === null ? (vegMentioned ? [{ need: "vegetarian", covered: true, count_offered: null }] : []) : [{ need: "vegetarian", covered: true, count_offered: vegCount }],
      valid_until: valid, questions, payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source, excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: pdf ? "pdf p.2" : source, excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9, requirement_checks: checks,
    } as never;
  },
};

function setup() {
  let t = T0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string; idempotencyKey: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor, brain: new StubBrain(), payer: disabledPayer("off"),
    // The fake attachment port: Sunset's PDF, by filename; nothing else has attachments.
    attachments: { load: async (m: MessageRow) => (m.attachments.some((a) => a.filename?.endsWith(".pdf")) ? [{ kind: "pdf" as const, filename: "Sunset-Quote-SK-1114.pdf", data: SUNSET_PDF }] : []) },
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<out_${emails.length}@ses.haggle.test>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, manualPaymentHandoff: true, externalSenders: "reply_token", replyTokenSecret: SECRET,
    },
  });
  return { engine, repo, clock, emails, texts };
}

type Env = ReturnType<typeof setup>;
let n = 0;

/** A vendor's reply as its mail client sends it: "Re: <our subject>", In-Reply-To our latest message to it, its own body (quoting ours). */
async function vendorReply(env: Env, jobId: string, from: string, body: (quoted: string) => string, attachments: InboundAttachmentMeta[] = []) {
  const ours = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === from).at(-1)!;
  const id = ++n;
  return env.engine.ingest({
    providerEventId: `ev_${id}`, eventType: "message.received", providerEmailId: `in_${id}`, threadId: `th_${from}`, messageId: `<CA+${id}@mail.example>`,
    inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`,
    bodyText: body(ours.body_text ?? ""), attachments, attachmentsDownloadUrl: null,
  }, external);
}

const gmailQuote = (quoted: string) => `\nOn Thu, Oct 22, 2026 at 9:14 AM Haggle <haggle@inkboxmail.test> wrote:\n${quoted.split("\n").map((l) => `> ${l}`).join("\n")}`;
const outlookQuote = (quoted: string) => `\n\nFrom: Haggle <haggle@inkboxmail.test>\nSent: Thursday, October 22, 2026 9:14 AM\nTo: Sunset Kitchen Catering <catering@sunsetkitchen.example>\nSubject: Quote request\n\n${quoted}`;
const codeIn = (text: string, word: "YES" | "PAID") => new RegExp(`${word} (\\d{4})`).exec(text)?.[1];
/** Words that would claim money moved or was received without the business saying so. */
const OVERCLAIM = /payment (has been )?sent|we('ve| have) paid|(?<!nothing )has been paid|paid in full|money (was )?(sent|received)|payment received/i;

describe("SIMULATED end-to-end purchase: three realistic vendors, re-confirmation, booking, manual handoff", () => {
  it("noncompliant and unconfirmed quotes never win; a stale quote is re-confirmed; nothing is called paid until the human reports it, nor received until the vendor says so", async () => {
    const env = setup();
    const { engine, repo, clock, emails, texts } = env;

    // 1. The agent's request in plain words: no vendor ids, requirements as the user said them.
    const deal = await engine.deal({
      request: { what: "offsite lunch catering", quantity: 60, unit: "people", date: "2026-11-14", time: "11:30", area: "San Francisco, CA", venue: "500 Howard St", requirements: ["At least 12 vegetarian meals", "Delivered to the venue by 11:30"] as never },
      budget_usd: 2500,
      businesses: [{ name: "Harbor Table", email: VENDORS.harbor }, { name: "Golden Grill", email: VENDORS.grill }, { name: "Sunset Kitchen", email: VENDORS.sunset }],
    });
    const jobId = deal.job_id;
    const job = (await repo.getJob(jobId))!;
    expect(job.request.requirements).toEqual([
      { id: "r1", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 },
      { id: "r2", kind: "delivery", text: "Delivered to the venue by 11:30", hard: true },
    ]);
    expect(emails.map((e) => e.to).sort()).toEqual(Object.values(VENDORS).sort());
    const biz = Object.fromEntries((await repo.getBusinesses(jobId)).map((b) => [b.name, b]));
    expect(emails[0]!.subject).toContain(replyToken(SECRET, jobId, biz[emails[0]!.to === VENDORS.harbor ? "Harbor Table" : emails[0]!.to === VENDORS.grill ? "Golden Grill" : "Sunset Kitchen"]!.business_id));

    // 2. Replies, as real clients format them.
    clock.advance(8 * 60_000);
    expect((await vendorReply(env, jobId, VENDORS.harbor, (q) => `Hi there,\n\nThanks for reaching out! We can do the Nov 14 lunch for 60: $2,180 total including delivery and tax, with 14 vegetarian plates, delivered by 11:00. $500 deposit to hold the date. Quote valid until 2026-10-29.\n\nBest,\nMaria\nHarbor Table Catering${gmailQuote(q)}`)).outcome).toBe("stored");
    clock.advance(2 * 60_000);
    expect((await vendorReply(env, jobId, VENDORS.grill, (q) => `hey - we can do 60 ppl for $1,650 total, delivered, tax incl. only 6 vegetarian tho, kitchen is small.\n\nSent from my iPhone${gmailQuote(q)}`)).outcome).toBe("stored");
    clock.advance(2 * 60_000);
    expect((await vendorReply(env, jobId, VENDORS.sunset, (q) => `Hello,\n\nHappy to quote. Is there a loading dock at 500 Howard, or should our driver use the front entrance?\n\nThanks,\nDev | Sunset Kitchen${outlookQuote(q)}`)).outcome).toBe("stored");
    await engine.advanceJob(jobId);

    // Sunset's question goes to the human/agent; the agent answers it from what the user said.
    let board = await engine.getQuotes(jobId);
    const question = board.open_questions.find((x) => x.business === "Sunset Kitchen")!;
    expect(question.text).toMatch(/loading dock/);
    await engine.answerSeller(jobId, question.question_id, "Please use the front entrance on Howard St; there's no loading dock.");
    expect(emails.at(-1)!).toMatchObject({ to: VENDORS.sunset });
    expect(emails.at(-1)!.bodyText).toMatch(/front entrance/);

    // Sunset answers with a PDF quote (served by the fake attachment port), Outlook-style.
    clock.advance(5 * 60_000);
    expect((await vendorReply(env, jobId, VENDORS.sunset, (q) => `Thanks Dev here again - please find our quote attached. Let me know if you have any questions.\n\nDev${outlookQuote(q)}`, [{ filename: "Sunset-Quote-SK-1114.pdf", contentType: "application/pdf", sizeBytes: SUNSET_PDF.byteLength, partIndex: 1, tarPath: "Sunset-Quote-SK-1114.pdf" }])).outcome).toBe("stored");
    await engine.advanceJob(jobId);

    // 3. Quotes close; compare. Golden Grill is cheapest but misses the vegetarian count; Sunset's
    // delivery time is unconfirmed; Harbor meets everything and is the only quote that can win.
    clock.advance(31 * 60_000);
    await engine.advanceJob(jobId);
    board = await engine.getQuotes(jobId);
    const q = (name: string) => board.quotes.find((x) => x.business === name && x.status === "current")!;
    expect(q("Golden Grill")).toMatchObject({ total_usd: 1650, compliance: { status: "noncompliant" } });
    expect(q("Golden Grill").compliance!.issues[0]!.text).toMatch(/only 6 of 12/);
    expect(q("Sunset Kitchen")).toMatchObject({ total_usd: 2050, deposit_usd: 512.5, compliance: { status: "unconfirmed", issues: [{ code: "requirement_unconfirmed", text: "not confirmed: At least 12 vegetarian meals" }] } });
    expect(q("Sunset Kitchen").evidence.total_usd).toMatchObject({ source: "pdf p.1" });
    expect(q("Harbor Table")).toMatchObject({ total_usd: 2180, deposit_usd: 500, compliance: { status: "compliant" }, freshness: { stale: false, valid_until: "2026-10-29" } });
    expect(board.recommended_quote_id).toBe(q("Harbor Table").quote_id);
    expect(board.quotes.map((x) => x.business).indexOf("Golden Grill")).toBeGreaterThan(board.quotes.map((x) => x.business).indexOf("Harbor Table"));
    // Haggle texted the human its recommendation, Harbor, never the cheaper noncompliant quote.
    const suggestion = texts.filter((t) => t.to === APPROVER).find((t) => /All quotes are in/.test(t.text))!;
    expect(suggestion.text).toMatch(/Recommended: Harbor Table \$2,180/);
    expect(suggestion.text).not.toMatch(/Golden Grill|Sunset/);

    // 4. The human lets the suggestion lapse. Eight days later (past Harbor's valid-until date) the
    // agent asks to approve Harbor: Haggle re-confirms with Harbor first; nothing goes to the human yet.
    clock.advance(8 * 24 * 3_600_000);
    await engine.advanceJob(jobId);
    const textsBefore = texts.length;
    await expect(engine.requestApproval(jobId, q("Harbor Table").quote_id, "imessage")).rejects.toMatchObject({ code: "quote_reconfirming", next: "wait_for_update" });
    expect(texts.length).toBe(textsBefore);
    const reconfirm = emails.at(-1)!;
    expect(reconfirm).toMatchObject({ to: VENDORS.harbor });
    expect(reconfirm.bodyText).toMatch(/could you confirm that your quote of \$2,180 total, with a \$500 deposit/);
    expect((await engine.getQuotes(jobId)).quotes.find((x) => x.business === "Harbor Table")!.freshness).toMatchObject({ stale: true, reconfirmation: "requested" });
    // Asking again doesn't send a second request.
    await expect(engine.requestApproval(jobId, q("Harbor Table").quote_id, "imessage")).rejects.toMatchObject({ code: "quote_reconfirming" });
    expect(emails.filter((e) => /still stands\?/.test(e.bodyText))).toHaveLength(1);

    // Harbor confirms the same terms (Gmail, quoting): the approval goes to the human by text.
    clock.advance(40 * 60_000);
    expect((await vendorReply(env, jobId, VENDORS.harbor, (qq) => `Yes, confirmed - the $2,180 total and $500 deposit still stand for Nov 14.\n\nMaria${gmailQuote(qq)}`)).outcome).toBe("quote_reconfirmed");
    await engine.advanceJob(jobId);
    const approvalText = texts.filter((t) => t.to === APPROVER).at(-1)!;
    const yes = codeIn(approvalText.text, "YES")!;
    expect(yes).toBeTruthy();
    expect(approvalText.text).toMatch(/Harbor Table/);

    // 5. The human approves out of band (their own phone). Nothing is booked or paid yet: Harbor is
    // asked to confirm availability and the terms in writing.
    expect((await engine.ingestText({ messageId: "yes1", from: APPROVER, text: `YES ${yes}`, inbound: true })).outcome).toBe("approved");
    expect(texts.filter((t) => t.to === APPROVER).at(-1)!.text).toMatch(/asked Harbor Table to confirm the booking; don't pay yet/);
    const bookingAsk = emails.at(-1)!;
    expect(bookingAsk).toMatchObject({ to: VENDORS.harbor });
    expect(bookingAsk.bodyText).toMatch(/Before anything is booked or paid, please reply to confirm/);
    expect(bookingAsk.bodyText).toMatch(/60 people/);
    board = await engine.getQuotes(jobId);
    expect(board.purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false, money_verified: false });
    expect(board.payment).toMatchObject({ rail: "manual", status: "awaiting_vendor_confirmation" });
    // A PAID text now records nothing (the business hasn't confirmed).
    expect((await engine.ingestText({ messageId: "paid0", from: APPROVER, text: `PAID ${yes}`, inbound: true })).outcome).toBe("paid_before_booking");

    // 6. Harbor confirms the booking and sends payment instructions with a link (untrusted text). Its
    // email is proven only by the reply token, so the confirmation doesn't bind the booking by itself:
    // the human checks with Harbor and accepts it by text (BOOKED <code>).
    clock.advance(2 * 3_600_000);
    expect((await vendorReply(env, jobId, VENDORS.harbor, (qq) => `Confirmed! We're all set for Saturday 11/14, 60 guests, delivered by 11:00.\nFor the $500 deposit you can Zelle payments@harbortable.example or pay the invoice here: https://pay.harbortable.example/inv/1114\n\nMaria${gmailQuote(qq)}`)).outcome).toBe("booking_unverified");
    expect((await engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });
    expect(texts.filter((t) => t.to === APPROVER).at(-1)!.text).toMatch(new RegExp(`can't verify that email came from them.*reply BOOKED ${yes}`));
    expect((await engine.ingestText({ messageId: "booked1", from: APPROVER, text: `BOOKED ${yes}`, inbound: true })).outcome).toBe("booking_confirmed");
    board = await engine.getQuotes(jobId);
    expect(board.purchase).toMatchObject({ stage: "instructions_received", booked: true, money_verified: false, instructions: { untrusted: true, has_link: true } });
    expect(board.purchase!.instructions!.text).toContain("https://pay.harbortable.example/inv/1114");
    expect(texts.filter((t) => t.to === APPROVER).at(-1)!.text).toMatch(/accepted the booking with Harbor Table\. Their payment instructions are on the deal board; confirm them with Harbor Table by phone before paying \$500 directly, then reply PAID/);
    // Nothing was read as a new quote (no revision, no voided approval).
    expect((await repo.getApproval((await repo.getLatestApproval(jobId))!.id))!.status).toBe("approved");

    // 7. The human pays Harbor directly and texts PAID: the customer REPORTS paying; Haggle never says it paid.
    expect((await engine.ingestText({ messageId: "paid1", from: APPROVER, text: `PAID ${yes}`, inbound: true })).outcome).toBe("handoff_confirmed");
    board = await engine.getQuotes(jobId);
    expect(board.state).toBe("paid");
    expect(board.purchase).toMatchObject({ stage: "human_reported_paid", money_verified: false });
    expect(board.payment).toMatchObject({ status: "human_reported_paid", rail: "manual" });
    expect(board.next).toMatch(/reports paying/);
    const told = emails.filter((e) => e.to === VENDORS.harbor).at(-1)!;
    expect(told.bodyText).toMatch(/The customer has told us they have paid the \$500\.00 directly to you/);
    expect(told.bodyText).toMatch(/reply to confirm once it arrives/);

    // 8. Harbor says the deposit arrived, but from a sender proven only by the reply token: never
    // "settled_verified" on that alone; the human is told instead.
    clock.advance(3_600_000);
    expect((await vendorReply(env, jobId, VENDORS.harbor, (qq) => `Got the deposit, thanks! See you on the 14th.${gmailQuote(qq)}`)).outcome).toBe("receipt_unverified");
    board = await engine.getQuotes(jobId);
    expect(board.purchase).toMatchObject({ stage: "human_reported_paid", money_verified: false });
    expect(texts.filter((t) => t.to === APPROVER).at(-1)!.text).toMatch(/says your \$500 payment arrived, but Haggle can't verify who sent it/);

    // Honesty, end to end: no message to any vendor claims money moved; the human was never told "paid"
    // before reporting it; Golden Grill and Sunset were never accepted.
    for (const e of emails) expect(e.bodyText, `to ${e.to}: ${e.bodyText.slice(0, 80)}`).not.toMatch(OVERCLAIM);
    expect(emails.filter((e) => e.to === VENDORS.grill || e.to === VENDORS.sunset).some((e) => /accepted your quote/.test(e.bodyText))).toBe(false);
    const humanTexts = texts.filter((t) => t.to === APPROVER).map((t) => t.text);
    const paidAt = humanTexts.findIndex((t) => /recorded that you report paying/.test(t));
    expect(paidAt).toBeGreaterThan(-1);
    expect(humanTexts.slice(0, paidAt).some((t) => /\bpaid\b/i.test(t) && !/PAID \d{4}|don't pay|nothing (was|is) paid|not.*paid/i.test(t))).toBe(false);
  });
});
