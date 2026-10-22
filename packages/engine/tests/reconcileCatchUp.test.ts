// Reconciler catch-up after restarts and long outages (sprint 4, workstream F; live/reconcileWindow.ts,
// migration 117 reconcile_cursors). The normal sweep looks back 6 h: after a 2-day outage, replies
// whose webhooks were lost while the server was down were never listed again. With a durable
// high-water mark per channel the sweep catches up from it in bounded slices (oldest first, halving
// a slice whose listing hits its page limit), moves the mark only over clean ranges, and logs a gap
// it won't cover automatically. Real engine; a fake Inkbox mailbox that honours start/end times.
import { describe, expect, it } from "vitest";
import { CATCH_UP, catchUpRange, disabledPayer, GOLDEN_REQUEST, HaggleEngine, InboundReconciler, inkboxEmail, InMemoryRepository, StubBrain, walkCatchUp, type CatchUpParams } from "../src/index.ts";
import { BUYER, FakeInkbox } from "./helpers/fakeInkbox.ts";
import { textExtractor } from "./helpers/reliabilityKit.ts";

const HARBOR = "harbor-table-sf@inkboxmail.test";
const SUNSET = "sunset-kitchen-sf@inkboxmail.test";
const H = 3_600_000;
const { budget_usd: _b, ...request } = GOLDEN_REQUEST;

/** FakeInkbox whose messages carry createdAt and whose listing honours startDatetime / endDatetime (newest first). */
class TimedInkbox extends FakeInkbox {
  readonly listed: { start?: string; end?: string }[] = [];
  private readonly clock: { now: () => Date };
  constructor(clock: { now: () => Date }) {
    super();
    this.clock = clock;
  }
  stamp<T extends object>(m: T): T {
    (m as { createdAt?: string }).createdAt = this.clock.now().toISOString();
    return m;
  }
  override reply(...a: Parameters<FakeInkbox["reply"]>) {
    return this.stamp(super.reply(...a));
  }
  /** Mail to the buyer from no business (newsletters, noise): listed, never ingested. */
  noise(n: number, spreadMs: number) {
    const t0 = this.clock.now().getTime();
    for (let i = 0; i < n; i++) {
      const id = `noise_${t0}_${i}`;
      this.messages.set(id, { id, mailbox: BUYER, direction: "inbound", threadId: null, messageId: `<${id}@news.test>`, fromAddress: "news@news.test", toAddresses: ["list@news.test"], subject: "news", bodyText: "x", inReplyTo: null, references: null, attachmentMetadata: null, createdAt: new Date(t0 - Math.floor((i * spreadMs) / n)).toISOString() } as never);
    }
  }
  override async *list(mailbox: string, o?: { direction?: string; startDatetime?: string; endDatetime?: string }) {
    if (this.listError) throw this.listError;
    this.listed.push({ ...(o?.startDatetime ? { start: o.startDatetime } : {}), ...(o?.endDatetime ? { end: o.endDatetime } : {}) });
    const at = (m: { createdAt?: string }) => Date.parse(m.createdAt ?? "1970-01-01T00:00:00Z");
    const items = [...this.messages.values()].filter((m) => m.mailbox === mailbox && (!o?.direction || m.direction === o.direction)
      && (!o?.startDatetime || at(m as never) >= Date.parse(o.startDatetime)) && (!o?.endDatetime || at(m as never) < Date.parse(o.endDatetime)));
    for (const m of items.sort((a, b) => at(b as never) - at(a as never))) yield m;
  }
}

function setup(o: { catchUp?: Partial<CatchUpParams> | false; maxItems?: number; repo?: InMemoryRepository } = {}) {
  let t = Date.parse("2026-10-20T09:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const api = new TimedInkbox(clock);
  const repo = o.repo ?? new InMemoryRepository();
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => { logs.push({ event, data }); };
  const engine = new HaggleEngine({
    repo, now: clock.now, email: inkboxEmail(api, BUYER), extractor: textExtractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), log,
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 5 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
  });
  const reconciler = (cu = o.catchUp) => new InboundReconciler({
    engine, repo, log, now: clock.now, ...(o.maxItems ? { maxItems: o.maxItems } : {}), ...(cu !== undefined ? { catchUp: cu } : {}),
    sources: { mail: { api, buyerMailbox: BUYER, senderTrust: { policy: "outbound-verified" }, identityAddresses: async () => [BUYER, HARBOR, SUNSET] } },
  });
  return { engine, repo, api, clock, logs, reconciler };
}

async function outage(env: ReturnType<typeof setup>) {
  const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: HARBOR }, { name: "Sunset Kitchen", email: SUNSET }] });
  await env.reconciler().sweepAll(); // the server is up: the marks are set
  const bs = await env.repo.getBusinesses(deal.job_id);
  const rfq = (email: string) => bs.find((b) => b.email === email)!.rfq_message_id!;
  // The server goes down for two days; both replies arrive meanwhile and their webhooks are lost.
  env.clock.advance(1 * H);
  const harbor = env.api.reply(HARBOR, rfq(HARBOR), "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
  env.clock.advance(29 * H);
  const sunset = env.api.reply(SUNSET, rfq(SUNSET), "$1,200 total all-in, 12 vegetarian, delivered.");
  env.clock.advance(18 * H);
  return { jobId: deal.job_id, harbor, sunset };
}

describe("catch-up after a 2-day outage", () => {
  it("without high-water marks the 6 h window misses both lost replies (the gap this closes)", async () => {
    const env = setup({ catchUp: false });
    const { harbor, sunset } = await outage(env);
    const r = await env.reconciler().sweepAll();
    expect(r.recovered.map((x) => x.providerId)).not.toContain(harbor.id);
    expect(r.recovered.map((x) => x.providerId)).not.toContain(sunset.id);
  });

  it("with them, the first sweep after restart recovers every lost reply, once, oldest first; the mark reaches now", async () => {
    const env = setup();
    const { jobId, harbor, sunset } = await outage(env);
    const rec = env.reconciler(); // a fresh process: nothing in memory, the mark is in the database
    const r = await rec.sweepAll();
    expect(r.recovered.map((x) => x.providerId)).toEqual([harbor.id, sunset.id]);
    expect(await env.repo.getReconcileCursor(BUYER, "email")).toBe(env.clock.now().toISOString());
    // Bounded: 6 h slices from the mark, then the normal window; nothing listed twice into the store.
    expect(env.api.listed.filter((l) => l.end).length).toBeLessThanOrEqual(CATCH_UP.maxSlicesPerSweep * 2);
    expect((await env.reconciler().sweepAll()).recovered).toEqual([]);
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes.map((q) => q.total_usd).sort()).toEqual([1000, 1200]);
    expect(env.logs.some((l) => l.event === "reconcile_catch_up" && l.data.channel === "email" && l.data.complete === true)).toBe(true);
  });

  it("a slice whose listing hits the page limit is halved until it fits; the reply behind a burst of mail is still found", async () => {
    const env = setup({ maxItems: 20 });
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: HARBOR }] });
    await env.reconciler().sweepAll();
    env.clock.advance(2 * H);
    const harbor = env.api.reply(HARBOR, (await env.repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    env.clock.advance(1 * H);
    env.api.noise(45, 50 * 60_000); // a burst of 45 messages in the hour after the reply
    env.clock.advance(30 * H);
    const recovered: string[] = [];
    for (let i = 0; i < 6; i++) recovered.push(...(await env.reconciler().sweepAll()).recovered.map((x) => x.providerId));
    expect(recovered).toEqual([harbor.id]);
    expect(await env.repo.getReconcileCursor(BUYER, "email")).toBe(env.clock.now().toISOString());
  });

  it("a listing error stops the catch-up at the mark (never skipped); the next sweep resumes from there", async () => {
    const env = setup();
    const { harbor } = await outage(env);
    const markBefore = await env.repo.getReconcileCursor(BUYER, "email");
    env.api.listError = new Error("Inkbox unreachable (timeout)");
    await env.reconciler().sweepAll();
    expect(await env.repo.getReconcileCursor(BUYER, "email")).toBe(markBefore);
    env.api.listError = null;
    expect((await env.reconciler().sweepAll()).recovered.map((x) => x.providerId)).toContain(harbor.id);
  });

  it("an outage longer than the catch-up limit is swept as far back as allowed and the gap is logged (alerted) for a person", async () => {
    const env = setup({ catchUp: { maxCatchUpMs: 24 * H } });
    const { harbor, sunset } = await outage(env); // harbor arrived 47 h ago, sunset 18 h ago
    const r = await env.reconciler().sweepAll();
    expect(r.recovered.map((x) => x.providerId)).toEqual([sunset.id]);
    expect(r.recovered.map((x) => x.providerId)).not.toContain(harbor.id);
    expect(env.logs.find((l) => l.event === "reconcile_gap")).toMatchObject({ data: { channel: "email" } });
  });

  it("no reconcile_cursors table (117 not applied): the plain window, as before, logged once", async () => {
    const repo = new InMemoryRepository();
    repo.getReconcileCursor = async () => { throw Object.assign(new Error('relation "reconcile_cursors" does not exist'), { code: "42P01" }); };
    const env = setup({ repo });
    const { sunset } = await outage(env);
    const unavailable = () => env.logs.filter((l) => l.event === "reconcile_cursor_unavailable").length;
    const before = unavailable();
    const rec = env.reconciler();
    expect((await rec.sweepAll()).recovered.map((x) => x.providerId)).not.toContain(sunset.id); // the plain 6 h window, as before (18 h ago: missed)
    await rec.sweepAll();
    expect(unavailable() - before).toBe(1); // once per process, then off
    expect(env.logs.find((l) => l.event === "reconcile_cursor_unavailable")).toMatchObject({ data: { disabled: true } });
  });
});

describe("catch-up planning (pure)", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  it("no mark, or a mark inside the normal window: nothing to catch up", () => {
    expect(catchUpRange({ highWater: null, recentSince: now - 6 * H, nowMs: now })).toBeNull();
    expect(catchUpRange({ highWater: new Date(now - 60_000).toISOString(), recentSince: now - 6 * H, nowMs: now })).toBeNull();
  });
  it("a mark before the window: from the mark less the overlap, clamped at the limit", () => {
    expect(catchUpRange({ highWater: new Date(now - 48 * H).toISOString(), recentSince: now - 6 * H, nowMs: now })).toEqual({ from: now - 48 * H - CATCH_UP.overlapMs, to: now - 6 * H, clamped: false });
    expect(catchUpRange({ highWater: new Date(now - 30 * 24 * H).toISOString(), recentSince: now - 6 * H, nowMs: now })).toMatchObject({ from: now - CATCH_UP.maxCatchUpMs, clamped: true });
  });
  it("walkCatchUp: oldest first, halves truncated slices, stops at an error, bounded per sweep", async () => {
    const p = { ...CATCH_UP, sliceMs: 4 * H, minSliceMs: H, maxSlicesPerSweep: 10 };
    const seen: [number, number][] = [];
    const marks: number[] = [];
    const w = await walkCatchUp({ from: 0, to: 12 * H }, async (f, t) => { seen.push([f, t]); return { clean: true, truncated: f === 0 && t - f > H }; }, async (t) => { marks.push(t); }, p);
    expect(seen.slice(0, 3)).toEqual([[0, 4 * H], [0, 2 * H], [0, H]]);
    expect(w).toMatchObject({ complete: true, stuck: null, reached: 12 * H });
    expect(marks[0]).toBe(H);
    const err = await walkCatchUp({ from: 0, to: 12 * H }, async (f) => ({ clean: f < 4 * H, truncated: false }), async () => {}, p);
    expect(err).toMatchObject({ complete: false, stuck: "error", reached: 4 * H });
    const bounded = await walkCatchUp({ from: 0, to: 100 * H }, async () => ({ clean: true, truncated: false }), async () => {}, { ...p, maxSlicesPerSweep: 3 });
    expect(bounded).toMatchObject({ complete: false, listings: 3, reached: 12 * H, stuck: null });
  });
});
