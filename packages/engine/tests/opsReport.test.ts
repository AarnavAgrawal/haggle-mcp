// The operator report (ops/report.ts, apps/mcp/scripts/ops-report.ts) over three days of fake time:
// pending approvals, unresolved reviews, failed and bounced communications, quarantined replies,
// stalled jobs and recovery findings, handoffs awaiting action, per workspace. Read-only (a
// repository that throws on every write still builds it). In memory, and on Postgres when available.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOpsReport, formatOpsReport, holdSubject, InMemoryRepository, PostgresRepository, type Repository } from "../src/index.ts";
import { APPROVER, BUDGET, kit, mail, REQUEST, type Kit } from "./helpers/reliabilityKit.ts";

const H = 3_600_000;
const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const uniq = () => Math.random().toString(36).slice(2, 8);

const WRITES = /^(insert|update|add|remove|save|set|claim|reclaim|finish|rearm|open|resolve|transition|record|append|touch|cas|acquire|release|renew|answer|hold|take|mark|advance)/;
/** The repository with every write refused: the report must only read. */
const readOnly = (repo: Repository) => new Proxy(repo, { get(t, p, r) { const v = Reflect.get(t, p, r); return typeof v === "function" && typeof p === "string" && WRITES.test(p) ? () => { throw new Error(`write ${p} during the report`); } : typeof v === "function" ? v.bind(t) : v; } });

async function scenario(k: Kit, tag: string) {
  const email = (n: string) => `${n}-${tag}@inkboxmail.test`;
  await k.engine.createWorkspace({ id: `ws_acme_${tag}`, name: "Acme", tokenHash: createHash("sha256").update(`t_${tag}`).digest("hex"), connectorSecretHash: createHash("sha256").update(`c_${tag}`).digest("hex"), settings: { approver_phone: APPROVER } as never });
  await k.repo.addWorkspaceVendor({ workspace_id: `ws_acme_${tag}`, contact: email("harbor"), name: "Harbor Table", consent: "phone 2026-10-20", added_by: "ops" });
  // 1. Default workspace: a pending approval nobody answers.
  const a = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Sunset Kitchen", email: email("sunset") }] });
  const sb = (await k.repo.getBusinesses(a.job_id))[0]!;
  await mail(k, sb, "We can do it: $1,150 total, delivered. $345 deposit.");
  await k.engine.advanceJob(a.job_id);
  const q = (await k.engine.getQuotes(a.job_id)).quotes[0]!;
  const approval = await k.engine.requestApproval(a.job_id, q.quote_id, "imessage");
  // 2. Default workspace: a vendor whose RFQ bounced and a call whose outcome is unknown (reviewed).
  k.p.failTo(email("bad"), ...Array(10).fill("5xx_before"));
  k.p.fail("call", "timeout_after");
  const b = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Bad Address Co", email: email("bad") }, { name: "Mission Eats", phone: "+14155550142" }] });
  for (let i = 0; i < 5; i++) { k.clock.advance(60_000); await k.engine.advanceJob(b.job_id); }
  await k.repo.insertMessage({ job_id: b.job_id, business_id: null, approval_id: null, direction: "in", kind: "quarantine", provider_email_id: `q_${tag}`, idempotency_key: null, rfc_message_id: null, thread_id: null, from_address: "spoof@else.example", to_address: "haggle@inkboxmail.test", subject: "Re: quote", body_text: "pay here", attachments: [], attachments_download_url: null, sender_trusted: false, trust_reason: "not_verified", matched_via: null, parse_status: "none", quarantine_reason: "sender_not_verified", round: null, simulated: false });
  // 3. Acme: booked on the manual rail, the business never confirms; plus a job an operator holds.
  const ws = k.engine.forWorkspace(`ws_acme_${tag}`);
  const c = await ws.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: email("harbor") }] } as never);
  const hb = (await k.repo.getBusinesses(c.job_id))[0]!;
  await mail(k, hb, "We can do it: $1,150 total, delivered. $345 deposit.");
  await k.engine.advanceJob(c.job_id);
  const cq = (await k.engine.getQuotes(c.job_id)).quotes[0]!;
  const ca = await k.engine.requestApproval(c.job_id, cq.quote_id, "imessage");
  expect((await k.engine.ingestText({ messageId: `yes_${tag}`, from: APPROVER, text: `YES ${ca.code}`, inbound: true })).outcome).toBe("approved");
  const held = await ws.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: email("harbor") }] } as never);
  await k.repo.openReview({ id: `rev_hold${tag}`, job_id: held.job_id, kind: "stuck_job", subject: holdSubject(held.job_id), reason: "operator hold by ops: vendor asked to pause", attempts: 0, last_error: null }, k.clock.now().toISOString());
  // Three days pass with the server ticking now and then.
  for (let i = 0; i < 6; i++) {
    k.clock.advance(12 * H);
    await k.engine.advanceAllOpen();
  }
  return { a, b, c, held, approval, ca };
}

const repos: [string, () => Promise<{ repo: Repository; close: () => Promise<void> }>][] = [["memory", async () => ({ repo: new InMemoryRepository(), close: async () => {} })]];
if (PG_URL) repos.push(["postgres", async () => { const repo = new PostgresRepository(PG_URL); return { repo, close: () => repo.close() }; }]);

describe.each(repos)("ops report (%s)", (_name, open) => {
  it("after three days: everything waiting on a person, per workspace, with nothing written", { timeout: 60_000 }, async () => {
    const { repo, close } = await open();
    try {
      const tag = uniq();
      const k = kit({ manualPaymentHandoff: true }, { repo: repo as never });
      const s = await scenario(k, tag);
      const r = await buildOpsReport(readOnly(repo), { now: k.clock.now() });
      const def = r.workspaces.find((w) => w.workspace_id === "ws_default")!;
      const acme = r.workspaces.find((w) => w.workspace_id === `ws_acme_${tag}`)!;
      // Default workspace: the unanswered approval (expired after 3 days and cleared, or still listed), the bounce, the unknown call, the quarantined reply.
      expect(def.failed_communications.some((f) => f.job_id === s.b.job_id && f.status === "bounced" && /Bad Address Co/.test(f.what))).toBe(true);
      expect(def.failed_communications.some((f) => f.job_id === s.b.job_id && f.status === "unknown" && /^call /.test(f.what))).toBe(true);
      expect(def.reviews.some((v) => v.job_id === s.b.job_id && v.kind === "outbox" && /never redialed/.test(v.reason))).toBe(true);
      expect(def.quarantined_replies).toBeGreaterThanOrEqual(1);
      // Acme: the booking the business never confirmed (stalled and reviewed), the held job.
      expect(acme.handoffs_awaiting).toEqual([expect.objectContaining({ job_id: s.c.job_id, approval_id: s.ca.id, business: "Harbor Table", stage: "awaiting_vendor_confirmation", stalled: true })]);
      expect(acme.recovery.some((f) => f.job_id === s.c.job_id && f.issue === "booking_unconfirmed" && f.action === "review")).toBe(true);
      expect(acme.reviews.some((v) => v.subject === `${s.c.job_id}:booking_unconfirmed`)).toBe(true);
      expect(acme.reviews.some((v) => v.subject === holdSubject(s.held.job_id))).toBe(true);
      expect(acme.stalled_jobs.some((j) => j.job_id === s.held.job_id && j.age_h >= 70)).toBe(true); // three days without a change
      // Nothing from one workspace in the other's section.
      expect(JSON.stringify(def)).not.toContain(s.c.job_id);
      expect(JSON.stringify(acme)).not.toContain(s.b.job_id);
      expect(r.totals.open_reviews).toBe(r.workspaces.reduce((n, w) => n + w.reviews.length, 0));
      // One workspace only; plain text names every section that has something.
      const only = await buildOpsReport(readOnly(repo), { now: k.clock.now(), workspaceId: `ws_acme_${tag}` });
      expect(only.workspaces.map((w) => w.workspace_id)).toEqual([`ws_acme_${tag}`]);
      const text = formatOpsReport(only);
      for (const section of ["Operator reviews", "Stalled jobs", "Recovery findings", "Handoffs awaiting action"]) expect(text).toContain(section);
      expect(text).not.toMatch(/inkboxmail\.test/); // no vendor addresses in the report text
    } finally {
      await close();
    }
  });

  it("a pending approval that expired while nobody answered is cleared by the tick; one still pending is listed", { timeout: 60_000 }, async () => {
    const { repo, close } = await open();
    try {
      const k = kit({}, { repo: repo as never });
      const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Sunset Kitchen", email: `sunset-${uniq()}@inkboxmail.test` }] });
      const b = (await k.repo.getBusinesses(d.job_id))[0]!;
      await mail(k, b, "We can do it: $1,150 total, delivered. $345 deposit.");
      await k.engine.advanceJob(d.job_id);
      const q = (await k.engine.getQuotes(d.job_id)).quotes[0]!;
      const a = await k.engine.requestApproval(d.job_id, q.quote_id, "imessage");
      const r = await buildOpsReport(repo, { now: k.clock.now() });
      expect(r.workspaces.find((w) => w.workspace_id === "ws_default")!.pending_approvals).toEqual(expect.arrayContaining([expect.objectContaining({ job_id: d.job_id, approval_id: a.id, expired: false })]));
    } finally {
      await close();
    }
  });
});
