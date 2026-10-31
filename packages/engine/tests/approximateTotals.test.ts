// Approximate totals (2026-10-18 rehearsal: "prolly around 1300 total bucks", "It'll cost approximately
// twelve hundred dollars"). They are shown and ranked (≈) but never approvable or payable until the
// business confirms a firm total; Haggle asks once on the business's own channel (never by a new call),
// and a counteroffer citing one says "about". Unknown deposits stay unknown. Real engine, fake ports,
// an extractor that returns fixed extractions per text. No network.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain } from "../src/index.ts";
import { confirmsFirm, isApproximateTotal } from "../src/parsing/approximate.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";
import { planCounteroffers } from "../src/negotiation/counteroffer.ts";

const base: QuoteExtraction = {
  available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: null, tax_usd: null, tax_included: null,
  total_usd: null, deposit_usd: null, menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
  sources: [], missing_fields: [], confidence: 0.8,
};
const priced = (total: number | null, excerpt: string, deposit: number | null = null, depositExcerpt = ""): QuoteExtraction => ({
  ...base, total_usd: total, deposit_usd: deposit,
  sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: depositExcerpt }] : [])],
});

const HARBOR_TEXT = "prolly around 1300 total bucks\n\nOn 10/18/2026, 12:08:19 AM, haggle@inkboxmail.test wrote:\n> Hi Harbor Table,\n> Could you quote the following? About 50 people.";
const MISSION_CALL = [
  "Haggle (AI assistant): Hi, this is Haggle, an AI assistant calling for a customer about a quote for catering. Do you have a minute?",
  "Mission Eats: Sure. It'll cost approximately twelve hundred dollars for the fifty of them.",
  "Haggle (AI assistant): Thank you, goodbye.",
].join("\n");

// $22 a person for 50 + $100 delivery + 10% tax on the food = $1,310 all in, worked out by Haggle (decision 47).
const PARTS_CALL = ["Haggle (AI assistant): Hi, I'm an AI assistant calling for a customer about catering.", "Mission Eats: It's $22 a person for the fifty, $100 delivery, plus 10% tax. $200 deposit."].join("\n");
const PARTS_TEXT = "$22 a person, $100 delivery, plus 10% tax, $200 deposit";
const ABOUT_PARTS = "about $22 a person, $100 delivery, plus 10% tax";
const parts = (pp: string, deposit: number | null = 200): QuoteExtraction => ({
  ...base, price_per_head_usd: 22, headcount: 50, delivery_fee_usd: 100, tax_included: false, tax_rate_percent: 10, deposit_usd: deposit,
  sources: [{ field: "price_per_head", source: "email body", excerpt: pp }, { field: "delivery_fee", source: "email body", excerpt: "$100 delivery" }, ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: "$200 deposit" }] : [])],
});

const EXTRACTIONS = new Map<string, QuoteExtraction>([
  [PARTS_CALL, parts("$22 a person")],
  [PARTS_TEXT, parts("$22 a person")],
  [ABOUT_PARTS, parts("about $22 a person", null)],
  ["$1500, $250 deposit", priced(1500, "$1500", 250, "$250 deposit")],
  [HARBOR_TEXT, priced(1300, "1300 total bucks")],
  [MISSION_CALL, priced(1200, "twelve hundred dollars")],
  ["Yes, $1,250 firm all in, $200 deposit.", priced(1250, "$1,250 firm all in", 200, "$200 deposit")],
  ["around $900 for all of it", priced(900, "around $900")],
  ["Yep, that's firm", base],
]);
const extractor = {
  async extract(i: { bodyText: string }) {
    // A text reply carries Haggle's last text as context; the extraction is keyed by the business's own words.
    const t = i.bodyText.replace(/^\[Haggle's last text[^\n]*\n\[The business's reply\]: /, "");
    // An email is read without our quoted RFQ (cleanEmailBody): match it by the business's own lines.
    const x = EXTRACTIONS.get(t) ?? [...EXTRACTIONS].find(([k]) => t.trim().length > 5 && k.startsWith(t.trim()))?.[1];
    if (!x) throw new Error("no extraction for this text");
    return structuredClone(x);
  },
};

function engine() {
  // Real time: the memory store stamps messages with the wall clock, and the collection window holds
  // for a business Haggle just asked (chasedRecently) by comparing those stamps with the engine clock.
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const sent: { to: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const calls: { toNumber: string; reason: string }[] = [];
  const repo = new InMemoryRepository({ now: clock.now });
  const e = new HaggleEngine({
    repo, now: clock.now, extractor: extractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { sent.push(m); return { providerId: `em_${sent.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${sent.length}@haggle.test>` }; } },
    imessage: { async send(r) { texts.push(r); return { messageId: `im_${texts.length}` }; } },
    phone: { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 2 },
  });
  return { engine: e, repo, clock, sent, texts, calls };
}
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const REQUEST = { what: "catering", quantity: 50, unit: "people", date: "2030-10-24", area: "San Francisco, CA", requirements: [] };
const SUNSET = { name: "Sunset Kitchen", phone: "+14155550111", channel: "imessage" as const };
const HARBOR = { name: "Harbor Table", email: "orders@harbor.test" };
const MISSION = { name: "Mission Eats", phone: "+14155550104" };

async function email(e: HaggleEngine, repo: InMemoryRepository, jobId: string, id: string, body: string) {
  const b = (await repo.getBusinesses(jobId)).find((x) => x.name === HARBOR.name)!;
  const rfq = b.rfq_message_id!;
  await e.ingest({ providerEventId: `e_${id}`, eventType: "message.received", providerEmailId: id, threadId: "t1", messageId: `<${id}@x>`, inReplyTo: [rfq], references: [rfq], from: HARBOR.email, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: body, attachments: [], attachmentsDownloadUrl: null }, trusted);
}

describe("approximate totals: detected from the business's own words", () => {
  it("the three rehearsal replies: $1500 is firm; 'prolly around 1300' and 'approximately twelve hundred' are not", () => {
    expect(isApproximateTotal({ totalCents: 150_000, excerpts: ["$1500"], text: "$1500, $250 deposit", channel: "imessage" })).toBe(false);
    expect(isApproximateTotal({ totalCents: 130_000, excerpts: ["1300 total bucks"], text: HARBOR_TEXT, channel: "email" })).toBe(true);
    expect(isApproximateTotal({ totalCents: 120_000, excerpts: ["twelve hundred dollars"], text: MISSION_CALL, channel: "phone" })).toBe(true);
  });

  it("hedges: ~, -ish, ballpark, estimate, should be, roughly; a hedge elsewhere in the reply or in quoted mail doesn't count", () => {
    const approx = (text: string, total = 1300, excerpt = "") => isApproximateTotal({ totalCents: total * 100, excerpts: [excerpt], text, channel: "email" });
    expect(approx("~$1,300 all in")).toBe(true);
    expect(approx("1300ish")).toBe(true);
    expect(approx("Should be $1,300 total")).toBe(true);
    expect(approx("Roughly 1.3k total")).toBe(true);
    expect(approx("Our estimate: $1,300 total")).toBe(true);
    expect(approx("$1,300 total. That's a rough estimate.")).toBe(true);
    expect(approx("Thanks for asking about the date! $1,300 total, $200 deposit.")).toBe(false);
    expect(approx("$1,300 total, about 20 vegetarian.")).toBe(false);
    expect(approx("$1,300 total.\n\nOn Mon, Haggle wrote:\n> roughly 50 people, around noon")).toBe(false);
    expect(approx("Around $1,300 at first glance. Final: $1,300 total.")).toBe(false); // said firmly once: firm
    // The agent's own words on a call never make the business's figure approximate.
    expect(isApproximateTotal({ totalCents: 120_000, excerpts: ["$1,200 total"], text: "Haggle (AI assistant): roughly how much?\nMission Eats: $1,200 total.", channel: "phone" })).toBe(false);
  });

  it("a bare confirmation ('yes', 'that's firm') confirms; a partial answer doesn't", () => {
    expect(confirmsFirm("Yep, that's firm", "imessage")).toBe(true);
    expect(confirmsFirm("Yes!", "imessage")).toBe(true);
    expect(confirmsFirm("yes firm, $200 deposit", "imessage")).toBe(true);
    expect(confirmsFirm("yes 40 veggie meals", "imessage")).toBe(false);
    expect(confirmsFirm("yes, around that", "imessage")).toBe(false);
    expect(confirmsFirm("Is that ok?", "imessage")).toBe(false);
  });
});

describe("approximate totals in a deal", () => {
  it("rehearsal: ranked and shown ≈, not approvable; one firm-total ask on email; none for the phone vendor; a firm reply revises the quote", async () => {
    const { engine: e, repo, sent, texts, calls } = engine();
    const deal = await e.deal({ request: REQUEST, businesses: [SUNSET, HARBOR, MISSION] });
    expect(calls).toHaveLength(1);
    await e.ingestIMessage({ messageId: "im_s1", from: SUNSET.phone, text: "$1500, $250 deposit", isGroup: false });
    await email(e, repo, deal.job_id, "in_h1", HARBOR_TEXT);
    await e.ingestCall({ callId: "call_1", outcome: "completed", transcript: MISSION_CALL });
    await e.advanceJob(deal.job_id);

    let board = await e.getQuotes(deal.job_id);
    const q = (n: string) => board.quotes.find((x) => x.business === n && x.status === "current")!;
    expect(q("Sunset Kitchen")).toMatchObject({ total_usd: 1500, deposit_usd: 250, approvable: true });
    expect(q("Sunset Kitchen").total_approximate).toBeUndefined();
    for (const n of ["Harbor Table", "Mission Eats"]) {
      expect(q(n)).toMatchObject({ total_approximate: true, approvable: false, eligible: true, verdict: "compliant", approval_block: { code: "total_not_firm" } });
      expect(q(n).flags).toContain("approximate_total");
      expect(q(n).deposit_usd).toBeUndefined(); // unknown, never 0
    }
    expect(q("Harbor Table").approval_block!.reason).toMatch(/≈ \$1,300.*asked Harbor Table once for a firm all-in total/);
    expect(q("Mission Eats").approval_block!.reason).toMatch(/≈ \$1,200.*callback.*only you can authorize/);
    // Ranked like any quote (the value ranking decides), shown with the ≈ marker.
    expect(board.value?.ranked.map((r) => r.business).sort()).toEqual(["Harbor Table", "Mission Eats", "Sunset Kitchen"]);

    // Never approvable, so the "no deposit: pay the full total" rule can't apply to an estimate.
    for (const n of ["Harbor Table", "Mission Eats"]) {
      await expect(e.requestApproval(deal.job_id, q(n).quote_id, "view")).rejects.toMatchObject({ code: "total_not_firm" });
    }
    expect(await repo.getLatestApproval(deal.job_id)).toBeNull();

    // One firm-total ask to Harbor, in its email thread; nothing new to the phone vendor (no call, no text).
    const ask = sent.filter((m) => m.to === HARBOR.email).at(-1)!;
    // The one batched follow-up (decision 12), carrying main's firm-total ask.
    expect(ask.bodyText).toMatch(/Could you also tell us:\n- your firm all-in total \(you said about \$1,300\) and the deposit/);
    expect(calls).toHaveLength(1);
    expect(texts.filter((t) => t.to === MISSION.phone)).toHaveLength(0);
    expect(texts.filter((t) => t.to === SUNSET.phone)).toHaveLength(1); // the RFQ only: Sunset's quote is firm
    expect(board.stages![q("Harbor Table").business_id]!.stage).toBe("clarifying");

    // The firm answer: a revised version without the flag, with the stated deposit.
    await email(e, repo, deal.job_id, "in_h2", "Yes, $1,250 firm all in, $200 deposit.");
    await e.advanceJob(deal.job_id);
    board = await e.getQuotes(deal.job_id);
    const h2 = q("Harbor Table");
    expect(h2).toMatchObject({ total_usd: 1250, deposit_usd: 200, round: 1, approvable: true }); // a confirm-once revision stays round 1 (decision 16)
    expect(h2.total_approximate).toBeUndefined();
    expect(h2.flags).not.toContain("approximate_total");
    // An estimate was never a price: no "negotiated from" or savings against it.
    expect(h2.negotiated_from).toBeUndefined();
    expect(board.stages![h2.business_id]!.saved_usd).toBeUndefined();

    // Every business answered: counters went out, citing Mission's figure as what it is, an estimate.
    expect(board.state).toBe("negotiating");
    const counter = texts.filter((t) => t.to === SUNSET.phone).at(-1)!.text;
    expect(counter).toMatch(/We have another estimate of about \$1,200\.00 total/);
    expect(counter).not.toMatch(/quote of \$1,200/);
    // The confirm-once revision didn't use up Harbor's negotiation round: it is countered too, in words.
    const toHarbor = sent.filter((m) => m.to === HARBOR.email).at(-1)!.bodyText;
    expect(toHarbor).toMatch(/Thanks for your quote of \$1,250\.00 total\. We've received another estimate of about \$1,200\.00 total for the same order and requirements \(not yet confirmed as firm\)/);
    expect(board.negotiation.map((n) => n.business).sort()).toEqual(["Harbor Table", "Sunset Kitchen"]);
    expect(board.negotiation.every((n) => n.outcome_total_usd === null)).toBe(true); // Harbor's $1,250 came before the counter: not its answer
    expect(board.negotiation.every((n) => n.basis_approximate === true)).toBe(true);

    const a = await e.requestApproval(deal.job_id, h2.quote_id, "view");
    expect(a).toMatchObject({ quote_total_cents: 125_000, payment_cents: 20_000 });
  });

  it("iMessage: the confirm text fits Inkbox's limits; 'Yep, that's firm' makes it approvable; the unknown deposit stays unknown", async () => {
    const { engine: e, texts } = engine();
    const deal = await e.deal({ request: REQUEST, businesses: [SUNSET] });
    await e.ingestIMessage({ messageId: "im_1", from: SUNSET.phone, text: "around $900 for all of it", isGroup: false });
    await e.advanceJob(deal.job_id);
    let board = await e.getQuotes(deal.job_id);
    const v1 = board.quotes[0]!;
    expect(v1).toMatchObject({ total_usd: 900, total_approximate: true, approvable: false });
    await expect(e.requestApproval(deal.job_id, v1.quote_id, "view")).rejects.toMatchObject({ code: "total_not_firm" });
    const ask = texts.at(-1)!.text;
    // The cancellation policy (decision-critical for catering, intake) rides along; the deposit is already in the firm ask.
    expect(ask).toMatch(/^Thanks! Can you confirm: your cancellation policy; your firm all-in total \(you said about \$900\) and the deposit\?$/);
    expect(ask.length).toBeLessThanOrEqual(159);
    expect(ask).not.toMatch(/https?:|www\./);

    await e.ingestIMessage({ messageId: "im_2", from: SUNSET.phone, text: "Yep, that's firm", isGroup: false });
    await e.advanceJob(deal.job_id);
    board = await e.getQuotes(deal.job_id);
    const v2 = board.quotes.find((x) => x.status === "current")!;
    expect(v2).toMatchObject({ total_usd: 900, round: 1, approvable: true });
    expect(v2.total_approximate).toBeUndefined();
    expect(v2.deposit_usd).toBeUndefined(); // still unknown: never 0
    expect(v2.evidence.total_usd?.source).toMatch(/confirmed firm by the business/);
    expect(texts.filter((t) => /confirm/i.test(t.text))).toHaveLength(1); // asked once
    // Firm now: with no deposit stated, the approval says the full total is charged.
    expect(await e.approvalCaveats(deal.job_id, v2.quote_id)).toContain("No deposit stated: the full $900 is charged now");
    const a = await e.requestApproval(deal.job_id, v2.quote_id, "view");
    expect(a.payment_cents).toBe(90_000);
  });

  it("a long confirm-once text keeps the firm-total ask whole, with no reference code", () => {
    const text = HaggleEngine.confirmIMessageText(["At least 40 vegetarian meals", "Total must include delivery and all fees, setup, staffing and cleanup by 5pm", "your firm all-in total (you said about $4,500) and the deposit"], "AB12CD");
    expect(text.length).toBeLessThanOrEqual(159);
    expect(text).toMatch(/your firm all-in total \(you said about \$4,500\) and the deposit\?$/);
  });
});

// Decision 47: a total Haggle worked out from stated parts is trusted as firm (no "we worked it out as
// $X, please confirm" text or call); the business's own "about" keeps it approximate.
describe("totals Haggle computed from stated parts", () => {
  it("a call with per-person price, delivery and tax rate: no confirmation call, approvable, and collection closes", async () => {
    const { engine: e, repo, clock, calls, texts } = engine();
    const deal = await e.deal({ request: REQUEST, businesses: [MISSION] });
    expect(calls).toHaveLength(1);
    expect((await e.ingestCall({ callId: "call_1", outcome: "completed", transcript: PARTS_CALL })).outcome).toBe("stored");
    await e.advanceJob(deal.job_id);
    clock.advance(5 * 60_000); // past the call cooldown: a confirmation call would be placed now
    await e.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    expect(texts).toHaveLength(0);
    const board = await e.getQuotes(deal.job_id);
    const q = board.quotes.find((x) => x.business === "Mission Eats")!;
    expect(q).toMatchObject({ total_usd: 1310, deposit_usd: 200, approvable: true });
    expect(q.total_approximate).toBeUndefined();
    expect(board.ready).toBe(true); // nothing held collection open
    expect((await repo.listEvents(deal.job_id)).some((x) => x.type === "reply" && /exact total|Asked Mission Eats/.test(String(x.data.summary)))).toBe(false);
    expect(await e.requestApproval(deal.job_id, q.quote_id, "view")).toMatchObject({ quote_total_cents: 131_000, payment_cents: 20_000 });
  });

  it("by text the same parts send nothing back; 'about $22 a person' by email stays approximate and is asked once", async () => {
    const { engine: e, repo, sent, texts } = engine();
    const deal = await e.deal({ request: REQUEST, businesses: [SUNSET, HARBOR] });
    await e.ingestIMessage({ messageId: "im_p1", from: SUNSET.phone, text: PARTS_TEXT, isGroup: false });
    await email(e, repo, deal.job_id, "in_about", ABOUT_PARTS);
    await e.advanceJob(deal.job_id);
    expect(texts.filter((t) => t.to === SUNSET.phone)).toHaveLength(1); // the RFQ only
    const board = await e.getQuotes(deal.job_id);
    expect(board.quotes.find((x) => x.business === "Sunset Kitchen")).toMatchObject({ total_usd: 1310, approvable: true });
    const harbor = board.quotes.find((x) => x.business === "Harbor Table")!;
    expect(harbor).toMatchObject({ total_approximate: true, approvable: false, approval_block: { code: "total_not_firm" } });
    const toHarbor = sent.filter((m) => m.to === HARBOR.email);
    expect(toHarbor).toHaveLength(2); // the RFQ and one ask
    expect(toHarbor[1]!.bodyText).toMatch(/exact all-in total/);
  });
});

describe("negotiation never presents an estimate as a firm quote", () => {
  const deadline = new Date("2030-01-01T12:00:00Z");
  const quote = (id: string, total: number, approximate = false) => ({ quoteId: id, businessId: `biz_${id}`, businessName: id, totalCents: total, available: true, compliant: true, senderTrusted: true, round: 1, status: "current" as const, confidence: 0.9, flags: [], approximate });

  it("a counter citing an approximate competing total says 'about'; its own estimate is called an estimate", () => {
    const plan = planCounteroffers([quote("cheap", 120_000, true), quote("firm", 150_000), quote("vague", 130_000, true)], deadline, 2);
    const toFirm = plan.find((p) => p.businessId === "biz_firm")!;
    expect(toFirm).toMatchObject({ basis: "competing_quote", basisApproximate: true, targetTotalCents: 120_000 });
    expect(toFirm.text).toMatch(/Thanks for your quote of \$1,500\.00 total\. We've received another estimate of about \$1,200\.00 total/);
    expect(toFirm.text).not.toMatch(/another quote of \$1,200/);
    expect(toFirm.shortText).toMatch(/another estimate of about \$1,200\.00 total/);
    const toVague = plan.find((p) => p.businessId === "biz_vague")!;
    expect(toVague.text).toMatch(/Thanks for your estimate of about \$1,300\.00 total/);
  });

  it("a firm competing quote is still cited as a real quote", () => {
    const plan = planCounteroffers([quote("cheap", 120_000), quote("firm", 150_000)], deadline, 2);
    expect(plan[0]).toMatchObject({ basisApproximate: false });
    expect(plan[0]!.text).toMatch(/another quote of \$1,200\.00 total/);
  });

  it("a callback brief citing an estimate says so", () => {
    const job = { short_code: "AB12CD", request: REQUEST };
    const brief = HaggleEngine.callBrief("Mission Eats", job, [], { competingTotalUsd: 1200, competingApproximate: true, followUpOnQuoteUsd: 1300, followUpApproximate: true });
    expect(brief).toMatch(/Another business estimated about \$1,200 total .*not yet a firm quote/);
    expect(brief).toMatch(/your estimate of about \$1,300/);
    expect(brief).not.toMatch(/We have a real quote/);
  });
});
