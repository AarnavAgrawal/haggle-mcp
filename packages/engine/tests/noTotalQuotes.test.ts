// Production bug: Postgres `quotes_check1` (not compliant or total_cents is not null). With no hard
// requirements, a decline or a reply priced without a total ("$25 per person", "$200 deposit") was
// inserted compliant with a null total: the insert threw, the reply was marked unreadable, and the
// confirm-once ask for the total never went out. The memory store doesn't enforce the check, so this
// runs on Postgres too (scripts/test-postgres.sh). Also: a stated $0 total is never approvable
// (approvals require amounts > 0). No network.
import { afterAll, describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, PostgresRepository, StubBrain, type Repository } from "../src/index.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const repos: PostgresRepository[] = [];
afterAll(async () => { await Promise.all(repos.map((r) => r.close())); });

const base: QuoteExtraction = {
  available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: null, tax_usd: null, tax_included: null,
  total_usd: null, deposit_usd: null, menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
  sources: [], missing_fields: [], confidence: 0.8,
};
const EXTRACTIONS: Record<string, QuoteExtraction> = {
  "Sorry, we're fully booked that day.": { ...base, available: false },
  "$25 per person": { ...base, price_per_head_usd: 25, sources: [{ field: "price_per_head", source: "email body", excerpt: "$25 per person" }] },
  "$200 deposit to hold the date": { ...base, deposit_usd: 200, sources: [{ field: "deposit", source: "email body", excerpt: "$200 deposit" }] },
  "$0 total, it's on the house": { ...base, total_usd: 0, sources: [{ field: "total", source: "email body", excerpt: "$0 total" }] },
  "$500 total, $50 deposit": { ...base, total_usd: 500, deposit_usd: 50, sources: [{ field: "total", source: "email body", excerpt: "$500 total" }, { field: "deposit", source: "email body", excerpt: "$50 deposit" }] },
};
// A text reply carries Haggle's last text as context; the extraction is keyed by the business's own words.
const own = (t: string) => t.replace(/^\[Haggle's last text[^\n]*\n\[The business's reply\]: /, "");
const extractor = { async extract(i: { bodyText: string }) { const x = EXTRACTIONS[own(i.bodyText)]; if (!x) throw new Error("no extraction"); return structuredClone(x); } };

function engine(repo: Repository) {
  const texts: { to: string; text: string }[] = [];
  const e = new HaggleEngine({
    repo, extractor: extractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send() { throw new Error("no email in this test"); } },
    imessage: { async send(r) { texts.push(r); return { messageId: `im_${Math.random().toString(36).slice(2)}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 2 },
  });
  return { engine: e, texts };
}

const phone = () => `+1415${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

describe.each(PG_URL ? ["memory", "postgres"] : ["memory"])("replies without a total, no hard requirements (%s)", (backend) => {
  const repo = (): Repository => (backend === "postgres" ? (repos.push(new PostgresRepository(PG_URL!, { max: 2 })), repos.at(-1)!) : new InMemoryRepository());

  // "$25 per person" for a request of 50: the merged validator works out a total from the stated
  // parts (labelled computed, decision 11), so it is quoted with that total ("clarifying" while Haggle asks), still not approvable
  // (delivery and tax unknown), and Haggle asks once for the exact all-in figure.
  it.each([
    ["Sorry, we're fully booked that day.", "declined", false, null],
    ["$25 per person", "clarifying", true, 1250],
    ["$200 deposit to hold the date", "responded", true, null],
  ])("%s → stored and read (stage %s), never 'unreadable'; asks for the total once when priced", async (text, stage, asks, total) => {
    const { engine: e, texts } = engine(repo());
    const biz = { name: "Corner Deli", phone: phone(), channel: "imessage" as const };
    const deal = await e.deal({ request: { what: "catering", quantity: 50, unit: "people", date: "2030-10-24", area: "San Francisco, CA", requirements: [] }, businesses: [biz] });
    await e.ingestIMessage({ messageId: `in_${Math.random().toString(36).slice(2)}`, from: biz.phone, text, isGroup: false });
    await e.advanceJob(deal.job_id);
    const board = await e.getQuotes(deal.job_id);
    const bid = board.businesses[0]!.business_id;
    expect(board.stages![bid]!.stage).toBe(stage);
    expect(board.businesses[0]!.last_event).not.toMatch(/couldn't read/);
    const msgs = await (e as unknown as { repo: Repository }).repo.listMessages(deal.job_id);
    expect(msgs.find((m) => m.direction === "in")!.parse_status).toBe("done");
    const q = board.quotes[0]!;
    expect(q.total_usd).toBe(total);
    if (total !== null) expect(q.source).toMatch(/^computed/);
    expect(q.approvable).toBe(false);
    if (text.startsWith("$200")) expect(q.deposit_usd).toBe(200);
    const followups = texts.filter((t) => /exact (all-in )?total|confirm/i.test(t.text));
    expect(followups).toHaveLength(asks ? 1 : 0);
    if (asks) expect(followups[0]!.text.length).toBeLessThanOrEqual(159);
  });

  it("a stated $0 total is shown but never recommended or approvable", async () => {
    const { engine: e } = engine(repo());
    const biz = { name: "Free Lunch Co", phone: phone(), channel: "imessage" as const };
    const real = { name: "Real Deli", phone: phone(), channel: "imessage" as const };
    const deal = await e.deal({ request: { what: "catering", quantity: 50, unit: "people", date: "2030-10-24", area: "San Francisco, CA", requirements: [] }, businesses: [biz, real] });
    await e.ingestIMessage({ messageId: `in_${Math.random().toString(36).slice(2)}`, from: biz.phone, text: "$0 total, it's on the house", isGroup: false });
    await e.ingestIMessage({ messageId: `in_${Math.random().toString(36).slice(2)}`, from: real.phone, text: "$500 total, $50 deposit", isGroup: false });
    await e.advanceJob(deal.job_id);
    const board = await e.getQuotes(deal.job_id);
    const q = board.quotes.find((x) => x.business === biz.name)!;
    expect(q.total_usd).toBe(0);
    expect(q).toMatchObject({ eligible: false, approvable: false, approval_block: { code: "zero_total" } });
    expect(board.recommended_quote_id).toBe(board.quotes.find((x) => x.business === real.name)!.quote_id);
    await expect(e.requestApproval(deal.job_id, q.quote_id, "view")).rejects.toMatchObject({ code: "zero_total" });
  });
});
