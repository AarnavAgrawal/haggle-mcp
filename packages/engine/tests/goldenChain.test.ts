// Module-chain integration test (NOT a product end-to-end test): the six v3 golden-scenario
// replies, as SDK-signed webhook events, through every engine module in order. The LLM step is a
// fixed extraction per business (what a correct parse would return); there is no persistence, no
// job driver and no MCP tool yet. It proves the modules compose, not that the workflow runs.
// Numbers marked PROPOSED in docs/v3-prekickoff-readiness.md §7F still need Partner approval.
import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "@primitivedotdev/sdk/webhook";
import { createX402Client } from "@primitivedotdev/sdk/x402";
import { buildEvent } from "./helpers/primitiveEvent.ts";
import {
  evaluateRequirements,
  jobInboxAddress,
  matchInbound,
  meetsHardRequirements,
  parseChallengePart,
  planCounteroffers,
  preparePayment,
  rankQuotes,
  senderTrust,
  toInbound,
  validateQuote,
  verifyApproval,
  verifyWebhook,
  type BusinessCandidate,
  type CounterQuote,
  type EngineRequirement,
  type PayerClient,
  type QuoteExtraction,
  type RankableQuote,
} from "../src/index.ts";

const SECRET = "whsec_chain_test";
const DOMAIN = "brave-dog.primitive.email";
const INBOX = jobInboxAddress("7F3K", DOMAIN);
// Relative to the real clock: the x402 SDK checks challenge expiry against wall time.
const NOW = new Date();
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const REQS: EngineRequirement[] = [
  { id: "veg12", kind: "dietary", need: "vegetarian", min_count: 12, text: "At least 12 vegetarian meals", hard: true },
  { id: "delivery", kind: "delivery", text: "Delivery included", hard: true },
];

const biz = (id: string, email: string): BusinessCandidate => ({ businessId: id, jobId: "job-1", shortCode: "7F3K", email, threadId: null, outboundMessageId: null });
const BUSINESSES = [
  biz("b-bay", "quotes@bay-catering.primitive.email"),
  biz("b-harbor", "orders@harbor-table.primitive.email"),
  biz("b-mission", "hi@mission-eats.primitive.email"),
  biz("b-grill", "sales@golden-grill.primitive.email"),
  biz("b-sunset", "events@sunset-kitchen.primitive.email"),
  biz("b-deli", "deals@quickquote-deli.primitive.email"),
];
const NAMES: Record<string, string> = { "b-bay": "Bay Catering", "b-harbor": "Harbor Table", "b-mission": "Mission Eats", "b-grill": "Golden Grill", "b-sunset": "Sunset Kitchen", "b-deli": "QuickQuote Deli" };

const blank: QuoteExtraction = {
  available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
  tax_usd: null, tax_included: true, total_usd: null, deposit_usd: null, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
  valid_until: "2026-10-21", questions: [], payment_request: "none", instructions_to_agent: false, sources: [], missing_fields: [], confidence: 0.9,
};
const priced = (total: number, deposit: number | null, depositSource = "email body", extra: Partial<QuoteExtraction> = {}): QuoteExtraction => ({
  ...blank, total_usd: total, deposit_usd: deposit,
  sources: [{ field: "total", source: "email body", excerpt: `$${total}` }, ...(deposit !== null ? [{ field: "deposit" as const, source: depositSource, excerpt: `$${deposit}` }] : [])],
  ...extra,
});

// What a correct parse of each round-1 reply returns (the LLM call itself is covered in parseReply.test.ts).
const ROUND1: Record<string, QuoteExtraction> = {
  "b-bay": priced(1150, 5),
  "b-harbor": priced(1120, 300, "pdf p.2"),
  "b-mission": { ...blank, missing_fields: ["total"], confidence: 0.35 },
  "b-grill": priced(860, null, "email body", { dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 6 }] }),
  "b-sunset": { ...blank, questions: ["Do you need plates and cutlery?"], confidence: 0.8 },
  "b-deli": priced(700, null, "email body", { payment_request: "external_link", instructions_to_agent: true }),
};

function signedInbound(from: string, body: string, opts: { auth?: "pass" | "fail"; threadId?: string } = {}) {
  const raw = JSON.stringify(buildEvent({ from, to: INBOX, bodyText: body, endpointId: "ep_buyer", ...opts }));
  const headers = new Headers({ "primitive-signature": signWebhookPayload(raw, SECRET, Math.floor(Date.now() / 1000)).header });
  return { raw, headers };
}

/** Webhook bytes -> verified, mapped, matched, trusted, validated, requirement-checked quote. */
function ingest(raw: string, headers: Headers, extraction: QuoteExtraction, round = 1) {
  const v = verifyWebhook(raw, headers, { secret: SECRET, endpointId: "ep_buyer" });
  if (!v.ok) throw new Error(v.reason);
  const m = toInbound(v.event);
  const match = matchInbound({ to: m.to, threadId: m.threadId, inReplyTo: m.inReplyTo, references: m.references, subject: m.subject, from: m.from ?? "" }, BUSINESSES, [], DOMAIN);
  if (match.kind !== "business") return { match };
  const snapshot = BUSINESSES.find((b) => b.businessId === match.businessId)!.email;
  const trust = senderTrust(v.event, snapshot);
  const record = validateQuote(extraction, 40);
  const results = evaluateRequirements(record, REQS, 40);
  return { match, trust, record, compliant: meetsHardRequirements(results, REQS), round, quoteId: `q-${match.businessId}-${round}` };
}

describe("golden scenario through the engine modules", () => {
  const round1 = BUSINESSES.map((b) => {
    const { raw, headers } = signedInbound(b.email, `reply from ${NAMES[b.businessId]}`);
    const r = ingest(raw, headers, ROUND1[b.businessId]!);
    if (r.match.kind !== "business") throw new Error(`unmatched ${b.businessId}`);
    return r as Required<typeof r>;
  });
  const byId = Object.fromEntries(round1.map((r) => [(r.match as { businessId: string }).businessId, r]));

  it("matches and trusts every authenticated reply on the job inbox", () => {
    for (const r of round1) expect(r.trust.trusted).toBe(true);
  });

  it("flags each trap the way the judge rubric expects", () => {
    expect(byId["b-grill"]!.compliant).toBe(false); // 6 of 12 vegetarian
    expect(byId["b-harbor"]!.record.flags).toContain("hidden_deposit"); // deposit on pdf p.2
    expect(byId["b-harbor"]!.record.total_cents).toBe(112000); // deposit not added to total
    expect(byId["b-mission"]!.record.total_cents).toBeNull(); // vague: missing, never 0
    expect(byId["b-sunset"]!.record.flags).toContain("question_pending"); // plates question
    expect(byId["b-deli"]!.record.flags).toEqual(expect.arrayContaining(["external_payment_link", "prompt_injection"]));
  });

  const toRankable = (r: (typeof round1)[number], status: RankableQuote["status"] = "current"): RankableQuote => ({
    quoteId: r.quoteId, businessId: (r.match as { businessId: string }).businessId, totalCents: r.record.total_cents, available: r.record.available,
    compliant: r.compliant, senderTrusted: r.trust.trusted, status, confidence: r.record.confidence, flags: r.record.flags,
  });

  it("round 1: Harbor Table leads; Golden Grill and QuickQuote are rejected", () => {
    const ranking = rankQuotes(round1.map((r) => toRankable(r)), 120000);
    expect(ranking.recommendedQuoteId).toBe("q-b-harbor-1");
    expect(ranking.rejected.map((x) => [x.businessId, x.reason])).toEqual(expect.arrayContaining([["b-grill", "requirement_unmet"], ["b-deli", "external_payment_link"], ["b-mission", "no_total"], ["b-sunset", "no_total"]]));
  });

  it("negotiation cites Harbor's real quote to Bay; Bay's real $995 revision then wins", () => {
    const counters = planCounteroffers(round1.map((r): CounterQuote => ({
      quoteId: r.quoteId, businessId: (r.match as { businessId: string }).businessId, businessName: NAMES[(r.match as { businessId: string }).businessId]!,
      totalCents: r.record.total_cents, available: r.record.available, compliant: r.compliant, senderTrusted: r.trust.trusted, round: 1,
      status: "current", confidence: r.record.confidence, flags: r.record.flags,
    })), new Date(at(30)));
    expect(counters.map((c) => [c.businessId, c.basisQuoteId, c.targetTotalCents])).toEqual([["b-bay", "q-b-harbor-1", 112000]]);

    // Bay replies in-thread with a revision. The revision is a received email, not something the engine computes.
    const { raw, headers } = signedInbound(BUSINESSES[0]!.email, "We can do $995 total, $5 deposit.");
    const rev = ingest(raw, headers, priced(995, 5), 2) as Required<ReturnType<typeof ingest>>;
    const ranking = rankQuotes([...round1.filter((r) => r !== byId["b-bay"]).map((r) => toRankable(r)), toRankable(byId["b-bay"]!, "superseded"), toRankable(rev)], 120000);
    expect(ranking.recommendedQuoteId).toBe("q-b-bay-2");
  });

  it("a spoofed revision in Bay's name is not trusted and can't win", () => {
    const { raw, headers } = signedInbound(BUSINESSES[0]!.email, "Now $10 total!", { auth: "fail" });
    const fake = ingest(raw, headers, priced(10, 5), 2) as Required<ReturnType<typeof ingest>>;
    expect(fake.trust.trusted).toBe(false);
    expect(rankQuotes([toRankable(fake)], 120000).rejected[0]!.reason).toBe("unverified_sender");
  });

  it("approval by trusted email, then the x402 guard and a locally built payment step", async () => {
    const approval = { status: "pending", code: "4821", approver_email: "yash@example.com", expires_at: at(30) };
    expect(verifyApproval(approval, { from: "yash@example.com", senderTrusted: true, threadMatched: true, bodyText: "APPROVE 4821" }, NOW)).toEqual({ decision: "approve" });

    const part = JSON.stringify({
      interaction_version: 1, interaction_id: "5f0c1b9e-2d3a-4c5b-9e8f-7a6b5c4d3e2f@bay-catering.primitive.email", protocol: "x402.payment",
      protocol_version: 1, step: "challenge", step_id: "0b6d7f2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", prev_step_id: null, expires_at: at(5),
      payload: { challenge_nonce: "b".repeat(64), payment_requirements: { scheme: "exact", network: "base-sepolia", maxAmountRequired: "5000000",
        payTo: "0x1111111111111111111111111111111111111111", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { name: "USDC", version: "2" } } },
    });
    const parsed = parseChallengePart(part);
    if (!parsed.ok) throw new Error(parsed.reason);
    const payer = createX402Client({ apiKey: "prim_test", fetch: (async () => { throw new Error("no network"); }) as typeof fetch });
    const signer = { address: "0x2222222222222222222222222222222222222222" as const, signTypedData: async () => `0x${"cd".repeat(65)}` as const };
    const prepared = await preparePayment(payer as unknown as PayerClient, signer, parsed.parsed, {
      job: { id: "job-1", state: "paying" },
      approval: { id: "ap-1", job_id: "job-1", quote_id: "q-b-bay-2", business_id: "b-bay", quote_total_cents: 99500, payment_cents: 500, status: "approved", expires_at: approval.expires_at },
      quote: { id: "q-b-bay-2", business_id: "b-bay", total_cents: 99500, deposit_cents: 500, status: "current" },
      knownPayTo: null, existingPayment: null, spendCapCents: 500, now: NOW,
      challengeEmail: { business_id: "b-bay", sender_trusted: true, thread_matched: true },
    });
    expect(prepared).toMatchObject({ ok: true, amountBaseUnits: "5000000" });
  });
});
