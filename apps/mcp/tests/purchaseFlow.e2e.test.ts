// SIMULATED (sprint 5 A), through the real MCP HTTP layer (index.ts served in-process, bearer auth,
// live approval policy) over the in-memory store with fake email/SMS ports:
//   1. "tomorrow" said at 10:30 pm in San Francisco is the next San Francisco day (it was read in UTC:
//      two days out); a New York workspace reads it on its own calendar.
//   2. list_deals alone resumes a deal past approval: its purchase stage and next step, no board read.
// Nothing is real: no provider, database, vendor or payment.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HaggleEngine, InMemoryRepository, disabledPayer, vendorOwnWords, type ExtractorPort, type TrustVerdict } from "@haggle/engine";
import { createWorkspace, planWorkspace } from "../scripts/workspace-create.ts";
import { planAdmin, runAdmin } from "../scripts/workspace-admin.ts";
import { makeBrain } from "../src/brain.ts";
import { buildRoster, type ChannelStatus } from "../src/vendors.ts";
import type { Runtime } from "../src/runtime.ts";

const CH: ChannelStatus = { email: true, imessage: false, sms: true, phone: false, a2a: false, connectCommand: "connect @haggle", connected: null, callsViaSharedLine: false };
const LIVE_ENV = { HAGGLE_MODE: "live", HAGGLE_ENV: "development", INKBOX_API_KEY: "unused-in-this-test", INKBOX_WEBHOOK_SECRET: "unused-in-this-test", ANTHROPIC_API_KEY: "unused-in-this-test", SUPABASE_DB_URL: "postgres://unused@127.0.0.1:1/unused" };

const extractor: ExtractorPort = {
  async extract(i) {
    const t = vendorOwnWords(i.bodyText);
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+)\s*total/i);
    const deposit = money(/\$\s?([\d,]+)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_status: "included", tax_rate_percent: null, tax_evidence: "",
      total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 14 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : [], missing_fields: total === null ? ["total"] : [], confidence: 0.9,
      requirement_checks: (i.request.requirementList ?? []).map((r) => ({ requirement_id: r.id, met: true, evidence: "14 vegetarian, delivered by 11:00", note: "stated" })),
    } as never;
  },
};

const emails: { to: string; subject: string; bodyText: string }[] = [];
const texts: { to: string; text: string }[] = [];
const repo = new InMemoryRepository();
const brain = makeBrain([], { HAGGLE_BRAIN_STORE: "memory" });
const engine = new HaggleEngine({
  repo, now: () => new Date(), extractor, brain, payer: disabledPayer("payments are manual on this server"), attachments: { load: async () => [] },
  email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<out_${emails.length}@ses.haggle.test>` }; } },
  sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
  config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, manualPaymentHandoff: true },
});
const runtime: Runtime = { mode: "live", engine, brain, missing: [], roster: async () => buildRoster({}, CH), channels: async () => CH };

let server: { fetch: (r: Request) => Promise<Response> };
const saved: Record<string, string | undefined> = {};
let rid = 0;

async function call(token: string, tool: string, args: Record<string, unknown>) {
  const res = await server.fetch(new Request("http://haggle.test/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name: tool, arguments: args } }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
  }));
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : body);
  if (msg.error) throw new Error(`${tool}: ${JSON.stringify(msg.error)}`);
  return msg.result as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
}

async function workspace(name: string, timezone: string, approver: string, vendor: string) {
  const plan = planWorkspace({ name, approverPhone: approver, capUsd: 2500, area: "San Francisco, CA", timezone, baseUrl: "https://haggle.example" });
  await createWorkspace(plan, repo);
  await runAdmin(planAdmin(["add-vendor", "--id", plan.workspace.id, "--contact", vendor, "--name", "Harbor Table", "--consent", "Maria (owner) agreed by phone"]), repo);
  return plan.token;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(LIVE_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const rt = await import("../src/runtime.ts");
  server = (await import("../index.ts")).default as never;
  rt.resetRuntime();
  rt.registerLiveFactory(async () => runtime);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  (await import("../src/runtime.ts")).resetRuntime();
});

describe("SIMULATED: plain-language dates resolve on the workspace's calendar", () => {
  it("'tomorrow' at 10:30 pm in San Francisco is the next SF day; in New York (1:30 am) it is the day after", { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T05:30:00Z")); // Thu Oct 22, 10:30 pm PDT = Fri Oct 23, 1:30 am EDT
    const sf = await workspace("Tz SF Co", "America/Los_Angeles", "+14155550301", "events@harbor-sf.example");
    const ny = await workspace("Tz NY Co", "America/New_York", "+14155550302", "events@harbor-ny.example");
    const ask = { request: { what: "team lunch catering", quantity: "40 people", when: "tomorrow at 11:30am", delivery: "deliver to 500 Howard St by 11:30" }, budget: "under $2,500" };
    const a = await call(sf, "deal", ask);
    expect(a.isError).toBeFalsy();
    expect((await repo.getJob(a.structuredContent.job_id))!.request).toMatchObject({ date: "2026-10-23", time: "11:30" });
    const b = await call(ny, "deal", ask);
    expect((await repo.getJob(b.structuredContent.job_id))!.request).toMatchObject({ date: "2026-10-24" });
    // "today" late in the SF evening isn't "in the past" (UTC had already moved to the next day).
    const c = await call(sf, "deal", { ...ask, request: { ...ask.request, when: "today at 11:30pm" } });
    expect(c.isError).toBeFalsy();
    expect((await repo.getJob(c.structuredContent.job_id))!.request.date).toBe("2026-10-22");
  });
});

describe("SIMULATED: list_deals resumes a deal past approval without a board read", () => {
  it("shows the purchase stage and next step (awaiting the vendor; don't pay)", { timeout: 30_000 }, async () => {
    const APPROVER = "+14155550303";
    const VENDOR = "events@harbor-resume.example";
    const token = await workspace("Resume Co", "America/Los_Angeles", APPROVER, VENDOR);
    const d = await call(token, "deal", { request: { what: "team lunch catering", quantity: 40, date: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA" }, budget_usd: 2500 });
    const jobId = d.structuredContent.job_id as string;
    const out = (await repo.listMessages(jobId)).find((m) => m.direction === "out" && m.to_address === VENDOR)!;
    const trusted = (address: string): TrustVerdict => ({ trusted: true, address, reason: "inkbox-same-org", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }) as never;
    await engine.ingest({ providerEventId: "ev_r1", eventType: "message.received", providerEmailId: "in_r1", threadId: "th_r", messageId: "<r1@mail.example>", inReplyTo: [out.rfc_message_id!], references: [out.rfc_message_id!], from: VENDOR, to: ["haggle@inkboxmail.test"], subject: `Re: ${out.subject}`, bodyText: "$2,180 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    await engine.advanceJob(jobId);
    const board = await engine.getQuotes(jobId);
    const ap = await call(token, "approve", { job_id: jobId, quote_id: board.recommended_quote_id! });
    expect(ap.structuredContent.status).toBe("pending_human");
    const code = /YES (\d{4})/.exec(texts.filter((t) => t.to === APPROVER).at(-1)!.text)![1]!;
    expect((await engine.ingestText({ messageId: "yes_r1", from: APPROVER, text: `YES ${code}`, inbound: true })).outcome).toBe("approved");
    const list = await call(token, "list_deals", {});
    const deal = list.structuredContent.deals.find((x: { job_id: string }) => x.job_id === jobId);
    expect(deal.purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", next: expect.stringMatching(/Tell the human not to pay/) });
    expect(list.content[0]!.text).toMatch(/awaiting vendor confirmation: Approved by the human\. Waiting for Harbor Table to confirm/);
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`\\b${code}\\b`)); // the code never reaches the model
  });
});

describe("SIMULATED: the model can't cancel a vendor-confirmed booking (decision H3)", () => {
  it("cancel_deal only texts the approver a code; nothing is cancelled or sent until they reply CANCEL <code>", { timeout: 30_000 }, async () => {
    const APPROVER = "+14155550304";
    const VENDOR = "events@harbor-cancel.example";
    const token = await workspace("Cancel Co", "America/Los_Angeles", APPROVER, VENDOR);
    const d = await call(token, "deal", { request: { what: "team lunch catering", quantity: 40, date: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA" }, budget_usd: 2500 });
    const jobId = d.structuredContent.job_id as string;
    const trusted = (address: string): TrustVerdict => ({ trusted: true, address, reason: "inkbox-same-org", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }) as never;
    const reply = async (id: string, bodyText: string) => {
      const out = (await repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === VENDOR).at(-1)!;
      return engine.ingest({ providerEventId: `ev_${id}`, eventType: "message.received", providerEmailId: `in_${id}`, threadId: "th_c", messageId: `<${id}@mail.example>`, inReplyTo: [out.rfc_message_id!], references: [out.rfc_message_id!], from: VENDOR, to: ["haggle@inkboxmail.test"], subject: `Re: ${out.subject}`, bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
    };
    await reply("c1", "$2,180 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit.");
    await engine.advanceJob(jobId);
    await call(token, "approve", { job_id: jobId, quote_id: (await engine.getQuotes(jobId)).recommended_quote_id! });
    const yes = /YES (\d{4})/.exec(texts.filter((t) => t.to === APPROVER).at(-1)!.text)![1]!;
    expect((await engine.ingestText({ messageId: "yes_c1", from: APPROVER, text: `YES ${yes}`, inbound: true })).outcome).toBe("approved");
    expect((await reply("c2", "Confirmed, all set.")).outcome).toBe("booking_confirmed");
    const toVendor = emails.filter((e) => e.to === VENDOR).length;

    // Model-only sequence: cancel_deal, then cancel_deal again. Nothing is cancelled; the code never reaches the model.
    for (let i = 0; i < 2; i++) {
      const c = await call(token, "cancel_deal", { job_id: jobId });
      expect(c.isError).toBeFalsy();
      expect(c.structuredContent).toMatchObject({ state: "paying", needs_approver: true });
      expect(c.content[0]!.text).toMatch(/NOT cancelled yet/);
      const code = /CANCEL (\d{6})/.exec(texts.filter((t) => t.to === APPROVER).at(-1)!.text)![1]!;
      expect(JSON.stringify(c)).not.toContain(code);
    }
    expect((await repo.getJob(jobId))!.state).toBe("paying");
    expect(emails.filter((e) => e.to === VENDOR)).toHaveLength(toVendor);

    const code = /CANCEL (\d{6})/.exec(texts.filter((t) => t.to === APPROVER).at(-1)!.text)![1]!;
    expect((await engine.ingestText({ messageId: "cancel_c1", from: APPROVER, text: `CANCEL ${code}`, inbound: true })).outcome).toBe("cancelled");
    expect((await repo.getJob(jobId))!.state).toBe("cancelled");
    expect(emails.filter((e) => e.to === VENDOR).slice(toVendor).some((e) => /No payment was made/.test(e.bodyText))).toBe(true);
  });
});
