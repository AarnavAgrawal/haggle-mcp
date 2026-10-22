// Structured redacted logging (live/log.ts) and operator alerts (live/alerts.ts). Fake sinks and a
// fake fetch only: nothing leaves the process.
import { describe, expect, it } from "vitest";
import { createAlerter, createLogger, redact, redactText, validAlertUrl } from "../src/index.ts";

describe("redaction", () => {
  it("masks emails, phone numbers, keys, tokens and credentials in free text", () => {
    const s = redactText("from orders@harbor-table.example (+14155550123, (415) 555-0199) key sk_test_51Habc123def456 sk-ant-api03-AbCdEf123456 whsec_abcdef123456 Bearer abcdefghijklmnop hgw_abcdefghijkl postgres://postgres.ref:hunter2pass@aws-0.pooler.supabase.com:5432/postgres /c/abcdefghijklmnopqrstuv/mcp?token=supersecret");
    for (const leak of ["orders@harbor-table.example", "+14155550123", "555-0199", "sk_test_51Habc", "sk-ant-api03", "whsec_abcdef", "abcdefghijklmnop", "hgw_abcdefghijkl", "hunter2pass", "postgres.ref", "abcdefghijklmnopqrstuv", "supersecret"]) expect(s).not.toContain(leak);
    expect(s).toContain("aws-0.pooler.supabase.com"); // the host stays (useful, not secret)
  });

  it("keeps dates, amounts, ids and short codes readable", () => {
    const s = redactText("job_abc123 HG-7KQ2 $1,150.00 on 2026-10-22T10:00:00.000Z, 40 people, biz_8888888888888888");
    expect(s).toBe("job_abc123 HG-7KQ2 $1,150.00 on 2026-10-22T10:00:00.000Z, 40 people, biz_8888888888888888");
  });

  it("masks secret-named and contact-named fields whatever their value looks like", () => {
    const r = redact({ api_key: "abc", nested: { webhookSecret: "x", password: "p", authorization: "Basic Zm9v", to: "+14155550123", approver_email: "ops@acme.example" }, list: ["call me at 415-555-0123"], err: new Error("Inkbox refused orders@x.example") }) as Record<string, any>;
    expect(r.api_key).toBe("[redacted]");
    expect(r.nested).toEqual({ webhookSecret: "[redacted]", password: "[redacted]", authorization: "[redacted]", to: "[phone]", approver_email: "[email]" });
    expect(r.list[0]).toBe("call me at [phone]");
    expect(r.err).toEqual({ name: "Error", message: "Inkbox refused [email]" });
  });
});

describe("logger", () => {
  it("writes one JSON line per event, redacted, with base fields and levels", () => {
    const lines: [string, string][] = [];
    const log = createLogger({ sink: (l, line) => lines.push([l, line]), now: () => new Date("2026-10-22T00:00:00Z"), fields: { service: "haggle-mcp" } });
    log.info("email_sent", { to: "a@b.example", job_id: "job_1" });
    log.child({ job_id: "job_2" }).error("tick_failed", { error: new Error("connect ECONNREFUSED postgres://u:pw@db.example:5432/x") });
    log.debug("noise", {});
    expect(lines).toHaveLength(2);
    const [a, b] = lines.map(([, l]) => JSON.parse(l));
    expect(a).toEqual({ ts: "2026-10-22T00:00:00.000Z", level: "info", event: "email_sent", service: "haggle-mcp", to: "[email]", job_id: "job_1" });
    expect(lines[1]![0]).toBe("error");
    expect(b.job_id).toBe("job_2");
    expect(JSON.stringify(b)).not.toContain("pw@");
  });

  it("the engine adapter picks warn/error from the event name and never throws", () => {
    const levels: string[] = [];
    const log = createLogger({ sink: (l) => { levels.push(l); throw new Error("sink down"); } });
    expect(() => { log.engine("parse_failed", {}); log.engine("parse_retry", {}); log.engine("rfq_sent", {}); }).not.toThrow();
    expect(levels).toEqual(["error", "warn", "info"]);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info("odd", circular)).not.toThrow();
  });
});

describe("alerts", () => {
  const fakeFetch = () => {
    const calls: { url: string; body: string }[] = [];
    let status = 200;
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body) }); return new Response("ok", { status }); }) as unknown as typeof fetch;
    return { f, calls, fail: (s: number) => { status = s; } };
  };

  it("is off without an https URL; never posts", async () => {
    const { f, calls } = fakeFetch();
    expect(validAlertUrl("http://hooks.example/x")).toBe(false);
    for (const url of [undefined, "", "http://hooks.example/x", "not a url"]) {
      const a = createAlerter({ url, fetch: f });
      expect(a.enabled).toBe(false);
      expect(await a.alert({ key: "k", severity: "warn", summary: "s" })).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("posts Slack-compatible JSON, redacted, deduplicated per key and rate limited overall", async () => {
    const { f, calls } = fakeFetch();
    let t = 0;
    const a = createAlerter({ url: "https://hooks.example/T000/B000/secret", fetch: f, now: () => t, dedupeMs: 60_000, maxPerWindow: 3, windowMs: 600_000, source: "haggle staging" });
    expect(await a.alert({ key: "stalled:job_1", severity: "warn", summary: "Job job_1 stalled; vendor orders@x.example +14155550123", details: { token: "sk_test_abcdefgh1234", age_s: 900 } })).toBe(true);
    expect(await a.alert({ key: "stalled:job_1", severity: "warn", summary: "again" })).toBe(false); // deduped
    const body = JSON.parse(calls[0]!.body);
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body.text).toMatch(/^\[WARN\] haggle staging: Job job_1 stalled/);
    expect(body.text).not.toMatch(/orders@x\.example|\+14155550123|sk_test_abcdefgh1234/);
    await a.alert({ key: "b", severity: "warn", summary: "b" });
    await a.alert({ key: "c", severity: "critical", summary: "c" });
    expect(await a.alert({ key: "d", severity: "warn", summary: "d" })).toBe(false); // 3 per window
    t = 700_000;
    expect(await a.alert({ key: "d", severity: "warn", summary: "d" })).toBe(true); // window passed
    expect(await a.alert({ key: "stalled:job_1", severity: "warn", summary: "later" })).toBe(true); // dedupe expired
    expect(a.stats()).toMatchObject({ enabled: true, sent: 5, suppressed: 2, failed: 0 });
  });

  it("a failing webhook is counted and logged without its URL, and never throws", async () => {
    const { f, fail } = fakeFetch();
    fail(500);
    const lines: string[] = [];
    const a = createAlerter({ url: "https://hooks.example/T000/B000/secretpath", fetch: f, logger: createLogger({ sink: (_l, line) => lines.push(line) }) });
    expect(await a.alert({ key: "x", severity: "critical", summary: "payment errors" })).toBe(false);
    const thrower = createAlerter({ url: "https://hooks.example/T/B/s", fetch: (async () => { throw new Error("getaddrinfo ENOTFOUND https://hooks.example/T/B/s"); }) as unknown as typeof fetch, logger: createLogger({ sink: (_l, line) => lines.push(line) }) });
    expect(await thrower.alert({ key: "y", severity: "warn", summary: "s" })).toBe(false);
    expect(a.stats().failed).toBe(1);
    expect(lines.join("\n")).not.toMatch(/secretpath|hooks\.example\/T\/B\/s/);
    expect(lines.some((l) => JSON.parse(l).event === "alert_failed")).toBe(true);
  });
});
