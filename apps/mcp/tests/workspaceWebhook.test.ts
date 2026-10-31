// POST /webhooks/inkbox/<handle> (HAGGLE_MAILBOX_PER_WORKSPACE): a workspace identity's mail events,
// verified with THAT identity's signing key (never the shared one), read from its own mailbox and
// matched only to its own deals. Real engine in live configuration, fake Inkbox; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, inkboxEmail, type QuoteExtraction } from "@haggle/engine";
import { BUYER, FakeInkbox, SECRET, signed } from "../../../packages/engine/tests/helpers/fakeInkbox.ts";
import { handleInkboxWebhook } from "../src/webhook.ts";
import type { Runtime } from "../src/runtime.ts";

const HANDLE = "hg-alpha-3f9a1c";
const WS_BOX = `${HANDLE}@inkboxmail.test`;
const WS_SECRET = "whsec_d29ya3NwYWNlLWFscGhhLWtleQ"; // fake test key gitleaks:allow
const VENDOR = "orders@valley.example";
const event = (id: string, type: string, data: Record<string, unknown>) => JSON.stringify({ id, event_type: type, timestamp: new Date().toISOString(), data });

function runtime() {
  const api = new FakeInkbox();
  const repo = new InMemoryRepository();
  const extract = async (i: { bodyText: string }): Promise<QuoteExtraction> => {
    const m = i.bodyText.match(/\$([\d,]+) total/);
    const total = m ? Number(m[1]!.replace(/,/g, "")) : null;
    return { available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: total, deposit_usd: null, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false, sources: total ? [{ field: "total", source: "email body", excerpt: `$${total} total` }] : [], missing_fields: total ? [] : ["total"], confidence: 0.9 };
  };
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(api, BUYER, { isWorkspaceMailbox: async (a) => a === WS_BOX }),
    mailboxes: { inboxFor: async (ws) => (ws === "ws_alpha" ? WS_BOX : null) },
    extractor: { extract }, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500_000, maxRounds: 1, externalSenders: "reply_token" },
  });
  const rt: Runtime = {
    mode: "live", engine, missing: [],
    inkbox: { api, buyerMailbox: BUYER, webhookSecret: SECRET, senderTrust: { policy: "outbound-verified" }, workspaceIdentity: async (h) => (h === HANDLE ? { workspace_id: "ws_alpha", mailbox: WS_BOX, webhook_secret: WS_SECRET } : null) },
  } as Runtime;
  return { rt, engine, repo, api };
}

describe("POST /webhooks/inkbox/<handle>: a workspace identity's mail", () => {
  it("verifies with that identity's key, reads its mailbox and stores the reply on its deal; the shared key and route don't verify it", async () => {
    const { rt, engine, repo, api } = runtime();
    await repo.insertWorkspace({ id: "ws_alpha", name: "Alpha", token_hash: null, connector_secret_hash: null, timezone: "UTC" });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Valley Catering", email: VENDOR }] });
    expect((await repo.getJob(deal.job_id))!.inbox).toBe(WS_BOX);
    expect(api.sent[0]!.mailbox).toBe(WS_BOX);
    const rfq = (await repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!;
    const reply = api.reply(VENDOR, rfq, "We can do it: $1,150 total.", [], { to: WS_BOX, recordOutbound: false });
    const raw = event("evt_ws_1", "message.received", { message: { id: reply.id }, agent_identities: [] });

    expect((await handleInkboxWebhook(rt, raw, signed(raw, { secret: WS_SECRET }), undefined, HANDLE)).status).toBe(200);
    expect((await repo.listMessages(deal.job_id)).find((m) => m.direction === "in")).toMatchObject({ sender_trusted: true, trust_reason: "external-thread-reply" });

    const raw2 = event("evt_ws_2", "message.received", { message: { id: reply.id }, agent_identities: [] });
    expect((await handleInkboxWebhook(rt, raw2, signed(raw2, { secret: SECRET }), undefined, HANDLE)).status).toBe(401); // the shared key
    expect((await handleInkboxWebhook(rt, raw2, signed(raw2, { secret: WS_SECRET }))).status).toBe(401); // the shared route
    expect((await handleInkboxWebhook(rt, raw2, signed(raw2, { secret: WS_SECRET }), undefined, "hg-unknown-000000")).status).toBe(404);
  });

  it("the stored reply makes the quote on the workspace's deal", async () => {
    const { rt, engine, repo, api } = runtime();
    await repo.insertWorkspace({ id: "ws_alpha", name: "Alpha", token_hash: null, connector_secret_hash: null, timezone: "UTC" });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Valley Catering", email: VENDOR }] });
    const rfq = (await repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!;
    const reply = api.reply(VENDOR, rfq, "We can do it: $1,150 total.", [], { to: WS_BOX, recordOutbound: false });
    const raw = event("evt_ws_3", "message.received", { message: { id: reply.id }, agent_identities: [] });
    const r = await handleInkboxWebhook(rt, raw, signed(raw, { secret: WS_SECRET }), undefined, HANDLE);
    expect(r).toMatchObject({ status: 200, jobId: deal.job_id, outcome: "stored" });
    await engine.advanceJob(deal.job_id);
    expect((await engine.getQuotes(deal.job_id)).quotes.map((q) => q.total_usd)).toEqual([1150]);
  });

  it("mail not addressed to the identity's mailbox, and non-mail events, are ignored there", async () => {
    const { rt, api } = runtime();
    const toShared = api.reply(VENDOR, "<x@inkbox.test>", "$1 total", [], { recordOutbound: false });
    const raw = event("evt_ws_4", "message.received", { message: { id: toShared.id }, agent_identities: [] });
    expect(await handleInkboxWebhook(rt, raw, signed(raw, { secret: WS_SECRET }), undefined, HANDLE)).toMatchObject({ status: 200, outcome: "not_for_buyer" });
    const call = event("evt_ws_5", "call.ended", { call_id: "c1", outcome: "completed", transcript: [] });
    expect(await handleInkboxWebhook(rt, call, signed(call, { secret: WS_SECRET }), undefined, HANDLE)).toMatchObject({ status: 200, outcome: "ignored_on_workspace_identity" });
  });
});
