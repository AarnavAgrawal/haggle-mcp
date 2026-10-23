// Approvals and the purchase lifecycle decided by the signed-in account owner in the Haggle web app
// (channel "web", recorded as web:<actor>). Reached only through the engine's web methods (the
// service-token routes); the MCP tool paths (WorkspaceEngine) refuse in-band approvals on live servers
// exactly as before. Real engine on a live, manual-handoff config; fake ports, no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig } from "../src/index.ts";

const ALPHA_PHONE = "+14155550101";
const BETA_PHONE = "+14155550202";
const OWNER = "ada@example.com";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

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
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, manualPaymentHandoff: true, ...config,
    },
  });
  for (const [id, phone] of [["ws_alpha", ALPHA_PHONE], ["ws_beta", BETA_PHONE]] as const) {
    await repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await engine.updateSettings({ approver_phone: phone, spending_cap_cents: 150_000 }, id);
  }
  return { engine, repo, clock, texts, emails };
}
type Env = Awaited<ReturnType<typeof setup>>;

let n = 0;
async function mail(env: Env, jobId: string, from: string, bodyText: string) {
  const ours = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === from).at(-1)!;
  const id = ++n;
  return env.engine.ingest({ providerEventId: `e${id}`, eventType: "message.received", providerEmailId: `in_${id}`, threadId: `t_${from}_${jobId}`, messageId: `<in_${id}@x>`, inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
}

/** A live deal in `ws` with one firm quote ($1,150 total, $345 deposit) from Harbor Table. */
async function quotedIn(env: Env, ws = "ws_alpha") {
  const agent = env.engine.forWorkspace(ws);
  const vendor = `harbor${++n}@inkboxmail.test`;
  const deal = await agent.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: vendor }] });
  await mail(env, deal.job_id, vendor, "$1,150 total, 12 vegetarian, delivered. $345 deposit.");
  await env.engine.advanceJob(deal.job_id);
  const q = (await agent.getQuotes(deal.job_id)).quotes.find((x) => x.business === "Harbor Table")!;
  return { agent, jobId: deal.job_id, quoteId: q.quote_id, vendor };
}

const noCodeIn = (v: unknown, code: string) => expect(JSON.stringify(v)).not.toContain(code);

describe("web approvals (the account owner's click, channel web)", () => {
  it("request opens a pending web approval without texting a code; approve records web:<actor>; a repeat is a no-op", async () => {
    const env = await setup();
    const { jobId, quoteId } = await quotedIn(env);
    const textsBefore = env.texts.length;
    const r = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    // A fresh web approval, or Haggle's own pending "all quotes are in" suggestion for this quote, claimed.
    expect(r.approval).toMatchObject({ status: "pending", payment_cents: 34_500, quote_total_cents: 115_000 });
    expect(["web", "imessage"]).toContain(r.approval.channel);
    expect(r.business).toBe("Harbor Table");
    // Nothing went to the approver's phone carrying the code.
    for (const t of env.texts.slice(textsBefore)) expect(t.text).not.toContain(r.approval.code);
    // Same quote again: the same approval.
    expect((await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER)).approval.id).toBe(r.approval.id);

    const d = await env.engine.decideWebApproval("ws_alpha", r.approval.id, "approve", OWNER);
    expect(d.changed).toBe(true);
    expect(d.approval).toMatchObject({ status: "approved", channel: "web", approver: `web:${OWNER}` });
    expect(d.job.state).toBe("paying");
    const again = await env.engine.decideWebApproval("ws_alpha", r.approval.id, "approve", OWNER);
    expect(again).toMatchObject({ changed: false, approval: { status: "approved" } });
    await expect(env.engine.decideWebApproval("ws_alpha", r.approval.id, "decline", OWNER)).rejects.toMatchObject({ code: "approval_approved" });
    // A repeated request after approval returns the recorded approval, not an error.
    expect((await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER)).approval.status).toBe("approved");
    // Manual rail: the booking request went to the vendor; the next step says to wait for it.
    const next = await env.engine.webNext(jobId);
    expect(next).toMatchObject({ state: "paying", stage: "awaiting_vendor_confirmation" });
    noCodeIn(next, r.approval.code);
  });

  it("decline records web:<actor> and frees the job", async () => {
    const env = await setup();
    const { jobId, quoteId } = await quotedIn(env);
    const { approval } = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    const d = await env.engine.decideWebApproval("ws_alpha", approval.id, "decline", OWNER);
    expect(d.approval).toMatchObject({ status: "declined", channel: "web", approver: `web:${OWNER}` });
    await expect(env.engine.decideWebApproval("ws_alpha", approval.id, "approve", OWNER)).rejects.toMatchObject({ code: "approval_declined" });
  });

  it("refuses another workspace's job or approval (not found), a missing actor, and an expired approval", async () => {
    const env = await setup();
    const { jobId, quoteId } = await quotedIn(env, "ws_alpha");
    await expect(env.engine.requestWebApproval("ws_beta", jobId, quoteId, undefined, OWNER)).rejects.toMatchObject({ code: "job_not_found" });
    const { approval } = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    await expect(env.engine.decideWebApproval("ws_beta", approval.id, "approve", OWNER)).rejects.toMatchObject({ code: "approval_not_found" });
    await expect(env.engine.decideWebApproval("ws_alpha", approval.id, "approve", null)).rejects.toMatchObject({ code: "actor_required" });
    await expect(env.engine.decideWebApproval("ws_alpha", approval.id, "approve", "  ")).rejects.toMatchObject({ code: "actor_required" });
    expect((await env.repo.getApproval(approval.id))!.status).toBe("pending");
    env.clock.advance(31 * 60_000);
    await expect(env.engine.decideWebApproval("ws_alpha", approval.id, "approve", OWNER)).rejects.toMatchObject({ code: "approval_expired" });
  });

  it("the web channel is reachable only through the web path; webApprovals=false refuses it", async () => {
    const env = await setup();
    const { agent, jobId, quoteId } = await quotedIn(env);
    const { approval } = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    // decideApproval with channel "web" but not from decideWebApproval: refused.
    await expect(env.engine.decideApproval(approval.id, "approve", "web", "web:someone")).rejects.toMatchObject({ code: "web_approvals_off" });
    // The MCP tool paths are unchanged on a live server: no in-band approval.
    await expect(agent.decideApproval(approval.id, "approve", "view", "human (approval view)")).rejects.toMatchObject({ code: "approval_needs_human_channel" });
    await expect(agent.decideApproval(approval.id, "approve", "elicitation", "mcp-client:x")).rejects.toMatchObject({ code: "approval_needs_human_channel" });
    await expect(agent.approveWithViewCode(approval.id, approval.code)).rejects.toMatchObject({ code: "approval_needs_human_channel" });
    expect((await env.repo.getApproval(approval.id))!.status).toBe("pending");

    const off = await setup({ webApprovals: false });
    const q = await quotedIn(off);
    await expect(off.engine.requestWebApproval("ws_alpha", q.jobId, q.quoteId, undefined, OWNER)).rejects.toMatchObject({ code: "web_approvals_off" });
    const a = await off.engine.requestApproval(q.jobId, q.quoteId, "imessage");
    await expect(off.engine.decideWebApproval("ws_alpha", a.id, "approve", OWNER)).rejects.toMatchObject({ code: "web_approvals_off" });
    await expect(off.engine.reportPaidByWeb("ws_alpha", q.jobId, OWNER)).rejects.toMatchObject({ code: "web_approvals_off" });
  });

  it("choosing another option replaces an undecided approval (its code can never approve); a decided one is never replaced", async () => {
    const env = await setup();
    const { jobId, quoteId } = await quotedIn(env);
    const first = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    // Same deal, confirm-only instead of pay: replaces the pending pay approval.
    const confirm = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, "confirm", OWNER);
    expect(confirm.approval.id).not.toBe(first.approval.id);
    expect(confirm.approval.action).toBe("confirm");
    expect((await env.repo.getApproval(first.approval.id))!.status).toBe("expired");
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "approval_superseded" && e.data.approval_id === first.approval.id)).toBe(true);
    await expect(env.engine.decideWebApproval("ws_alpha", first.approval.id, "approve", OWNER)).rejects.toMatchObject({ code: "approval_expired" });
    // Decided: a later request for another action doesn't replace it.
    await env.engine.decideWebApproval("ws_alpha", confirm.approval.id, "approve", OWNER);
    expect((await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, "pay", OWNER)).approval).toMatchObject({ id: confirm.approval.id, status: "approved", action: "confirm" });
    expect((await env.repo.getApproval(confirm.approval.id))!.status).toBe("approved");
  });

  it("an approval the agent opened (texted YES <code>) can be decided in the web app instead; the text then answers truthfully", async () => {
    const env = await setup();
    const { jobId, quoteId } = await quotedIn(env);
    const texted = await env.engine.requestApproval(jobId, quoteId, "imessage");
    const r = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    expect(r.approval.id).toBe(texted.id);
    expect((await env.engine.decideWebApproval("ws_alpha", texted.id, "approve", OWNER)).approval).toMatchObject({ status: "approved", channel: "web" });
  });
});

describe("the purchase from the web app (manual handoff)", () => {
  it("approve → vendor confirms with instructions → I've paid → reported paid, once; recorded as web:<actor>", async () => {
    const env = await setup();
    const { jobId, quoteId, vendor } = await quotedIn(env);
    const { approval } = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    await env.engine.decideWebApproval("ws_alpha", approval.id, "approve", OWNER);
    // Before the vendor confirms: refused, nothing recorded as paid.
    await expect(env.engine.reportPaidByWeb("ws_alpha", jobId, OWNER)).rejects.toMatchObject({ code: "paid_before_booking" });
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");

    expect((await mail(env, jobId, vendor, "Confirmed. Zelle us at pay@harbor.")).outcome).toBe("booking_confirmed");
    const before = await env.engine.webNext(jobId);
    expect(before.stage).toBe("instructions_received");
    noCodeIn(before, approval.code);

    await expect(env.engine.reportPaidByWeb("ws_beta", jobId, OWNER)).rejects.toMatchObject({ code: "job_not_found" });
    await expect(env.engine.reportPaidByWeb("ws_alpha", jobId, null)).rejects.toMatchObject({ code: "actor_required" });
    expect(await env.engine.reportPaidByWeb("ws_alpha", jobId, OWNER)).toEqual({ outcome: "reported" });
    expect((await env.repo.getHandoffByApproval(approval.id))).toMatchObject({ status: "human_confirmed", confirmed_by: `web:${OWNER}` });
    expect((await env.repo.getApproval(approval.id))!.status).toBe("used");
    expect((await env.repo.getJob(jobId))!.state).toBe("paid");
    expect((await env.engine.webNext(jobId)).stage).toBe("human_reported_paid");
    expect(await env.engine.reportPaidByWeb("ws_alpha", jobId, OWNER)).toEqual({ outcome: "already_reported" });
  });

  it("cancel from the web app cancels a booking the vendor confirmed (no CANCEL code needed); the agent's cancel still only asks", async () => {
    const env = await setup();
    const { agent, jobId, quoteId, vendor } = await quotedIn(env);
    const { approval } = await env.engine.requestWebApproval("ws_alpha", jobId, quoteId, undefined, OWNER);
    await env.engine.decideWebApproval("ws_alpha", approval.id, "approve", OWNER);
    await mail(env, jobId, vendor, "Confirmed. Zelle us at pay@harbor.");
    expect(await agent.cancel(jobId)).toMatchObject({ state: "paying", needs_approver: true });
    await expect(env.engine.cancelByWeb("ws_beta", jobId, OWNER)).rejects.toMatchObject({ code: "job_not_found" });
    expect(await env.engine.cancelByWeb("ws_alpha", jobId, OWNER)).toMatchObject({ state: "cancelled" });
    expect((await env.repo.getBookingByApproval(approval.id))!.status).toBe("cancelled");
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "cancel_auth_decided" && e.data.decision === "superseded")).toBe(true);
    expect((await env.repo.listEvents(jobId)).find((e) => e.type === "cancel_authorized")?.data.by).toBe(`web:${OWNER}`);
  });

  it("report paid is refused off the manual rail; accept-booking is refused with nothing pending", async () => {
    const env = await setup({ manualPaymentHandoff: false });
    const { jobId } = await quotedIn(env);
    await expect(env.engine.reportPaidByWeb("ws_alpha", jobId, OWNER)).rejects.toMatchObject({ code: "not_manual_rail" });
    const manual = await setup();
    const q = await quotedIn(manual);
    await expect(manual.engine.acceptBookingByWeb("ws_alpha", q.jobId, OWNER)).rejects.toMatchObject({ code: "no_booking" });
  });
});

describe("callbacks from the web app", () => {
  it("needs a justified proposal and the callee's consent, like every callback", async () => {
    const env = await setup();
    const { jobId } = await quotedIn(env);
    const harbor = (await env.repo.getBusinesses(jobId))[0]!.business_id;
    await expect(env.engine.authorizeCallbackByWeb("ws_beta", jobId, harbor, OWNER)).rejects.toMatchObject({ code: "job_not_found" });
    await expect(env.engine.authorizeCallbackByWeb("ws_alpha", jobId, harbor, OWNER)).rejects.toMatchObject({ code: expect.stringMatching(/callback_not_justified|no_rounds_left|callback_no_consent/) });
  });
});
