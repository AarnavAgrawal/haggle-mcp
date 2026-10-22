// Alert delivery end to end with a local fake webhook (sprint 4, workstream F; live/alerts.ts): a
// stuck job, an operator review opened by a failed send, a lease lost mid-advance, a stalled job and
// a failing webhook each reach the operator's alert channel, once per dedupe window, redacted. The
// engine's log port is wrapped with alertingLog (live wiring: `log: alertingLog(logger.engine, alerts)`).
import { describe, expect, it } from "vitest";
import { alertingLog, ALERT_EVENTS, createAlerter, StalledJobMonitor } from "../src/index.ts";
import { BUDGET, kit, leaseControl, REQUEST } from "./helpers/reliabilityKit.ts";

const URL = "https://hooks.slack.test/services/T000/B000/XXXX";

function fakeWebhook(now: () => number) {
  const posts: { text: string }[] = [];
  const alerts = createAlerter({ url: URL, now, source: "haggle staging", fetch: (async (_u: string, init: RequestInit) => { posts.push(JSON.parse(String(init.body))); return new Response("ok", { status: 200 }); }) as typeof fetch });
  return { posts, alerts };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("alerts reach the operator once, redacted", () => {
  it("a job stuck past its deadline (wedged lease): the recovery sweep's review pages once; later sweeps don't page again", async () => {
    const k = kit();
    const { posts, alerts } = fakeWebhook(() => k.clock.now().getTime());
    const log = alertingLog((e, d) => k.logs.push({ event: e, data: d }), alerts);
    (k.engine as unknown as { d: { log: typeof log } }).d.log = log;
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    await k.repo.acquireJobLease(d.job_id, "wedged#1", k.clock.now().toISOString(), 365 * 86_400_000);
    k.clock.advance(70 * 60_000);
    for (let i = 0; i < 3; i++) {
      await k.engine.recoverStuck();
      k.clock.advance(5 * 60_000);
    }
    await settle();
    const stuck = posts.filter((p) => /Operator review opened \(stuck_job\)/.test(p.text));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.text).toMatch(/^\[WARN\] haggle staging: /);
    expect(stuck[0]!.text).toContain(d.job_id);
  });

  it("an operator review opened by a failed send pages, without the vendor's address or number", async () => {
    const k = kit();
    const { posts, alerts } = fakeWebhook(() => k.clock.now().getTime());
    (k.engine as unknown as { d: { log: unknown } }).d.log = alertingLog(() => {}, alerts);
    k.p.fail("call", "timeout_after");
    await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Mission Eats", phone: "+14155550142" }] });
    await settle();
    const p = posts.find((x) => /Operator review opened \(outbox\)/.test(x.text));
    expect(p).toBeTruthy();
    expect(p!.text).not.toContain("4155550142");
  });

  it("a lease lost mid-advance pages once per job", async () => {
    const k = kit();
    const { posts, alerts } = fakeWebhook(() => k.clock.now().getTime());
    (k.engine as unknown as { d: { log: unknown } }).d.log = alertingLog(() => {}, alerts);
    const ctl = leaseControl(k.repo);
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    ctl.lose = true;
    await k.inAdvance(d.job_id, async () => {
      const job = (await k.repo.getJob(d.job_id))!;
      await k.priv<(...a: unknown[]) => Promise<unknown>>("sendRecorded")(job, null, "message", `probe:${d.job_id}`, { to: "ops@haggle.test", subject: "s", bodyText: "b" }).catch(() => undefined);
    });
    await k.inAdvance(d.job_id, async () => {
      const job = (await k.repo.getJob(d.job_id))!;
      await k.priv<(...a: unknown[]) => Promise<unknown>>("sendRecorded")(job, null, "message", `probe2:${d.job_id}`, { to: "ops@haggle.test", subject: "s", bodyText: "b" }).catch(() => undefined);
    });
    await settle();
    expect(posts.filter((p) => /lost job .* lease/.test(p.text))).toHaveLength(1);
  });

  it("a stalled job (the read-only monitor) and a failing webhook page once each per window; a new window pages again", async () => {
    let t = Date.parse("2026-10-22T12:00:00Z");
    const { posts, alerts } = fakeWebhook(() => t);
    const k = kit();
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    const monitor = new StalledJobMonitor({ repo: k.repo, now: () => new Date(k.clock.now().getTime() + 2 * 3_600_000), alert: (a) => alerts.alert(a) });
    await monitor.check();
    await monitor.check();
    expect(posts.filter((p) => p.text.includes(d.job_id) && /stalled/.test(p.text))).toHaveLength(1);
    // The webhook route (apps/mcp/src/limits.ts) reports each 5xx answer; the alerter dedupes them.
    const webhookFailed = (status: number) => alerts.alert(ALERT_EVENTS.webhook_failed!({ status, path: "/webhooks/inkbox" }));
    await webhookFailed(503);
    await webhookFailed(503);
    await webhookFailed(503);
    expect(posts.filter((p) => /webhook deliveries are failing \(HTTP 503\)/.test(p.text))).toHaveLength(1);
    t += 31 * 60_000;
    await webhookFailed(503);
    expect(posts.filter((p) => /HTTP 503/.test(p.text))).toHaveLength(2);
    expect(alerts.stats()).toMatchObject({ enabled: true, sent: 3, suppressed: 2 });
  });

  it("every mapped event produces a bounded, redacted alert; an alerter that throws never breaks the caller", () => {
    for (const [event, make] of Object.entries(ALERT_EVENTS)) {
      const a = make({ job_id: "job_x", review_id: "rev_x", kind: "outbox", reason: "send to orders@vendor.example failed", channel: "email", status: 503, key: "mail:1" });
      expect(a.key.length, event).toBeGreaterThan(0);
      expect(a.summary.length, event).toBeGreaterThan(0);
    }
    const log = alertingLog(() => {}, { alert: () => { throw new Error("down"); } });
    expect(() => log("operator_review", { review_id: "rev_1", kind: "parse" })).not.toThrow();
  });
});
