// job-ops safety (sprint 4, workstream F): a manual retry never bypasses the safeguards a first send
// has (suppression, workspace authorization, the provider's idempotency window, the approval an
// obligation rests on), and the job-level actions (review-job hold, resume, fail-safe-close) are
// performed by the running engine truthfully. In-memory store, the real engine, fake providers.
import { describe, expect, it } from "vitest";
import { buildOpsReport, holdSubject, PROVIDER_KEY_MAX_AGE_MS } from "@haggle/engine";
import { applySteps, contactCheck, planJobAction, planOps, planRetry } from "../scripts/job-ops.ts";
import { APPROVER, BUDGET, kit, mail, REQUEST, type Kit } from "../../../packages/engine/tests/helpers/reliabilityKit.ts";

const VENDOR = "harbor@inkboxmail.test";
const OTHER = "sunset@inkboxmail.test";

type RetryKey = Extract<ReturnType<typeof planOps>, { kind: "retry-key" }>;
type JobCmd = Extract<ReturnType<typeof planOps>, { kind: "review-job" | "resume" | "fail-safe-close" }>;
const retryCmd = (key: string, override = false) => planOps(["retry", "--key", key, ...(override ? ["--override-obligation"] : []), "--by", "ops"]) as RetryKey;
const jobCmd = (argv: string[]) => planOps([...argv, "--by", "ops"]) as JobCmd;

/** An RFQ that kept failing until it was given up (bounced): the operator may consider a retry. */
async function failedRfq(k: Kit, workspaceId?: string) {
  if (workspaceId) {
    await k.engine.createWorkspace({ id: workspaceId, name: "Acme" } as never);
    await k.repo.addWorkspaceVendor({ workspace_id: workspaceId, contact: VENDOR, name: "Harbor Table", consent: "agreed by phone 2026-10-20", added_by: "ops" });
    await k.repo.addWorkspaceVendor({ workspace_id: workspaceId, contact: OTHER, name: "Sunset Kitchen", consent: "agreed by phone 2026-10-20", added_by: "ops" });
  }
  k.p.failTo(VENDOR, ...Array(10).fill("5xx_before"));
  const d = workspaceId
    ? await k.engine.forWorkspace(workspaceId).deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: VENDOR }, { name: "Sunset Kitchen", email: OTHER }] } as never)
    : await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: VENDOR }, { name: "Sunset Kitchen", email: OTHER }] });
  for (let i = 0; i < 5; i++) {
    k.clock.advance(60_000);
    await k.engine.advanceJob(d.job_id);
  }
  const b = (await k.repo.getBusinesses(d.job_id)).find((x) => x.email === VENDOR)!;
  return { jobId: d.job_id, b, key: `rfq:${d.job_id}:${b.business_id}` };
}

describe("a manual retry re-checks every safeguard of a first send", () => {
  it("an RFQ to a vendor suppressed since (opt-out) is refused before anything is re-armed; the engine would refuse it too", async () => {
    const k = kit();
    const { jobId, b, key } = await failedRfq(k);
    expect(b.status).toBe("bounced");
    expect(await planRetry(k.repo, retryCmd(key), k.clock.now().getTime())).toMatchObject({ ok: true }); // retryable before the opt-out
    await k.repo.addSuppression({ contact: VENDOR, reason: "opt_out", job_id: jobId, evidence: "STOP" });
    const plan = await planRetry(k.repo, retryCmd(key), k.clock.now().getTime());
    expect(plan).toMatchObject({ ok: false, reason: expect.stringMatching(/suppressed \(opt_out\).*remove-suppression/) });
    expect((await k.repo.getOutbox(key))!.status).not.toBe("pending");
    // Even re-armed by hand (database surgery), the engine's send path refuses a suppressed address.
    await k.repo.rearmOutbox(key, k.clock.now().toISOString());
    await k.repo.updateBusiness(jobId, b.business_id, { status: "pending", next_attempt_at: k.clock.now().toISOString(), send_attempts: 0 });
    await k.engine.advanceJob(jobId);
    expect(k.p.to(VENDOR)).toHaveLength(0);
  });

  it("an RFQ to a vendor no longer authorized for the workspace is refused", async () => {
    const k = kit();
    const { key, jobId } = await failedRfq(k, "ws_acme");
    expect(await contactCheck(k.repo, (await k.repo.getJob(jobId))!, key, {})).toEqual({ suppressed: null, authorized: true });
    await k.repo.removeWorkspaceVendor("ws_acme", VENDOR);
    expect(await planRetry(k.repo, retryCmd(key), k.clock.now().getTime())).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer an authorized vendor/) });
  });

  it("anything first attempted longer ago than the provider's idempotency window is refused (a re-send could arrive twice)", async () => {
    const k = kit();
    const { key } = await failedRfq(k);
    k.clock.advance(PROVIDER_KEY_MAX_AGE_MS);
    expect(await planRetry(k.repo, retryCmd(key), k.clock.now().getTime())).toMatchObject({ ok: false, reason: expect.stringMatching(/7 days/) });
  });

  it("a booking confirmation (obligation): needs --override-obligation, and still refused once the business is suppressed", async () => {
    const k = kit({ manualPaymentHandoff: true });
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: VENDOR }] });
    const b = (await k.repo.getBusinesses(d.job_id))[0]!;
    await mail(k, b, "We can do it: $1,150 total, delivered. $345 deposit.");
    await k.engine.advanceJob(d.job_id);
    const q = (await k.engine.getQuotes(d.job_id)).quotes[0]!;
    const a = await k.engine.requestApproval(d.job_id, q.quote_id, "imessage");
    await k.engine.ingestText({ messageId: "yes1", from: APPROVER, text: `YES ${a.code}`, inbound: true });
    expect((await mail(k, b, "Confirmed, we're all set for your event.")).outcome).toBe("booking_confirmed");
    k.p.fail("email", "conflict"); // the confirmation's outcome is unknown
    expect((await k.engine.ingestText({ messageId: "paid1", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_confirmed");
    const key = `confirm:${a.id}`;
    expect((await k.repo.getOutbox(key))!.status).toBe("unknown");
    expect(await planRetry(k.repo, retryCmd(key), k.clock.now().getTime())).toMatchObject({ ok: false, reason: expect.stringMatching(/override-obligation/) });
    await k.repo.addSuppression({ contact: VENDOR, reason: "bounce", job_id: d.job_id, evidence: "550 mailbox unavailable" });
    expect(await planRetry(k.repo, retryCmd(key, true), k.clock.now().getTime())).toMatchObject({ ok: false, reason: expect.stringMatching(/suppressed \(bounce\)/) });
    expect(k.p.attempts.filter((x) => x.key === key)).toHaveLength(1);
  });
});

describe("job-level operator actions", () => {
  it("review-job holds a job: due sends wait (nothing goes out, nothing is bounced); resume sends them once", async () => {
    const k = kit();
    k.p.fail("email", "5xx_before");
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: VENDOR }] });
    const hold = await planJobAction(k.repo, jobCmd(["review-job", "--job", d.job_id, "--note", "vendor asked us to pause"]));
    expect(hold).toMatchObject({ ok: true });
    if (!hold.ok) return;
    await applySteps(k.repo, hold.steps, k.clock.now().toISOString());
    expect(await planJobAction(k.repo, jobCmd(["review-job", "--job", d.job_id, "--note", "again"]))).toMatchObject({ ok: false, reason: expect.stringMatching(/already on hold/) });
    for (let i = 0; i < 3; i++) {
      k.clock.advance(5 * 60_000);
      await k.engine.advanceAllOpen();
      await k.engine.recoverStuck();
    }
    expect(k.p.to(VENDOR)).toHaveLength(0);
    expect((await k.repo.getBusinesses(d.job_id))[0]!.status).toBe("pending");
    expect(k.logs.some((l) => l.event === "advance_held")).toBe(true);
    // Visible to operators while held.
    const report = await buildOpsReport(k.repo, { now: k.clock.now() });
    expect(report.workspaces[0]!.reviews.some((r) => r.subject === holdSubject(d.job_id))).toBe(true);
    const resume = await planJobAction(k.repo, jobCmd(["resume", "--job", d.job_id, "--note", "vendor ready"]));
    expect(resume).toMatchObject({ ok: true });
    if (!resume.ok) return;
    await applySteps(k.repo, resume.steps, k.clock.now().toISOString());
    await k.engine.advanceJob(d.job_id);
    await k.engine.advanceJob(d.job_id);
    expect(k.p.to(VENDOR)).toHaveLength(1);
  });

  it("fail-safe-close: the server closes the job, texts the human exactly what happened, contacts no business; refused while money may be moving", async () => {
    const k = kit({ manualPaymentHandoff: true });
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: VENDOR }, { name: "Sunset Kitchen", email: OTHER }] });
    const [h, s] = await k.repo.getBusinesses(d.job_id);
    await mail(k, h!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await mail(k, s!, "We can do it: $1,300 total, delivered.");
    await k.engine.advanceJob(d.job_id);
    const q = (await k.engine.getQuotes(d.job_id)).quotes.find((x) => x.business === "Harbor Table")!;
    const a = await k.engine.requestApproval(d.job_id, q.quote_id, "imessage");
    await k.engine.ingestText({ messageId: "yes1", from: APPROVER, text: `YES ${a.code}`, inbound: true });
    expect((await mail(k, h!, "Confirmed, we're all set for your event.")).outcome).toBe("booking_confirmed");
    const toBusinesses = () => k.p.deliveries.filter((x) => x.to === VENDOR || x.to === OTHER).length;
    const before = toBusinesses();
    expect(() => planOps(["fail-safe-close", "--job", d.job_id, "--reason", "vendor unreachable", "--by", "ops"])).toThrow(/--confirm/);
    const plan = await planJobAction(k.repo, jobCmd(["fail-safe-close", "--job", d.job_id, "--reason", "vendor unreachable", "--confirm"]));
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    await applySteps(k.repo, plan.steps, k.clock.now().toISOString());
    expect(await planJobAction(k.repo, jobCmd(["fail-safe-close", "--job", d.job_id, "--reason", "again", "--confirm"]))).toMatchObject({ ok: false, reason: expect.stringMatching(/already requested/) });
    await k.engine.advanceJob(d.job_id);
    const job = (await k.repo.getJob(d.job_id))!;
    expect(job).toMatchObject({ state: "failed", failure_reason: "operator_closed" });
    expect(toBusinesses()).toBe(before); // no business contacted
    const text = k.p.deliveries.filter((x) => x.to === APPROVER).at(-1)!.text;
    expect(text).toMatch(/an operator closed this deal \(vendor unreachable\)/);
    expect(text).toMatch(/Harbor Table had confirmed the booking and wasn't told it's off: contact them directly/);
    expect(text).toMatch(/nothing was paid through Haggle/);
    expect((await k.repo.getBookingByApproval(a.id))!.status).toBe("cancelled");
    expect(await k.repo.listReviews({ status: "open", jobId: d.job_id })).toEqual([]);
    expect(await planJobAction(k.repo, jobCmd(["fail-safe-close", "--job", d.job_id, "--reason", "again", "--confirm"]))).toMatchObject({ ok: false, reason: expect.stringMatching(/already failed/) });

    // Money moving (a Stripe charge in flight): refused by the plan.
    const k2 = kit();
    const d2 = await k2.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: VENDOR }] });
    const b2 = (await k2.repo.getBusinesses(d2.job_id))[0]!;
    await mail(k2, b2, "We can do it: $1,150 total, delivered. $345 deposit.");
    await k2.engine.advanceJob(d2.job_id);
    const q2 = (await k2.engine.getQuotes(d2.job_id)).quotes[0]!;
    const a2 = await k2.engine.requestApproval(d2.job_id, q2.quote_id, "imessage");
    await k2.engine.ingestText({ messageId: "yes2", from: APPROVER, text: `YES ${a2.code}`, inbound: true });
    await k2.repo.insertPayment({ id: "pay_inflight1", job_id: d2.job_id, approval_id: a2.id, business_id: q2.business_id, status: "charging", rail: "stripe", amount_cents: a2.payment_cents, amount_base_units: String(a2.payment_cents), network: "stripe-test", idempotency_key: `haggle-pay-${a2.id}`, stripe_payment_intent_id: null, challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false, pay_to: null, interaction_json: null, settle_tx: null, simulated: true, reason: null } as never);
    expect(await planJobAction(k2.repo, jobCmd(["fail-safe-close", "--job", d2.job_id, "--reason", "stuck", "--confirm"]))).toMatchObject({ ok: false, reason: expect.stringMatching(/payment is in flight \(charging\)/) });
  });
});
