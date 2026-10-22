// The operator report's "what needs a person right now" view (ops/report.ts attention + --brief), over a
// FIXED fake clock: stalled jobs, quarantined emails (masked sender, plain-English reason, the
// release/reject command), pending and expired approvals, unresolved bookings (awaiting the vendor,
// the vendor's unverified claim waiting for the approver's BOOKED, not-in-writing awaiting
// attestation), payment handoffs (instructions requested, customer reported paid with no receipt),
// pending CALL / CANCEL authorizations and held ambiguous texts. Real engine in live mode on the manual
// rail over the in-memory store; fake ports record what would be sent. Nothing real is contacted.
import { describe, expect, it } from "vitest";
import { buildOpsReport, disabledPayer, formatOpsBrief, formatOpsReport, HaggleEngine, InMemoryRepository, StubBrain, type Repository } from "../src/index.ts";
import { pilotExtractor } from "./helpers/pilotExtractor.ts";

const T0 = Date.parse("2026-10-22T16:00:00Z");
const APPROVER = "+14155550101";
const TEXT_VENDOR = "+14155550177";
const PHONE_VENDOR = "+14155550188";
const MISSION = "+14155550142";
const GRILL = "+14085550123";
const BETA_HUMAN = "+14155550202";
const H = 3_600_000;
const M = 60_000;
const REQUEST = { what: "team lunch catering", quantity: 40, unit: "people", date: "2026-11-14", time: "11:30", area: "San Francisco, CA", venue: "500 Howard St", requirements: ["At least 12 vegetarian meals"] as never };

const WRITES = /^(insert|update|add|remove|save|set|claim|reclaim|finish|rearm|open|resolve|transition|record|append|touch|cas|acquire|release|renew|answer|hold|take|mark|advance)/;
const readOnly = (repo: Repository) => new Proxy(repo, { get(t, p, r) { const v = Reflect.get(t, p, r); return typeof v === "function" && typeof p === "string" && WRITES.test(p) ? () => { throw new Error(`write ${p} during the report`); } : typeof v === "function" ? v.bind(t) : v; } });

function setup() {
  let t = T0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const calls: { toNumber: string; reason: string }[] = [];
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: pilotExtractor, brain: new StubBrain(), payer: disabledPayer("payments are manual on this server"), attachments: { load: async () => [] },
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<out_${emails.length}@ses.haggle.test>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    imessage: { async send(r) { texts.push(r); return { messageId: `im_${texts.length}` }; } },
    phone: { async placeCall(r) { calls.push(r as never); return { callId: `call_${calls.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * M, negotiationWindowMs: 10 * M, approvalTtlMs: 30 * M,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, manualPaymentHandoff: true, callCooldownMs: 0,
    },
  });
  return { engine, repo, clock, emails, texts, calls };
}
type Env = ReturnType<typeof setup>;
let n = 0;

const trusted = (address: string) => ({ trusted: true, address, reason: "inkbox-same-org", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }) as never;
async function emailReply(env: Env, jobId: string, to: string, body: string, from = to) {
  const ours = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === to).at(-1)!;
  const id = ++n;
  return env.engine.ingest({
    providerEventId: `oev_${id}`, eventType: "message.received", providerEmailId: `oin_${id}`, threadId: `th_${to}`, messageId: `<o${id}@mail.example>`,
    inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText: body, attachments: [], attachmentsDownloadUrl: null,
  }, (address: string) => trusted(address));
}
const approverText = (env: Env, text: string) => env.engine.ingestText({ messageId: `oap_${++n}`, from: APPROVER, text, inbound: true });
/** The code from the latest text to the approver that carried one of this kind (never from the report or a tool). */
const lastCode = (env: Env, re: RegExp) => {
  const hit = env.texts.filter((x) => x.to === APPROVER).map((x) => re.exec(x.text)?.[1]).filter(Boolean).at(-1);
  expect(hit).toMatch(/^\d{4,6}$/);
  return hit!;
};

/** A deal with these email vendors; each replies with a quote; collection closes. */
async function emailDeal(env: Env, vendors: { name: string; email: string; reply?: string }[], extra: Record<string, unknown> = {}) {
  const deal = await env.engine.deal({ request: REQUEST, budget_usd: 2500, businesses: vendors.map((v) => ({ name: v.name, email: v.email })), ...extra } as never);
  env.clock.advance(5 * M);
  for (const v of vendors) if (v.reply) await emailReply(env, deal.job_id, v.email, v.reply);
  env.clock.advance(31 * M);
  await env.engine.advanceJob(deal.job_id);
  const quotes = (await env.engine.getQuotes(deal.job_id)).quotes;
  return { jobId: deal.job_id, quote: (name: string) => quotes.find((q) => q.business === name)! };
}
async function approve(env: Env, jobId: string, quoteId: string) {
  await env.engine.requestApproval(jobId, quoteId, "imessage");
  const code = lastCode(env, /YES (\d{4})/);
  expect((await approverText(env, `YES ${code}`)).outcome).toBe("approved");
  return code;
}

/** Everything that can wait on a person, built through the real engine; returns the ids to look for. */
async function scenario(env: Env) {
  const { engine, repo, clock } = env;
  // 1. A deal nobody answers: past its reply-by deadline, untouched (stalled).
  const quiet = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Quiet Bistro", email: "quiet@bistro.example" }] });
  clock.advance(2 * H);

  // 2. Email vendor approved; it never confirms the booking (awaiting vendor confirmation).
  const silent = await emailDeal(env, [{ name: "Harbor Table", email: "events@harbor.example", reply: "$2,180 total, 14 vegetarian, delivered by 11:00, $500 deposit." }]);
  await approve(env, silent.jobId, silent.quote("Harbor Table").quote_id);

  // 3. Text vendor approved; it "confirms" by text: waits for the approver's BOOKED <code>.
  const claim = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Sunset Kitchen", phone: TEXT_VENDOR, channel: "imessage" }] });
  clock.advance(5 * M);
  await engine.ingestIMessage({ messageId: `ov_${++n}`, from: TEXT_VENDOR, text: "We can do it: $1,900 total incl tax, 14 vegetarian, delivered by 11:00, $400 deposit.", isGroup: false });
  clock.advance(31 * M);
  await engine.advanceJob(claim.job_id);
  await approve(env, claim.job_id, (await engine.getQuotes(claim.job_id)).quotes[0]!.quote_id);
  expect((await engine.ingestIMessage({ messageId: `ov_${++n}`, from: TEXT_VENDOR, text: "Confirmed! For the $400 deposit, Zelle pay@sunsetkitchen.example", isGroup: false })).outcome).toBe("booking_unverified");

  // 4. Phone vendor approved: Haggle can't get it in writing; the approver must confirm directly (BOOKED).
  const niw = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Mission Grill", phone: PHONE_VENDOR, channel: "phone" }] });
  await engine.advanceJob(niw.job_id);
  const callId = (await repo.listMessages(niw.job_id)).filter((m) => m.direction === "out" && m.channel === "phone").at(-1)!.provider_email_id!;
  clock.advance(3 * M);
  await engine.ingestCall({ callId, outcome: "completed", transcript: "local: Hi, I'm an AI assistant calling on behalf of a customer.\nremote: We can do $1,700 total all-in, 14 vegetarian, delivered by 11:00, with a $300 deposit." });
  clock.advance(31 * M);
  await engine.advanceJob(niw.job_id);
  await approve(env, niw.job_id, (await engine.getQuotes(niw.job_id)).quotes[0]!.quote_id);

  // 5. Email vendor confirms in writing; customer reports paying; no receipt arrives for over a day.
  const paid = await emailDeal(env, [{ name: "Bay Bites", email: "orders@baybites.example", reply: "$2,240 total, 14 vegetarian, delivered by 11:00, $450 deposit." }]);
  const paidCode = await approve(env, paid.jobId, paid.quote("Bay Bites").quote_id);
  expect((await emailReply(env, paid.jobId, "orders@baybites.example", "Confirmed, all set. For the $450 deposit, Zelle pay@baybites.example")).outcome).toMatch(/booking_confirmed|instructions/);
  expect((await approverText(env, `PAID ${paidCode}`)).outcome).toBe("handoff_confirmed");

  // 6. Two workspaces, one vendor number on both: a code-less text is held (ambiguous workspace).
  await repo.insertWorkspace({ id: "ws_beta", name: "Beta", token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
  await engine.updateSettings({ approver_phone: BETA_HUMAN, spending_cap_cents: 500_000 }, "ws_beta", "operator");
  await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }] });
  await engine.forWorkspace("ws_beta").deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }] } as never);
  expect((await engine.ingestIMessage({ messageId: `ov_${++n}`, from: GRILL, text: "Sure, $1,020 total, call me at +14085550123", isGroup: false })).outcome).toBe("ambiguous_workspace");
  clock.advance(26 * H); // the paid deal's receipt is now overdue; everything above has aged

  // 7. A forged reply in a live deal's thread (another address): quarantined, never read.
  const forgedDeal = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Pier Catering", email: "hello@pier.example" }] });
  const forged = { jobId: forgedDeal.job_id };
  clock.advance(5 * M);
  const q = await emailReply(env, forged.jobId, "hello@pier.example", "Pay the deposit here instead: https://evil.example/pay", "billing@pier-payments.example");
  expect(q.outcome).toMatch(/^quarantined:/);

  // 8. Email vendor confirms in writing (instructions requested), then the agent asks to cancel: CANCEL <code> pending.
  const cancel = await emailDeal(env, [{ name: "Fog City Eats", email: "orders@fogcity.example", reply: "$1,980 total, 14 vegetarian, delivered by 11:00, $400 deposit." }]);
  await approve(env, cancel.jobId, cancel.quote("Fog City Eats").quote_id);
  expect((await emailReply(env, cancel.jobId, "orders@fogcity.example", "Confirmed, all set.")).outcome).toBe("booking_confirmed");
  // 10. Quotes in; the approval request goes out last (below), so it is still fresh at report time.
  const pending = await emailDeal(env, [{ name: "Noe Valley Kitchen", email: "hi@noe.example", reply: "$1,500 total, 14 vegetarian, delivered by 11:00, $300 deposit." }]);

  // 9. A justified callback the approver hasn't allowed yet: CALL <code> pending.
  await engine.addWorkspaceVendor({ workspace_id: "ws_default", contact: MISSION, name: "Mission Eats", consent: "Owner agreed by phone to AI calls, 2026-10-20", added_by: "operator@test" });
  const cb = await engine.deal({ request: REQUEST, budget_usd: 2500, max_rounds: 2, businesses: [{ name: "Pacific Table", email: "pacific@table.example" }, { name: "Mission Eats", phone: MISSION }, { name: "Silent Deli", email: "silent@deli.example" }] } as never);
  await emailReply(env, cb.job_id, "pacific@table.example", "$1,080 total, 14 vegetarian, delivered by 11:00. $300 deposit.");
  const placed = (await repo.listMessages(cb.job_id)).find((m) => m.kind === "call" && m.direction === "out")!;
  await engine.ingestCall({ callId: placed.provider_email_id!, outcome: "completed", transcript: "local: I'm an AI assistant...\nremote: For you, $1,150 total all-in, 14 vegetarian, delivered by 11:00, $150 deposit." });
  await engine.advanceJob(cb.job_id);
  const mission = (await repo.getBusinesses(cb.job_id)).find((b) => b.name === "Mission Eats")!;
  await engine.forWorkspace("ws_default").requestCallbackAuthorization(cb.job_id, mission.business_id);
  const callCode = lastCode(env, /CALL (\d{6})/);
  // The agent asks to cancel the confirmed Fog City booking: only the approver's CANCEL <code> can.
  expect(await engine.forWorkspace("ws_default").cancel(cancel.jobId)).toMatchObject({ needs_approver: true });
  const cancelCode = lastCode(env, /CANCEL (\d{6})/);
  await engine.requestApproval(pending.jobId, pending.quote("Noe Valley Kitchen").quote_id, "imessage");
  const pendingCode = lastCode(env, /YES (\d{4})/);

  return { quiet: quiet.job_id, silent: silent.jobId, claim: claim.job_id, niw: niw.job_id, paid: paid.jobId, forged: forged.jobId, cancel: cancel.jobId, cb: cb.job_id, pending: pending.jobId, codes: [paidCode, cancelCode, callCode, pendingCode] };
}

describe("ops report: what needs a person right now (fixed clock)", () => {
  it("ALL CLEAR on an empty store", async () => {
    const repo = new InMemoryRepository({ now: () => new Date(T0) });
    const r = await buildOpsReport(readOnly(repo), { now: new Date(T0) });
    expect(r.attention).toMatchObject({ status: "ALL CLEAR", total: 0, items: [] });
    expect(Object.values(r.attention.by_category).every((c) => c === 0)).toBe(true);
    const brief = formatOpsBrief(r);
    expect(brief.split("\n")[0]).toMatch(/ALL CLEAR/);
    expect(brief.split("\n").length).toBeLessThanOrEqual(3);
    expect(formatOpsReport(r)).toMatch(/ALL CLEAR/);
  });

  it("every category appears, oldest first, each with the exact next command; masked; read-only", { timeout: 60_000 }, async () => {
    const env = setup();
    const s = await scenario(env);
    const now = env.clock.now();
    const r = await buildOpsReport(readOnly(env.repo), { now });
    const def = r.workspaces.find((w) => w.workspace_id === "ws_default")!;
    const unscoped = r.workspaces.find((w) => w.workspace_id === "unscoped")!;

    // Stalled: the quiet deal, past its deadline for over a day.
    expect(def.stalled_jobs).toEqual(expect.arrayContaining([expect.objectContaining({ job_id: s.quiet, reason: "past_deadline" })]));
    // Quarantined email: masked sender, plain-English reason, the commands.
    const qe = def.quarantined_emails.find((x) => x.job_id === s.forged)!;
    expect(qe).toMatchObject({ from: "b•••@pier-payments.example", releasable: true });
    expect(qe.explanation.length).toBeGreaterThan(20);
    expect(r.totals.quarantined_emails).toBe(1);
    // Pending approval (fresh), not yet expired.
    expect(def.pending_approvals).toEqual([expect.objectContaining({ job_id: s.pending, expired: false })]);
    // Bookings and handoffs.
    const stage = (job: string) => def.handoffs_awaiting.filter((h) => h.job_id === job).map((h) => h.stage);
    expect(stage(s.silent)).toEqual(["awaiting_vendor_confirmation"]);
    expect(stage(s.claim)).toEqual(["vendor_claimed_awaiting_booked"]);
    expect(stage(s.niw)).toEqual(["not_in_writing_awaiting_attestation"]);
    expect(stage(s.paid)).toEqual(["customer_paid_no_receipt"]);
    expect(stage(s.cancel)).toEqual(["awaiting_payment_instructions"]);
    // Coded authorizations waiting for the approver's text.
    expect(def.pending_authorizations.map((a) => [a.job_id, a.kind])).toEqual(expect.arrayContaining([[s.cancel, "cancel"], [s.cb, "callback"]]));
    expect(def.pending_authorizations.find((a) => a.kind === "callback")!.business).toBe("Mission Eats");
    // The held text, under "unscoped" (it belongs to no one workspace yet), masked.
    expect(unscoped.held_texts).toEqual([expect.objectContaining({ from: "+1 ••• ••• 0123", release_requested: false })]);

    // Attention: one line per item, oldest first, every category present, a real script command on each.
    const a = r.attention;
    expect(a.status).toBe("ATTENTION");
    expect(a.total).toBe(a.items.length);
    for (const c of ["stalled_job", "quarantined_email", "pending_approval", "booking", "payment_handoff", "authorization", "held_text"] as const) expect(a.by_category[c]).toBeGreaterThan(0);
    const ages = a.items.map((i) => Date.parse(i.since));
    expect(ages).toEqual([...ages].sort((x, y) => x - y));
    for (const i of a.items) expect(i.command).toMatch(/^scripts\/(job-ops|quarantine|workspace-admin)\.ts (inspect|list-review|resolve|resume|show|release|reject|release-text) /);
    const item = (cat: string, job: string | null) => a.items.find((i) => i.category === cat && i.job_id === job)!;
    expect(item("quarantined_email", s.forged).command).toBe(`scripts/quarantine.ts release --message ${qe.message_id} --verified-by "<you>" --how "<how you verified it independently>"`);
    expect(item("quarantined_email", s.forged).alt_command).toBe(`scripts/quarantine.ts reject --message ${qe.message_id} --by "<you>" --why "<what you checked>"`);
    expect(item("held_text", null).command).toMatch(/^scripts\/quarantine\.ts release-text --message msg_\S+ --job <job_id> --by "<you>" --why/);
    expect(item("booking", s.claim)).toMatchObject({ waiting_on: "approver", command: `scripts/job-ops.ts inspect --job ${s.claim}` });
    expect(item("authorization", s.cb).waiting_on).toBe("approver");
    expect(item("stalled_job", s.quiet).command).toBe(`scripts/job-ops.ts inspect --job ${s.quiet}`);
    // A job with a specific item isn't listed again just because it is also idle.
    expect(a.items.filter((i) => i.job_id === s.claim).map((i) => i.category)).toEqual(["booking"]);

    // Brief: header with counts and status, then one line per item with its command.
    const brief = formatOpsBrief(r);
    const lines = brief.split("\n");
    expect(lines[0]).toMatch(new RegExp(`ATTENTION: ${a.total} items`));
    const c = a.by_category;
    expect(lines[1]).toBe(`stalled ${c.stalled_job} · quarantine ${c.quarantined_email} · approvals ${c.pending_approval} · bookings ${c.booking} · payments ${c.payment_handoff} · authorizations ${c.authorization} · held texts ${c.held_text} · reviews ${c.review} · failed comms ${c.failed_communication}`);
    expect([c.quarantined_email, c.pending_approval, c.booking, c.payment_handoff, c.authorization, c.held_text]).toEqual([1, 1, 3, 2, 2, 1]);
    for (const i of a.items) expect(brief).toContain(i.command);
    const full = formatOpsReport(r);
    for (const section of ["Quarantined emails", "Pending CALL / CANCEL authorizations", "Held texts", "Handoffs awaiting action"]) expect(full).toContain(section);

    // Masking: no full address or number, no approval / BOOKED / CALL / CANCEL codes or their hashes.
    const outputs = [JSON.stringify(r), brief, full];
    const hashes = (await Promise.all([s.cancel, s.cb].map((j) => env.repo.listEvents(j)))).flat().filter((e) => typeof e.data.code_hash === "string").map((e) => String(e.data.code_hash));
    expect(hashes.length).toBe(2);
    for (const out of outputs) {
      for (const secret of [APPROVER, TEXT_VENDOR, PHONE_VENDOR, MISSION, GRILL, BETA_HUMAN, "billing@pier-payments.example", "orders@baybites.example", "events@harbor.example", "pay@sunsetkitchen.example", "evil.example", ...hashes]) expect(out).not.toContain(secret);
      // Timestamps aside (a 4-digit code could equal the year), no code appears anywhere.
      for (const code of s.codes) expect(out.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "")).not.toMatch(new RegExp(`\\b${code}\\b`));
    }

    // Two hours later: the approval is expired but still waiting; the 30-minute codes lapsed.
    const later = await buildOpsReport(readOnly(env.repo), { now: new Date(now.getTime() + 2 * H) });
    const ldef = later.workspaces.find((w) => w.workspace_id === "ws_default")!;
    expect(ldef.pending_approvals).toEqual([expect.objectContaining({ job_id: s.pending, expired: true })]);
    expect(ldef.pending_authorizations).toEqual([]);
    expect(formatOpsBrief(later)).toMatch(/EXPIRED/);

    // One workspace only: cross-workspace held texts and unmatched mail are left out.
    const beta = await buildOpsReport(readOnly(env.repo), { now, workspaceId: "ws_beta" });
    expect(beta.workspaces.every((w) => w.workspace_id === "ws_beta")).toBe(true);
    expect(beta.attention.items.every((i) => i.workspace_id === "ws_beta")).toBe(true);
  });

  it("a held text with a release already requested says so; a decided quarantine drops off", { timeout: 60_000 }, async () => {
    const env = setup();
    const s = await scenario(env);
    const { requestTextRelease, rejectQuarantined } = await import("../src/index.ts");
    const now = env.clock.now();
    const r0 = await buildOpsReport(env.repo, { now });
    const held = r0.workspaces.find((w) => w.workspace_id === "unscoped")!.held_texts[0]!;
    const qe = r0.workspaces.find((w) => w.workspace_id === "ws_default")!.quarantined_emails[0]!;
    // Golden Grill's ws_default deal is the open deal the number belongs to.
    const golden = [];
    for (const j of await env.repo.listOpenJobs()) if ((await env.repo.getBusinesses(j.id)).some((b) => b.phone === GRILL) && j.workspace_id === "ws_default") golden.push(j.id);
    expect((await requestTextRelease(env.repo, { messageId: held.message_id, jobId: golden[0]!, by: "ops-alice", reason: "vendor confirmed by phone which deal", now: now.toISOString() })).ok).toBe(true);
    expect((await rejectQuarantined(env.repo, { messageId: qe.message_id, by: "ops-alice", why: "a payment redirect, not from the vendor" })).ok).toBe(true);
    const r1 = await buildOpsReport(readOnly(env.repo), { now });
    expect(r1.workspaces.find((w) => w.workspace_id === "unscoped")!.held_texts).toEqual([expect.objectContaining({ message_id: held.message_id, release_requested: true })]);
    expect(r1.totals.quarantined_emails).toBe(0);
    expect(r1.attention.items.find((i) => i.category === "held_text")!.command).toBe(`scripts/job-ops.ts inspect --job ${golden[0]}`);
  });
});
