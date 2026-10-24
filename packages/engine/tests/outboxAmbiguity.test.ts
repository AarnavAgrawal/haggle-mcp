// The outbox under ambiguous network failures (sprint 4, workstream F): the request reached the
// provider but its response was lost (5xx after accept, a timeout), or the provider says the key was
// already used (an idempotency conflict). Invariants: no business ever receives the same message
// twice; a call is never redialed; an A2A task (whose dedupe is unverified) is never re-sent; an
// obligation (confirmation, acceptance) is never re-sent automatically; an ambiguous first contact is
// never "bounced" into a second channel (no email -> call escalation). What can't be settled
// automatically lands in operator review. Fake providers that replay a key like Inkbox does.
import { describe, expect, it } from "vitest";
import { decideClaim, PROVIDER_KEY_MAX_AGE_MS } from "../src/index.ts";
import { APPROVER, BUDGET, kit, mail, REQUEST } from "./helpers/reliabilityKit.ts";

const EMAIL = "harbor@inkboxmail.test";
const PHONE = "+14155550142";
const CARD = "https://agent.example/.well-known/agent-card.json";
// Email -> call escalation on: an RFQ email that "fails" would otherwise make Haggle call the business.
const ESCALATE = { escalateEmailToCallAfterMs: 60 * 60_000 };

async function advanceFor(k: ReturnType<typeof kit>, jobId: string, times: number, stepMs = 3 * 60_000) {
  for (let i = 0; i < times; i++) {
    k.clock.advance(stepMs);
    await k.engine.advanceJob(jobId);
  }
}
const openReviews = (k: ReturnType<typeof kit>, jobId: string) => k.repo.listReviews({ status: "open", jobId });

describe("email: the response is lost after the provider accepted the RFQ", () => {
  for (const fault of ["5xx_after", "timeout_after"] as const) {
    it(`${fault}: retried under the same key, the provider replays it; one delivery, no call`, async () => {
      const k = kit(ESCALATE);
      k.p.fail("email", fault);
      const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: EMAIL, phone: PHONE }] });
      expect(k.p.to(EMAIL)).toHaveLength(1); // it did arrive
      expect((await k.repo.getBusinesses(d.job_id))[0]).toMatchObject({ status: "pending", send_attempts: 1 });
      await advanceFor(k, d.job_id, 3, 5_000);
      expect(k.p.to(EMAIL)).toHaveLength(1); // the retry was replayed by the provider, not delivered again
      expect(k.p.to(PHONE)).toHaveLength(0); // never escalated to a call
      const b = (await k.repo.getBusinesses(d.job_id))[0]!;
      expect(b.status).toBe("contacted");
      expect(b.rfq_message_id).toBeTruthy();
      expect((await k.repo.getOutbox(`rfq:${d.job_id}:${b.business_id}`))!.status).toBe("sent");
    });
  }

  it("an idempotency conflict (409, the original may have been accepted): never re-sent, never bounced, never escalated; an operator reviews it", async () => {
    const k = kit(ESCALATE);
    k.p.fail("email", "conflict");
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: EMAIL, phone: PHONE }] });
    const b = (await k.repo.getBusinesses(d.job_id))[0]!;
    expect(b.status).toBe("contacted");
    expect((await k.repo.getOutbox(`rfq:${d.job_id}:${b.business_id}`))!.status).toBe("unknown");
    await advanceFor(k, d.job_id, 4);
    expect(k.p.attempts.filter((a) => a.key === `rfq:${d.job_id}:${b.business_id}`)).toHaveLength(1);
    expect(k.p.to(PHONE)).toHaveLength(0);
    expect((await openReviews(k, d.job_id)).find((r) => r.subject === `rfq:${d.job_id}:${b.business_id}`)).toMatchObject({ kind: "outbox", reason: expect.stringMatching(/outcome unknown/) });
  });

  it("sent but the database couldn't record it: never a bounce; recorded on the retry under the same key, delivered once", async () => {
    const k = kit(ESCALATE);
    const insert = k.repo.insertMessage.bind(k.repo);
    let down = true;
    k.repo.insertMessage = async (m) => { if (down && m.kind === "rfq") throw new Error("connection terminated unexpectedly"); return insert(m); };
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: EMAIL, phone: PHONE }] });
    expect(k.p.to(EMAIL)).toHaveLength(1);
    expect((await k.repo.getBusinesses(d.job_id))[0]!.status).toBe("pending");
    down = false;
    await advanceFor(k, d.job_id, 2);
    expect(k.p.to(EMAIL)).toHaveLength(1);
    expect(k.p.to(PHONE)).toHaveLength(0);
    expect((await k.repo.getBusinesses(d.job_id))[0]!.status).toBe("contacted");
    expect(k.logs.some((l) => l.event === "send_record_failed")).toBe(true);
  });
});

describe("calls and A2A: an outcome nobody knows is never attempted again", () => {
  it("a 5xx or timeout after dialing: the call may be ringing; never redialed, reviewed at once", async () => {
    const k = kit();
    k.p.fail("call", "timeout_after");
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Mission Eats", phone: PHONE }] });
    await advanceFor(k, d.job_id, 5);
    expect(k.p.to(PHONE)).toHaveLength(1);
    const b = (await k.repo.getBusinesses(d.job_id))[0]!;
    expect(b.status).toBe("contacted");
    expect((await openReviews(k, d.job_id)).some((r) => r.subject === `call:${d.job_id}:${b.business_id}` && /never redialed/.test(r.reason))).toBe(true);
  });

  it("an A2A task that failed after the request went out: unknown, reviewed, never re-sent (its messageId dedupe is unverified)", async () => {
    const k = kit();
    k.p.fail("a2a", "5xx_after");
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Bay Agent", a2a_card_url: CARD }] });
    await advanceFor(k, d.job_id, 4);
    expect(k.p.attempts.filter((a) => a.channel === "a2a")).toHaveLength(1);
    const b = (await k.repo.getBusinesses(d.job_id))[0]!;
    expect(b.status).toBe("contacted");
    expect((await k.repo.getOutbox(`a2a:${d.job_id}:${b.business_id}`))!.status).toBe("unknown");
    expect((await openReviews(k, d.job_id)).some((r) => r.subject === `a2a:${d.job_id}:${b.business_id}`)).toBe(true);
  });

  it("an A2A task already sent is never sent again under its key (the stale-claim path can't resend it)", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    const row = (status: "sent" | "pending" | "unknown" | "not_sent", ageMs = 0) => ({ status, attempts: 1, updated_at: new Date(now - ageMs).toISOString(), created_at: new Date(now - ageMs).toISOString() });
    expect(decideClaim({ kind: "a2a", key: "a2a:j:b", row: row("sent"), nowMs: now, staleMs: 120_000, underReview: false })).toMatchObject({ action: "refuse" });
    expect(decideClaim({ kind: "a2a", key: "a2a:j:b", row: row("pending", 300_000), nowMs: now, staleMs: 120_000, underReview: false })).toMatchObject({ action: "review" });
    expect(decideClaim({ kind: "a2a", key: "a2a:j:b", row: row("not_sent"), nowMs: now, staleMs: 120_000, underReview: false })).toEqual({ action: "send", reclaim: true });
    expect(decideClaim({ kind: "email", key: "rfq:j:b", row: row("unknown"), nowMs: now, staleMs: 120_000, underReview: false })).toMatchObject({ action: "review" });
    // Past the provider's 7-day idempotency window: never re-sent under the old key.
    expect(decideClaim({ kind: "email", key: "rfq:j:b", row: row("not_sent", PROVIDER_KEY_MAX_AGE_MS + 1), nowMs: now, staleMs: 120_000, underReview: false })).toMatchObject({ action: "review", reason: expect.stringMatching(/idempotency key/) });
    expect(decideClaim({ kind: "email", key: "rfq:j:b", row: row("sent", PROVIDER_KEY_MAX_AGE_MS + 1), nowMs: now, staleMs: 120_000, underReview: false })).toEqual({ action: "send", reclaim: false });
  });
});

describe("obligations: never re-sent automatically", () => {
  it("the booking confirmation's response is lost: not re-sent by any later advance or the recovery sweep; reviewed once", async () => {
    const k = kit({ manualPaymentHandoff: true });
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: EMAIL }] });
    const b = (await k.repo.getBusinesses(d.job_id))[0]!;
    await mail(k, b, "We can do it: $1,150 total, delivered. $345 deposit.");
    await k.engine.advanceJob(d.job_id);
    const q = (await k.engine.getQuotes(d.job_id)).quotes[0]!;
    const a = await k.engine.requestApproval(d.job_id, q.quote_id, "imessage");
    expect((await k.engine.ingestText({ messageId: "yes1", from: APPROVER, text: `YES ${a.code}`, inbound: true })).outcome).toBe("approved");
    expect((await mail(k, b, "Confirmed, we're all set for your event.")).outcome).toBe("booking_confirmed");
    k.p.fail("email", "5xx_after");
    expect((await k.engine.ingestText({ messageId: "paid1", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_confirmed");
    const key = `confirm:${a.id}`;
    const delivered = () => k.p.deliveries.filter((x) => x.key === key).length;
    expect(delivered()).toBe(1); // it arrived; only the response was lost
    for (let i = 0; i < 6; i++) {
      k.clock.advance(10 * 60_000);
      await k.engine.advanceJob(d.job_id);
      await k.engine.recoverStuck();
    }
    expect(k.p.attempts.filter((x) => x.key === key)).toHaveLength(1); // never attempted again
    const open = await openReviews(k, d.job_id);
    expect(open.filter((r) => r.subject === key)).toHaveLength(1);
  });
});
