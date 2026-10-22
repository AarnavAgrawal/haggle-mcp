// Adversarial regression tests for approval and payment authorization (production audit 2026-10-21).
// The agent is the attacker: everything reachable through WorkspaceEngine (what MCP tools call) must
// fail to produce an approved approval or a charge. Only an out-of-band human answer (a coded text
// from the workspace approver's own phone) approves. Real engine, fake ports, no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig } from "../src/index.ts";
import { simulatedStripe } from "../src/payments/stripe.ts";

const ALPHA_PHONE = "+14155550101";
const BETA_PHONE = "+14155550202";
const OPERATOR_PHONE = "+14155550999";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const untrusted = () => ({ trusted: false as const, retryable: false as const, reason: "unverified-external-sender" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*total/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

async function setup(config: Partial<EngineConfig> = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const texts: { to: string; text: string }[] = [];
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const voice: string[] = [];
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), stripe: simulatedStripe(),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall() { return { callId: `call_${Math.random()}` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    voice: { async setInstructions(s: string) { voice.push(s); } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, notifyPhone: OPERATOR_PHONE, ...config,
    },
  });
  for (const [id, phone] of [["ws_alpha", ALPHA_PHONE], ["ws_beta", BETA_PHONE]] as const) {
    await repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await engine.updateSettings({ approver_phone: phone, spending_cap_cents: 150_000 }, id); // the operator
  }
  return { engine, repo, clock, texts, emails, voice };
}

/** A deal in `ws` with one firm quote ($1,150 total, $345 deposit) from Harbor Table. */
async function quotedIn(env: Awaited<ReturnType<typeof setup>>, ws: string, n = 1) {
  const agent = env.engine.forWorkspace(ws);
  const deal = await agent.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: `harbor${n}@inkboxmail.test` }] });
  const rfq = (await env.repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!;
  await env.engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `t${n}`, messageId: `<in_${n}@x>`, inReplyTo: [rfq], references: [rfq], from: `harbor${n}@inkboxmail.test`, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$1,150 total, 12 vegetarian, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
  await env.engine.advanceJob(deal.job_id);
  const q = (await agent.getQuotes(deal.job_id)).quotes.find((x) => x.business === "Harbor Table")!;
  return { agent, jobId: deal.job_id, quoteId: q.quote_id };
}

describe("model-only tool sequences can't authorize a purchase (live)", () => {
  it("a view-channel approval can't be approved with its code from a tool call (approve_in_view)", async () => {
    const env = await setup();
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "view");
    // Even holding the exact code (as a leaked _meta would give it), the tool path can't approve.
    await expect(agent.approveWithViewCode(a.id, a.code)).rejects.toMatchObject({ code: "approval_needs_human_channel" });
    expect((await env.repo.getApproval(a.id))!.status).toBe("pending");
    await expect(agent.pay(jobId, quoteId)).resolves.toMatchObject({ reason: "the human hasn't approved yet" });
  });

  it("the client's form and the simulated human aren't human approvals in live mode", async () => {
    const env = await setup();
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "elicitation");
    await expect(agent.decideApproval(a.id, "approve", "elicitation", "mcp-client:auto-accept")).rejects.toMatchObject({ code: "approval_needs_human_channel" });
    await expect(agent.decideApproval(a.id, "approve", "view", "human (approval view)")).rejects.toMatchObject({ code: "approval_needs_human_channel" });
    await expect(agent.decideApproval(a.id, "approve", "simulated", "DEMO")).rejects.toMatchObject({ code: "simulation_disabled" });
    expect((await env.repo.getApproval(a.id))!.status).toBe("pending");
  });

  it("the agent can't name its own email approver on deal", async () => {
    const env = await setup();
    const agent = env.engine.forWorkspace("ws_alpha");
    const deal = await agent.deal({ request, budget_usd, approver_email: "agent-inbox@attacker.example", businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    expect((await env.repo.getJob(deal.job_id))!.approver_email).toBeNull();
  });

  it("the agent can't change the approver or raise the spending cap through settings", async () => {
    const env = await setup();
    const agent = env.engine.forWorkspace("ws_alpha");
    await expect(agent.updateSettings({ approver_phone: "+14155550666" })).rejects.toMatchObject({ code: "approver_change_requires_operator" });
    await expect(agent.updateSettings({ approver_email: "agent@attacker.example" })).rejects.toMatchObject({ code: "approver_change_requires_operator" });
    await expect(agent.updateSettings({ spending_cap_cents: 400_000 })).rejects.toMatchObject({ code: "cap_increase_requires_operator" });
    expect(await agent.getSettings()).toMatchObject({ approver_phone: ALPHA_PHONE, approver_email: null, spending_cap_cents: 150_000 });
    // Lowering the cap and the default area stay self-service; re-sending the same approver is a no-op.
    await expect(agent.updateSettings({ spending_cap_cents: 100_000, default_area: "Oakland, CA", approver_phone: ALPHA_PHONE })).resolves.toMatchObject({ spending_cap_cents: 100_000, default_area: "Oakland, CA" });
  });

  it("email code approval is off unless the operator turns it on", async () => {
    const env = await setup();
    await env.engine.updateSettings({ approver_email: "boss@gmail.example" }, "ws_alpha");
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "email");
    const job = (await env.repo.getJob(jobId))!;
    const sent = (await env.repo.listMessages(jobId)).find((m) => m.kind === "approval_request" && m.channel === "email")!;
    // A spoofable From with the right code (from an untrusted mailbox) never approves by default.
    await env.engine.ingest({ providerEventId: "ea", eventType: "message.received", providerEmailId: "in_ea", threadId: "ta", messageId: "<ea@x>", inReplyTo: [sent.rfc_message_id!], references: [sent.rfc_message_id!], from: job.approver_email!, to: ["haggle@inkboxmail.test"], subject: `Re: [HG-${job.short_code}]`, bodyText: `APPROVE ${a.code}`, attachments: [], attachmentsDownloadUrl: null }, untrusted);
    expect((await env.repo.getApproval(a.id))!.status).toBe("pending");
  });

  it("the workspace spending cap is enforced on the payment, at approval and at pay time", async () => {
    const env = await setup();
    await env.engine.updateSettings({ spending_cap_cents: 30_000 }, "ws_alpha"); // $300 < $345 deposit
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    await expect(agent.requestApproval(jobId, quoteId, "imessage")).rejects.toMatchObject({ code: "over_cap" });
    // Cap lowered after a legitimate human approval: the charge is refused anyway.
    await env.engine.updateSettings({ spending_cap_cents: 150_000 }, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "imessage");
    expect(await env.engine.ingestText({ messageId: "yes1", from: ALPHA_PHONE, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
    await agent.updateSettings({ spending_cap_cents: 20_000 });
    await expect(agent.pay(jobId, quoteId)).rejects.toMatchObject({ code: "payment_refused_over_spend_cap" });
  });

  it("the legitimate path still works: the approver's coded text approves, then pay charges", async () => {
    const env = await setup();
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "imessage");
    expect(env.texts.at(-1)).toMatchObject({ to: ALPHA_PHONE });
    expect(await env.engine.ingestText({ messageId: "yes2", from: ALPHA_PHONE, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
    await expect(agent.pay(jobId, quoteId)).resolves.toMatchObject({ status: "settled", amount_usd: 345 });
  });
});

describe("workspace isolation of text approvals, notifications and the voice line", () => {
  it("each workspace's approvals go to its own approver; the operator's notify number never decides another workspace", async () => {
    const env = await setup();
    const beta = await quotedIn(env, "ws_beta", 2);
    const a = await beta.agent.requestApproval(beta.jobId, beta.quoteId, "imessage");
    expect(env.texts.filter((x) => x.text.includes(a.code)).map((x) => x.to)).toEqual([BETA_PHONE]);
    // Another workspace's approver and the operator's number can't approve it, even with the code.
    await env.engine.ingestText({ messageId: "x1", from: ALPHA_PHONE, text: `YES ${a.code}`, inbound: true });
    await env.engine.ingestText({ messageId: "x2", from: OPERATOR_PHONE, text: `YES ${a.code}`, inbound: true });
    expect((await env.repo.getApproval(a.id))!.status).toBe("pending");
    expect(await env.engine.ingestText({ messageId: "x3", from: BETA_PHONE, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
    // PAY from the wrong workspace's approver never charges.
    expect((await env.engine.ingestText({ messageId: "x4", from: ALPHA_PHONE, text: `PAY ${a.code}`, inbound: true })).outcome).toBe("pay_ignored_not_approver");
    expect(await env.repo.getPaymentForJob(beta.jobId)).toBeNull();
  });

  it("the shared voice line's instructions describe only the voice workspace's requests", async () => {
    const env = await setup({ voiceWorkspaceId: "ws_alpha" });
    await quotedIn(env, "ws_alpha", 3);
    const beta = await quotedIn(env, "ws_beta", 4);
    await new Promise((r) => setTimeout(r, 20)); // syncVoiceContext is fire-and-forget
    const job = (await env.repo.getJob(beta.jobId))!;
    const last = env.voice.at(-1)!;
    expect(last).not.toContain(`HG-${job.short_code}`);
    expect(last).not.toContain("harbor4@");
  });
});
