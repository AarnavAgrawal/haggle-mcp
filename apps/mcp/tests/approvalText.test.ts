// Approval by text over SMS through the real webhook route (src/webhook.ts): the approval is texted
// to the human's number and a signed text.received "YES <code>" from that number approves it; the
// same text from any other number does nothing. Real engine in live configuration, fake Inkbox ports
// (iMessage off, as on the live server).
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, inkboxEmail, type PhonePort, type QuoteExtraction, type SmsPort } from "@haggle/engine";
import { BUYER, FakeInkbox, SECRET, signed } from "../../../packages/engine/tests/helpers/fakeInkbox.ts";
import { handleInkboxWebhook } from "../src/webhook.ts";
import type { Runtime } from "../src/runtime.ts";

const HUMAN = "+14155550188";
const event = (id: string, type: string, data: Record<string, unknown>) => JSON.stringify({ id, event_type: type, timestamp: new Date().toISOString(), data });
const textFrom = (id: string, from: string, text: string) => event(id, "text.received", { text_message: { id, direction: "inbound", remote_phone_number: from, text } });

function liveRuntime() {
  const api = new FakeInkbox();
  const repo = new InMemoryRepository();
  const texts: { to: string; text: string }[] = [];
  const sms: SmsPort = { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } };
  const phone: PhonePort = { async placeCall() { return { callId: "call_1" }; } };
  const extract = async (): Promise<QuoteExtraction> => ({
    available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
    total_usd: 1070, deposit_usd: 50, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 14 }], valid_until: null, questions: [],
    payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "call transcript", excerpt: "$1,070" }, { field: "deposit", source: "call transcript", excerpt: "$50 deposit" }], missing_fields: [], confidence: 0.9,
  });
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(api, BUYER), sms, phone, extractor: { extract }, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 50_000, maxRounds: 2, notifyPhone: HUMAN },
  });
  const rt: Runtime = { mode: "live", engine, missing: [], inkbox: { api, buyerMailbox: BUYER, webhookSecret: SECRET, senderTrust: { policy: "outbound-verified" }, transcript: async () => "remote: $1,070 total, 14 vegetarian, $50 deposit." } };
  return { rt, engine, repo, texts };
}

describe("approval by text (SMS) through the webhook", () => {
  it("the human gets the approval by text and approves with YES <code>; another number can't", async () => {
    const { rt, engine, repo, texts } = liveRuntime();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Mission Eats", phone: "+14155550104" }] });
    const ended = event("evt_c1", "call.ended", { call: { id: "call_1", direction: "outbound", remote_phone_number: "+14155550104" }, outcome: "completed", transcript: { entries: [{ party: "remote", text: "$1,070 total, 14 vegetarian, $50 deposit." }] } });
    expect((await handleInkboxWebhook(rt, ended, signed(ended))).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    const q = (await engine.getQuotes(deal.job_id)).quotes[0]!;
    expect(await engine.approvalReach(deal.job_id)).toEqual({ text: true, email: false });
    // The only business quoted, so quotes are final: Haggle texts "all quotes are in" with the code
    // itself; the approve tool (card plus a text) reuses that same approval, so no second text.
    const a = await engine.requestApproval(deal.job_id, q.quote_id, "view", undefined, { text: true });
    expect(texts.filter((x) => x.to === HUMAN)).toHaveLength(1);
    expect(texts.at(-1)).toMatchObject({ to: HUMAN, text: expect.stringMatching(new RegExp(`^Haggle: All quotes are in for lunch catering, 40 people, [A-Z][a-z]{2}, [A-Z][a-z]{2} \\d+ \\(1 quote\\)\\. Recommended: Mission Eats \\$1,070 \\(deposit \\$50\\)\\. See every option in Claude, or reply YES ${a.code} to approve the \\$50 deposit to Mission Eats \\(your assistant then pays it\\)\\.`)) });

    const stranger = textFrom("tx_s", "+14155550000", `YES ${a.code}`);
    expect((await handleInkboxWebhook(rt, stranger, signed(stranger))).outcome).toBe("unknown_sender");
    expect((await repo.getApproval(a.id))!.status).toBe("pending");

    const yes = textFrom("tx_y", HUMAN, `Yes ${a.code}`);
    expect(await handleInkboxWebhook(rt, yes, signed(yes))).toMatchObject({ status: 200, jobId: deal.job_id, outcome: "approved" });
    expect(await repo.getApproval(a.id)).toMatchObject({ status: "approved", approver: HUMAN });
    // Approve, then pay (decision 2): the text approves; nothing is charged until pay.
    expect((await engine.getQuotes(deal.job_id)).payment).toBeNull();
  });
});
