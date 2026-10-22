// SIMULATED (sprint 5 A): a deal interrupted at any stage (a server restart, a new conversation, a lost
// lease) resumes from the store alone: a new engine instance finds it (recentDeals = list_deals), reads
// it (getQuotes) and carries on, with no RFQ, booking request, approval text or payment ask sent twice.
// Runs on the in-memory store and, under scripts/test-postgres.sh, on Postgres (per-run unique vendors
// and approver numbers: the suite shares one database). Fake ports; nothing is real.
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../src/index.ts";
import { PostgresRepository } from "../src/store/postgres.ts";
import type { Repository } from "../src/store/types.ts";
import { leaseControl } from "./helpers/reliabilityKit.ts";
import { purchaseEnv, REQUEST, type PurchaseEnv } from "./helpers/purchaseKit.ts";

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;

/** Every send that went out, by idempotency key: each key at most once. */
function assertNoDuplicateSends(env: PurchaseEnv) {
  const keys = [...env.emails.map((e) => `email|${e.idempotencyKey}`), ...env.texts.map((t) => `${t.via}|${t.idempotencyKey}`)];
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  expect(dupes, `sent twice: ${dupes.join(", ")}`).toEqual([]);
  const bodies = env.emails.map((e) => `${e.to}|${e.bodyText}`);
  expect(bodies.filter((b, i) => bodies.indexOf(b) !== i)).toEqual([]);
}

function ids() {
  const u = Math.random().toString(36).slice(2, 8);
  return { harbor: `events+${u}@harbor.example`, grill: `orders+${u}@grill.example`, approver: `+1415${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}` };
}

/** One deal, restarted (a new engine instance on the same store) after every stage. */
async function resumeAtEveryStage(repo: Repository | ((now: () => Date) => Repository)) {
  const id = ids();
  const env = purchaseEnv({ repo, approver: id.approver, instanceId: "first" });
  let engine = env.engine;
  const restart = async (label: string) => {
    engine = env.restart(label);
    // A new conversation: list_deals finds the deal, get_quotes reads it (and advances it once).
    const deals = await engine.recentDeals(20);
    expect(deals.map((d) => d.job_id), label).toContain(jobId);
    return engine.getQuotes(jobId);
  };
  const deal = await engine.deal({ request: REQUEST as never, budget_usd: 2500, businesses: [{ name: "Harbor Table", email: id.harbor }, { name: "Golden Grill", email: id.grill }] });
  const jobId = deal.job_id;
  expect(env.to(id.harbor)).toHaveLength(1);

  // 1. Contacted, waiting for replies.
  await restart("contacted");
  await engine.advanceJob(jobId);
  expect(env.to(id.harbor)).toHaveLength(1);
  expect(env.to(id.grill)).toHaveLength(1);

  // 2. Replies in; quotes still open.
  env.clock.advance(5 * 60_000);
  await env.mail(jobId, id.harbor, "$2,180 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit.", "verified", engine);
  await env.mail(jobId, id.grill, "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit.", "verified", engine);
  let board = await restart("quoted");
  expect(board.quotes.filter((q) => q.status === "current" && q.total_usd !== null)).toHaveLength(2);

  // 3. Quotes final: Haggle texts its recommendation once, however many instances advance.
  env.clock.advance(60_000); // every vendor answered: quotes are final at once
  board = await restart("final");
  await env.restart("other-replica").advanceJob(jobId);
  board = await engine.getQuotes(jobId);
  const harbor = board.quotes.find((q) => q.business === "Harbor Table" && q.status === "current")!;
  expect(board.recommended_quote_id).toBe(harbor.quote_id);
  expect(env.toApprover().filter((t) => /YES \d{4}/.test(t.text))).toHaveLength(1);

  // 4. A new conversation asks to approve the recommendation: the texted suggestion is claimed, not duplicated.
  await restart("approving");
  const a =await engine.requestApproval(jobId, harbor.quote_id, "imessage", "pay", { text: true });
  expect(env.toApprover().filter((t) => /YES \d{4}/.test(t.text)), JSON.stringify(env.toApprover())).toHaveLength(1);
  expect(a.code).toBe(/YES (\d{4})/.exec(env.toApprover().find((t) => /YES \d{4}/.test(t.text))!.text)![1]);
  expect((await env.human(`YES ${a.code}`, engine)).outcome).toBe("approved");
  expect(env.to(id.harbor).filter((e) => /Before anything is booked or paid/.test(e.bodyText))).toHaveLength(1);

  // 5. Approved, booking requested: restarts and replays never re-ask; a second YES changes nothing.
  board = await restart("booking");
  expect(board.purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });
  await env.restart("booking-2").advanceJob(jobId);
  expect((await env.human(`YES ${a.code}`, engine)).outcome).not.toBe("approved");
  expect(env.to(id.harbor).filter((e) => /Before anything is booked or paid/.test(e.bodyText))).toHaveLength(1);

  // 6. The vendor confirms (to whichever instance gets the webhook); the payment ask goes once.
  expect((await env.mail(jobId, id.harbor, "Confirmed for November 14, all set.", "verified", engine)).outcome).toBe("booking_confirmed");
  board = await restart("booked");
  expect(board.purchase).toMatchObject({ stage: "instructions_requested", booked: true });
  await env.restart("booked-2").advanceJob(jobId);
  expect(env.to(id.harbor).filter((e) => /Please reply with how you take payment/.test(e.bodyText))).toHaveLength(1);

  // 7. Instructions arrive, the human pays directly and texts PAID; the closing note goes once.
  await env.mail(jobId, id.harbor, "You can pay the deposit by invoice: we'll email it, or Zelle payments@harbor.example.", "verified", engine);
  board = await restart("instructions");
  expect(board.purchase).toMatchObject({ stage: "instructions_received" });
  expect((await env.human(`PAID ${a.code}`, engine)).outcome).toBe("handoff_confirmed");
  board = await restart("paid");
  expect(board.purchase).toMatchObject({ stage: "human_reported_paid", money_verified: false });
  expect((await env.human(`PAID ${a.code}`, env.restart("paid-2"))).outcome).toBe("handoff_already_confirmed");
  await engine.advanceJob(jobId);
  expect(env.to(id.harbor).filter((e) => /told us they have paid/.test(e.bodyText))).toHaveLength(1);
  assertNoDuplicateSends(env);
  // Golden Grill was never accepted.
  expect(env.to(id.grill).some((e) => /accepted your quote/.test(e.bodyText))).toBe(false);
}

describe("a deal resumes cleanly after every stage (in-memory store)", () => {
  it("restart after each stage: found by list_deals, read by get_quotes, nothing sent twice", async () => {
    await resumeAtEveryStage((now) => new InMemoryRepository({ now }));
  });

  it("a lease lost while texting 'all quotes are in' (ready_offered): the next advance offers again, once", async () => {
    const id = ids();
    const env = purchaseEnv({ repo: (now) => new InMemoryRepository({ now }), approver: id.approver });
    const ctl = leaseControl(env.repo);
    const deal = await env.engine.deal({ request: REQUEST as never, budget_usd: 2500, businesses: [{ name: "Harbor Table", email: id.harbor }, { name: "Golden Grill", email: id.grill }] });
    env.clock.advance(5 * 60_000);
    await env.mail(deal.job_id, id.harbor, "$2,180 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit.");
    await env.mail(deal.job_id, id.grill, "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit.");
    env.clock.advance(31 * 60_000);
    // Another instance takes the job mid-advance: every renewal fails, so every send is fenced.
    ctl.lose = true;
    await env.engine.advanceJob(deal.job_id);
    expect((await env.events(deal.job_id, "ready_offered"))).toHaveLength(1);
    expect(env.toApprover()).toHaveLength(0);
    ctl.lose = false;
    // The new holder (a restarted instance) advances: the offer is made again, and only once.
    const next = env.restart("new-holder");
    await next.advanceJob(deal.job_id);
    await next.advanceJob(deal.job_id);
    await env.engine.advanceJob(deal.job_id);
    expect(env.toApprover().filter((t) => /YES \d{4}/.test(t.text))).toHaveLength(1);
    expect((await env.repo.getJob(deal.job_id))!.state).toBe("awaiting_approval");
    assertNoDuplicateSends(env);
  });
});

describe.skipIf(!PG_URL)("a deal resumes cleanly after every stage (Postgres)", { timeout: 60_000 }, () => {
  it("restart after each stage: found by list_deals, read by get_quotes, nothing sent twice", async () => {
    const repo = new PostgresRepository(PG_URL!);
    try {
      await resumeAtEveryStage(repo);
    } finally {
      await repo.close();
    }
  });
});
