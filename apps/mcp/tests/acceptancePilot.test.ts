// SIMULATED pilot acceptance (sprint 4 B). The whole catering workflow a new operator-onboarded
// workspace runs, through the real MCP HTTP layer (index.ts served in-process by server.fetch:
// bearer auth, the live approval policy, the tool handlers), with no developer-only step:
//   operator: workspace-create planning + createWorkspace, three vendors with consent, show = PASS
//   agent (session A): one ordinary-language deal → wait → answer a vendor question → compare → approve
//   human: answers the question in chat, approves by text (YES <code>), pays the vendor directly, texts PAID
//   agent (session B, a new MCP session on the same credentials): list_deals → get_quotes → pay (handoff stage)
// Nothing is real: the engine runs in live mode over the in-memory store with fake email/SMS ports;
// vendor replies and the human's texts are injected where Inkbox webhooks would deliver them; a
// deterministic extractor stands in for Claude. No provider, database or network is touched.
// Measured and bounded: agent tool calls and human interventions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HaggleEngine, InMemoryRepository, disabledPayer, type ExtractorPort, type TrustVerdict } from "@haggle/engine";
import { vendorOwnWords } from "@haggle/engine";
import { createWorkspace, planWorkspace } from "../scripts/workspace-create.ts";
import { planAdmin, runAdmin } from "../scripts/workspace-admin.ts";
import { makeBrain } from "../src/brain.ts";
import { buildRoster, type ChannelStatus } from "../src/vendors.ts";
import type { Runtime } from "../src/runtime.ts";

const APPROVER = "+14155550123";
const SUNSET = "+14155550177";
const HARBOR = "events@harbortable.example";
const GRILL = "orders@goldengrill.example";
const SECRET = "acceptance-reply-token-secret-0123456789";
const CH: ChannelStatus = { email: true, imessage: false, sms: true, phone: false, a2a: false, connectCommand: "connect @haggle", connected: null, callsViaSharedLine: false };
const LIVE_ENV = { HAGGLE_MODE: "live", HAGGLE_ENV: "development", INKBOX_API_KEY: "unused-in-this-test", INKBOX_WEBHOOK_SECRET: "unused-in-this-test", ANTHROPIC_API_KEY: "unused-in-this-test", SUPABASE_DB_URL: "postgres://unused@127.0.0.1:1/unused" };

/** The event: about three weeks out, said the way a person says it ("Saturday, November 14 at 11:30am"). */
const EVENT = (() => { const d = new Date(Date.now() + 21 * 86_400_000); d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7)); return d; })();
const EVENT_ISO = EVENT.toISOString().slice(0, 10);
const EVENT_WORDS = `${EVENT.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })} at 11:30am`;
const MONTH_DAY = EVENT.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** Reads "$X total", "$Y deposit", "N vegetarian", "by HH:MM" and questions from the vendor's own words. */
const extractedFor: { headcount?: number; date?: string; location: string; requirements: string[] }[] = [];
const extractor: ExtractorPort = {
  async extract(i) {
    extractedFor.push(i.request as never);
    // A text reply comes with Haggle's last text for context: only the business's own words are read.
    const t = vendorOwnWords(i.bodyText.split("[The business's reply]: ").at(-1)!);
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:all[- ]in\s*)?total/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const veg = t.match(/(\d+)\s*vegetarian/i);
    const by = /deliver\w*[^.\n]{0,40}\bby (\d{1,2}:\d{2})/i.exec(t);
    const questions = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?")).map((text) => ({ text: text.trim(), needs_answer_to_quote: true }));
    const checks = (i.request.requirementList ?? []).map((r) => r.kind === "dietary"
      ? (veg ? { requirement_id: r.id, met: Number(veg[1]) >= (r.min_count ?? 0), evidence: veg[0], note: `offered ${veg[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" })
      : r.kind === "delivery" ? (by ? { requirement_id: r.id, met: by[1]!.padStart(5, "0") <= "11:30", evidence: by[0], note: `by ${by[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" })
      : { requirement_id: r.id, met: null, evidence: "", note: "not addressed" });
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null, tax_usd: null,
      tax_status: /tax incl|including tax/i.test(t) ? "included" : "not_mentioned", tax_rate_percent: null, tax_evidence: "", total_usd: total, deposit_usd: deposit, menu_items: [],
      dietary_coverage: veg ? [{ need: "vegetarian", covered: true, count_offered: Number(veg[1]) }] : [], valid_until: null, questions, payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9, requirement_checks: checks,
    } as never;
  },
};

let offset = 0;
const emails: { to: string; subject: string; bodyText: string }[] = [];
const texts: { to: string; text: string }[] = [];
const now = () => new Date(Date.now() + offset);
const repo = new InMemoryRepository({ now });
const brain = makeBrain([], { HAGGLE_BRAIN_STORE: "memory" });
const engine = new HaggleEngine({
  repo, now, extractor, brain, payer: disabledPayer("payments are manual on this server"), attachments: { load: async () => [] },
  email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<out_${emails.length}@ses.haggle.test>` }; } },
  sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
  config: {
    mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
    globalPaymentCapCents: 500_000, maxRounds: 1, manualPaymentHandoff: true, externalSenders: "reply_token", replyTokenSecret: SECRET, recipientAllowlist: [],
  },
});
const runtime: Runtime = { mode: "live", engine, brain, missing: [], roster: async () => buildRoster({}, CH), channels: async () => CH };

let server: { fetch: (r: Request) => Promise<Response> };
let saved: Record<string, string | undefined> = {};
let toolCalls = 0;
const humanSteps: string[] = [];
let rid = 0;

/** One JSON-RPC call over the MCP endpoint, as a client sends it. */
async function rpc(auth: string, method: string, params: Record<string, unknown>, session?: string) {
  const res = await server.fetch(new Request("http://haggle.test/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${auth}`, ...(session ? { "mcp-session-id": session } : {}) },
  }));
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : body);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return { result: msg.result, session: res.headers.get("mcp-session-id") ?? undefined };
}
/** A client session: initialize (its own session when the server issues one), then tool calls. */
async function connect(token: string, name: string) {
  const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
  const session = init.session;
  if (session) await server.fetch(new Request("http://haggle.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}`, "mcp-session-id": session } }));
  return {
    session,
    call: async (tool: string, args: Record<string, unknown>) => {
      toolCalls++;
      return (await rpc(token, "tools/call", { name: tool, arguments: args }, session)).result as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
    },
  };
}

let n = 0;
/** A vendor's email reply, as Inkbox would deliver it (outside mail proven only by Haggle's reply token). */
async function vendorEmail(from: string, body: string) {
  const ours = emails.filter((e) => e.to === from).at(-1)!;
  const out = (await repo.listMessages((await repo.listOpenJobs())[0]!.id)).filter((m) => m.direction === "out" && m.to_address === from).at(-1)!;
  const id = ++n;
  const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
  return engine.ingest({ providerEventId: `ev_${id}`, eventType: "message.received", providerEmailId: `in_${id}`, threadId: `th_${from}`, messageId: `<v${id}@mail.example>`, inReplyTo: [out.rfc_message_id!], references: [out.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText: body, attachments: [], attachmentsDownloadUrl: null }, external);
}
const vendorText = (from: string, text: string) => engine.ingestText({ messageId: `vt_${++n}`, from, text, inbound: true });
/** The human, on their own phone. */
const humanText = (text: string) => { humanSteps.push(`text: ${text.replace(/\d{4}/, "<code>")}`); return engine.ingestText({ messageId: `ht_${++n}`, from: APPROVER, text, inbound: true }); };

beforeAll(async () => {
  for (const [k, v] of Object.entries(LIVE_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const rt = await import("../src/runtime.ts");
  server = (await import("../index.ts")).default as never;
  // The live factory builds real Inkbox/Anthropic/Postgres clients; this test serves the same tools over a simulated runtime.
  rt.resetRuntime();
  rt.registerLiveFactory(async () => runtime);
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  (await import("../src/runtime.ts")).resetRuntime();
});

describe("SIMULATED pilot acceptance: onboarded workspace → catering request → approval by text → booking → handoff → PAID", () => {
  it("runs with no developer-only step, keeps every fact, and stays within the tool-call and human-step budgets", { timeout: 60_000 }, async () => {
    // ── Operator: onboard the workspace (the same code workspace-create / workspace-admin run). ──
    const plan = planWorkspace({ name: "Bay Events Co", approverPhone: APPROVER, capUsd: 2500, area: "San Francisco, CA", timezone: "America/Los_Angeles", baseUrl: "https://haggle.example" });
    const created = await createWorkspace(plan, repo);
    expect(created).toMatch(/Readiness: FAIL/);
    const admin = (...argv: string[]) => runAdmin(planAdmin(argv), repo);
    await admin("add-vendor", "--id", plan.workspace.id, "--contact", HARBOR, "--name", "Harbor Table", "--consent", "Maria (owner) agreed by phone");
    await admin("add-vendor", "--id", plan.workspace.id, "--contact", GRILL, "--name", "Golden Grill", "--consent", "Sam agreed by email");
    await admin("add-vendor", "--id", plan.workspace.id, "--contact", SUNSET, "--name", "Sunset Kitchen", "--consent", "Dev agreed in person", "--channel", "text");
    expect((await admin("show", "--id", plan.workspace.id)).text).toMatch(/Readiness: PASS \(5\/5 checks\)/);

    // ── Agent, session A: the user's request, in their words; vendors from the workspace roster. ──
    const a = await connect(plan.token, "pilot-agent-session-a");
    // Without credentials nothing but the handshake runs.
    await expect(rpc("hgw_wrong", "tools/list", {})).rejects.toThrow();
    const dealRes = await a.call("deal", {
      request: { what: "team offsite lunch catering", quantity: "60 people", when: EVENT_WORDS, delivery: "deliver to 500 Howard St by 11:30", dietary: "12 vegetarian" },
      budget: "under $2,500",
    });
    expect(dealRes.isError).toBeFalsy();
    const job = dealRes.structuredContent.job_id as string;
    expect(dealRes.content[0]!.text).toMatch(/^\[LIVE\] Deal .* started: team offsite lunch catering for 60/);
    expect(dealRes.content[0]!.text).toMatch(/Contacted 3: Harbor Table \[email\], Golden Grill \[email\], Sunset Kitchen \[imessage\]/);
    const stored = (await repo.getJob(job))!;
    expect(stored.request).toMatchObject({ quantity: 60, date: EVENT_ISO, time: "11:30", venue: "500 Howard St", area: "San Francisco, CA" });
    expect(stored.request.requirements.map((r) => r.text)).toEqual(["At least 12 vegetarian meals", "Deliver to 500 Howard St by 11:30"]);
    expect(stored.budget_cents).toBe(250_000);
    // Stage 1, the RFQ: every vendor is told headcount, day, place and the must-haves.
    for (const e of emails.filter((x) => [HARBOR, GRILL].includes(x.to))) {
      expect(e.bodyText).toMatch(/People: 60/);
      expect(e.bodyText).toContain(MONTH_DAY);
      expect(e.bodyText).toMatch(/500 Howard St/);
      expect(e.bodyText).toMatch(/At least 12 vegetarian meals/);
    }
    expect(texts.filter((x) => x.to === SUNSET)).toHaveLength(1);

    // ── Vendors reply (SIMULATED webhooks). Sunset asks a question first. ──
    offset += 6 * 60_000;
    expect((await vendorEmail(HARBOR, `Hi! For ${MONTH_DAY}: $2,180 total including delivery and tax, 14 vegetarian plates, delivered by 11:00. $500 deposit to hold the date.\n\nMaria`)).outcome).toBe("stored");
    expect((await vendorEmail(GRILL, "we can do 60 for $1,650 total, delivered by 11:00, tax incl. only 6 vegetarian tho.")).outcome).toBe("stored");
    expect((await vendorText(SUNSET, "Hi! Do you want the food buffet-style or individually boxed?")).outcome).toBe("stored");

    // The wait already carries the question (id and words): no board read is needed to answer it.
    let w = await a.call("wait_for_update", { job_id: job, timeout_s: 0 });
    const question = w.structuredContent.updates.find((u: { type: string; text?: string }) => u.type === "question" && /buffet-style/.test(u.text ?? ""));
    expect(question.text).toMatch(/buffet-style or individually boxed/);
    expect((await engine.getQuotes(job)).open_questions.find((q) => q.question_id === question.question_id)?.business).toBe("Sunset Kitchen");
    // The agent asks the user in chat (it never guesses), then relays the answer in Sunset's own thread.
    humanSteps.push("chat: answers the vendor's question (individually boxed)");
    expect((await a.call("answer_business", { job_id: job, question_id: question.question_id, answer: "Individually boxed, please." })).isError).toBeFalsy();
    expect(texts.filter((x) => x.to === SUNSET).at(-1)!.text).toMatch(/Individually boxed/);
    offset += 4 * 60_000;
    expect((await vendorText(SUNSET, "Great, boxed it is: $2,300 total incl tax, 12 vegetarian, delivered by 11:15, $400 deposit.")).outcome).toBe("stored");

    // Quotes close (the collection window), then the agent compares.
    offset += 31 * 60_000;
    w = await a.call("wait_for_update", { job_id: job, until: "ready", timeout_s: 0 });
    // Quotes are final; Haggle already texted the human its recommendation (the approve call below claims that same approval).
    expect(w.structuredContent.state).toMatch(/collecting|negotiating|awaiting_approval/);
    let board = (await a.call("get_quotes", { job_id: job, detail: true })).structuredContent;
    expect(board.ready).toBe(true);
    const q = (name: string) => board.quotes.find((x: { business: string; status: string }) => x.business === name && x.status === "current");
    // Stage 2a, extraction: every reply was read against the same headcount, day and must-haves.
    expect(extractedFor.length).toBeGreaterThanOrEqual(3);
    for (const r of extractedFor) expect(r).toMatchObject({ headcount: 60, date: EVENT_ISO, requirements: ["At least 12 vegetarian meals", "Deliver to 500 Howard St by 11:30"] });
    // Stage 2b, the comparison: the cheaper noncompliant quote never wins.
    expect(q("Golden Grill")).toMatchObject({ total_usd: 1650 });
    expect(board.compliance[q("Golden Grill").quote_id]).toMatchObject({ status: "noncompliant", issues: [{ text: expect.stringMatching(/only 6 of 12/) }] });
    expect(q("Harbor Table")).toMatchObject({ total_usd: 2180, deposit_usd: 500 });
    expect(board.compliance[q("Harbor Table").quote_id].status).toBe("compliant");
    expect(q("Sunset Kitchen")).toMatchObject({ total_usd: 2300 });
    expect(board.recommended_quote_id).toBe(q("Harbor Table").quote_id);
    // ...and each quote says why it was or wasn't selected (engine board; get_quotes surfaces it once workstream E maps it, see the report).
    const why = Object.fromEntries((await engine.getQuotes(job)).quotes.filter((x) => x.status === "current").map((x) => [x.business, x.selection]));
    expect(why["Harbor Table"]).toMatchObject({ status: "recommended" });
    expect(why["Golden Grill"]).toMatchObject({ status: "selectable", reason: expect.stringMatching(/misses a must: doesn't meet: At least 12 vegetarian meals/) });
    expect(why["Sunset Kitchen"]).toMatchObject({ status: "selectable", reason: expect.stringMatching(/ranked below Harbor Table on value/) });
    expect(board.request_details).toMatchObject({ headcount: 60, budget_usd: 2500, requirements: ["At least 12 vegetarian meals", "Deliver to 500 Howard St by 11:30"] });
    expect(board.request_details.when).toContain(MONTH_DAY);
    expect(board.request_details.place).toMatch(/500 Howard St/);

    // ── Approval: the agent asks; only the human's coded text approves. ──
    const ap = await a.call("approve", { job_id: job, quote_id: board.recommended_quote_id });
    expect(ap.isError).toBeFalsy();
    expect(ap.structuredContent.status).toBe("pending_human");
    expect(ap.content[0]!.text).toMatch(/reply YES <code>/);
    expect(JSON.stringify(ap)).not.toMatch(/YES \d{4}/); // the code never reaches the model
    // Stage 3, the approval text: headcount and day ride along; on this server it never says PAY charges.
    const approvalText = texts.filter((x) => x.to === APPROVER).filter((x) => /YES \d{4}/.test(x.text)).at(-1)!;
    expect(approvalText.text).toMatch(/60 people/);
    expect(approvalText.text).toMatch(/Harbor Table/);
    expect(approvalText.text).not.toMatch(/PAY \d{4} to charge/);
    const code = /YES (\d{4})/.exec(approvalText.text)![1]!;
    expect((await humanText(`YES ${code}`)).outcome).toBe("approved");

    // Stage 4, the booking request: the vendor confirms the same facts in writing before anyone pays.
    const bookingAsk = emails.filter((e) => e.to === HARBOR).at(-1)!;
    expect(bookingAsk.bodyText).toMatch(/Before anything is booked or paid, please reply to confirm/);
    expect(bookingAsk.bodyText).toMatch(/team offsite lunch catering, 60 people/);
    expect(bookingAsk.bodyText).toContain(MONTH_DAY);
    expect(bookingAsk.bodyText).toMatch(/500 Howard St/);
    expect(bookingAsk.bodyText).toMatch(/must-have: At least 12 vegetarian meals; Deliver to 500 Howard St by 11:30/);
    expect(bookingAsk.bodyText).not.toMatch(/\$2,500|budget/i); // the budget is never disclosed to a vendor
    // The agent's one wait after approve: the human decided, and the next step (the vendor confirms; don't pay) comes with it.
    w = await a.call("wait_for_update", { job_id: job, until: "approval_decided", timeout_s: 0 });
    expect(w.structuredContent.state).toBe("paying");
    expect(w.structuredContent.next).toMatch(/Waiting for Harbor Table to confirm.*Tell the human not to pay/);
    expect((await engine.getQuotes(job)).purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false, money_verified: false });
    // A PAID text before the vendor confirms records nothing.
    expect((await engine.ingestText({ messageId: "early_paid", from: APPROVER, text: `PAID ${code}`, inbound: true })).outcome).toBe("paid_before_booking");

    offset += 90 * 60_000;
    expect((await vendorEmail(HARBOR, `Confirmed! We're all set for ${MONTH_DAY}, 60 guests, 14 vegetarian, delivered to 500 Howard St by 11:00.\nFor the $500 deposit, Zelle payments@harbortable.example.\n\nMaria`)).outcome).toBe("booking_unverified");
    // Harbor's email is proven only by Haggle's reply token (outside mail): its "confirmed" doesn't bind the
    // booking by itself. The human checks with Harbor and accepts it by text.
    expect(texts.filter((x) => x.to === APPROVER).at(-1)!.text).toMatch(/can't verify that email came from them.*reply BOOKED/);
    expect((await humanText(`BOOKED ${code}`)).outcome).toBe("booking_confirmed");

    // ── Agent, session B: a new conversation resumes the deal from the same workspace credentials. ──
    const b = await connect(plan.token, "pilot-agent-session-b");
    // list_deals alone resumes it: the purchase stage, the vendor's instructions (untrusted text) and the next step.
    const deals = await b.call("list_deals", {});
    const resumed = deals.structuredContent.deals.find((d: { job_id: string }) => d.job_id === job);
    expect(resumed.purchase).toMatchObject({ stage: "instructions_received", instructions: { untrusted: true, text: expect.stringMatching(/Zelle payments@harbortable\.example/) } });
    expect(resumed.purchase.next).toMatch(/verify them with Harbor Table independently before paying; after paying they reply PAID <code>/);
    // The vendor's own words stay out of the model's text (they may carry instructions): only a pointer.
    expect(deals.content[0]!.text).toMatch(/vendor's payment instructions received: untrusted business text in structuredContent/);
    expect(deals.content[0]!.text).not.toMatch(/Zelle payments@harbortable/);
    // Stage 5, the handoff: the order and its must-haves, the vendor's instructions as untrusted text.
    board = (await engine.getQuotes(job)) as never;
    expect(board.purchase).toMatchObject({ stage: "instructions_received", booked: true, money_verified: false, instructions: { untrusted: true } });
    const purchase = (await engine.getQuotes(job)).purchase!; // order / must_haves: engine board (E maps them into get_quotes, see the report)
    expect(purchase.order).toMatch(new RegExp(`team offsite lunch catering, 60 people, .*${MONTH_DAY}.*500 Howard St`));
    expect(purchase.must_haves).toBe("At least 12 vegetarian meals; Deliver to 500 Howard St by 11:30");
    // No pay call: on the manual rail it would only repeat this stage (pay's output is covered in purchaseOutput.test.ts).
    expect(q("Harbor Table").quote_id).toBe(board.recommended_quote_id ?? q("Harbor Table").quote_id);
    // The vendor's details came by email proven only by thread continuity: the human checks them by phone.
    expect(texts.filter((x) => x.to === APPROVER).some((x) => /confirm them with Harbor Table by phone before paying/.test(x.text))).toBe(true);

    // ── The human pays Harbor directly and texts PAID. ──
    humanSteps.push("pays Harbor Table $500 directly (outside Haggle)");
    expect((await humanText(`PAID ${code}`)).outcome).toBe("handoff_confirmed");
    w = await b.call("wait_for_update", { job_id: job, timeout_s: 0 });
    expect(w.structuredContent.state).toBe("paid");
    expect(w.structuredContent.next).toMatch(/The customer reports paying Harbor Table \$500 deposit directly\. Haggle hasn't verified/);
    expect((await engine.getQuotes(job)).purchase).toMatchObject({ stage: "human_reported_paid", money_verified: false });
    // Stage 6, the closing note to the vendor names the order; it claims only what the human reported.
    const closing = emails.filter((e) => e.to === HARBOR).at(-1)!;
    expect(closing.bodyText).toMatch(/team offsite lunch catering, 60 people/);
    expect(closing.bodyText).toMatch(/The customer has told us they have paid the \$500\.00 directly to you/);
    // Golden Grill and Sunset were never accepted.
    expect(emails.filter((e) => e.to === GRILL).some((e) => /accepted your quote/.test(e.bodyText))).toBe(false);
    expect(texts.filter((x) => x.to === SUNSET).some((x) => /accepted your/.test(x.text))).toBe(false);

    // ── Measured: agent tool calls and human interventions (upper bounds). ──
    console.log(`[SIMULATED acceptance] agent tool calls: ${toolCalls}; human interventions: ${humanSteps.length} (${humanSteps.join("; ")}); sessions: ${a.session ? "2 distinct" : "stateless"}`);
    // Sprint 4 baseline: 12 (a board read to find the question, one after approve, one on resume, a pay
    // that only repeated the stage, one at the end). Now: deal, wait, answer, wait, get_quotes, approve,
    // wait (decided), list_deals (resumes with the stage), wait (reported paid) = 9.
    expect(toolCalls).toBeLessThanOrEqual(9);
    expect(humanSteps.filter((s) => !s.startsWith("pays"))).toHaveLength(4); // answer the question, YES, BOOKED (unverifiable sender), PAID
    expect(humanSteps.length).toBeLessThanOrEqual(5);
    if (a.session && b.session) expect(a.session).not.toBe(b.session);
  });
});
