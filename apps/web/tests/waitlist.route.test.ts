// POST /api/waitlist (lib/waitlist/route.ts) and its Slack ping (lib/waitlist/slack.ts) with fakes: no
// Supabase, no Slack. The route is public, so what matters most is what it refuses and what it gives away.
import { describe, expect, it } from "vitest";
import { memoryLimiter, unlimited } from "../lib/rateLimit.ts";
import { handleJoin, type WaitlistDeps, type WaitlistRow } from "../lib/waitlist/route.ts";
import { joinMessage, postJoin } from "../lib/waitlist/slack.ts";

const VALID = { email: " Ada@Example.com ", full_name: "Ada Lovelace", organization: "Analytical Engines", use_case: "Cater our offsite" };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://tryhaggle.tech/api/waitlist", {
    method: "POST",
    headers: { origin: "https://tryhaggle.tech", "content-type": "application/json", "x-real-ip": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function fakes(over: Partial<WaitlistDeps> = {}) {
  const rows = new Map<string, WaitlistRow>();
  const announced: WaitlistRow[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const deps: WaitlistDeps = {
    insert: async (row) => {
      if (rows.has(row.email)) return false;
      rows.set(row.email, row);
      return true;
    },
    ipLimiter: unlimited,
    dailyLimiter: unlimited,
    announce: async (row) => {
      announced.push(row);
    },
    defer: (task) => {
      deferred.push(task);
    },
    ...over,
  };
  return { deps, rows, announced, deferred };
}

describe("POST /api/waitlist", () => {
  it("stores a valid join with the email lowercased and trimmed", async () => {
    const { deps, rows } = fakes();
    const res = await handleJoin(post(VALID), deps);
    expect(res.status).toBe(200);
    expect(rows.get("ada@example.com")).toEqual({ email: "ada@example.com", full_name: "Ada Lovelace", organization: "Analytical Engines", use_case: "Cater our offsite" });
  });

  it("treats the use case as optional", async () => {
    const { deps, rows } = fakes();
    const { use_case: _omit, ...rest } = VALID;
    expect((await handleJoin(post(rest), deps)).status).toBe(200);
    expect(rows.get("ada@example.com")?.use_case).toBeNull();
  });

  it.each([
    ["a bad email", { ...VALID, email: "not-an-email" }, "email"],
    ["a blank name", { ...VALID, full_name: "   " }, "full_name"],
    ["a missing organization", { ...VALID, organization: undefined }, "organization"],
    ["an over-long use case", { ...VALID, use_case: "x".repeat(501) }, "use_case"],
  ])("refuses %s and names the field", async (_label, body, field) => {
    const { deps, rows } = fakes();
    const res = await handleJoin(post(body), deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "invalid", field } });
    expect(rows.size).toBe(0);
  });

  it("refuses a body that isn't JSON", async () => {
    const res = await handleJoin(post("{nope"), fakes().deps);
    expect(res.status).toBe(400);
  });

  it("refuses a cross-site post", async () => {
    const { deps, rows } = fakes();
    const res = await handleJoin(post(VALID, { origin: "https://evil.example" }), deps);
    expect(res.status).toBe(403);
    expect(rows.size).toBe(0);
  });

  it("answers an existing email exactly as it answers a new one", async () => {
    const { deps } = fakes();
    const first = await handleJoin(post(VALID), deps);
    const second = await handleJoin(post({ ...VALID, full_name: "Someone Else" }), deps);
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
  });

  it("never overwrites an existing entry", async () => {
    const { deps, rows } = fakes();
    await handleJoin(post(VALID), deps);
    await handleJoin(post({ ...VALID, full_name: "Someone Else" }), deps);
    expect(rows.get("ada@example.com")?.full_name).toBe("Ada Lovelace");
  });

  it("gives a filled honeypot the normal success and stores nothing", async () => {
    const { deps, rows, deferred } = fakes();
    const res = await handleJoin(post({ ...VALID, website: "http://spam.example" }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ ok: true });
    expect(rows.size).toBe(0);
    expect(deferred).toHaveLength(0);
  });

  it("limits by IP and keys the limiter on a hash, never the raw address", async () => {
    const keys: string[] = [];
    const limiter = memoryLimiter(1, 60_000);
    const { deps } = fakes({ ipLimiter: { take: (k) => (keys.push(k), limiter.take(k)) } });
    expect((await handleJoin(post(VALID), deps)).status).toBe(200);
    const refused = await handleJoin(post(VALID), deps);
    expect(refused.status).toBe(429);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain("203.0.113.9");
  });

  it("uses the first forwarded address when there is no x-real-ip", async () => {
    const keys: string[] = [];
    const { deps } = fakes({ ipLimiter: { take: async (k) => (keys.push(k), { ok: true }) } });
    await handleJoin(post(VALID, { "x-real-ip": "", "x-forwarded-for": "198.51.100.7, 10.0.0.1" }), deps);
    await handleJoin(post(VALID, { "x-real-ip": "", "x-forwarded-for": "198.51.100.7, 10.0.0.2" }), deps);
    expect(keys[0]).toBe(keys[1]);
  });

  it("stops at the site-wide daily cap", async () => {
    const { deps, rows } = fakes({ dailyLimiter: { take: async () => ({ ok: false, retryAfterS: 60 }) } });
    const res = await handleJoin(post(VALID), deps);
    expect(res.status).toBe(429);
    expect(rows.size).toBe(0);
  });

  it("says so when the entry can't be stored", async () => {
    const { deps } = fakes({ insert: async () => { throw new Error("database down"); } });
    const res = await handleJoin(post(VALID), deps);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("database down");
  });

  it("announces a real insert after the response, and only a real insert", async () => {
    const { deps, announced, deferred } = fakes();
    await handleJoin(post(VALID), deps);
    await handleJoin(post(VALID), deps);
    expect(announced).toHaveLength(0); // nothing runs before the response
    expect(deferred).toHaveLength(1);
    await deferred[0]!();
    expect(announced.map((r) => r.email)).toEqual(["ada@example.com"]);
  });
});

describe("the Slack ping", () => {
  const row = { email: "ada@example.com", full_name: "Ada Lovelace", organization: "Analytical Engines", use_case: "Cater our offsite" };

  it("names the person and says how to let them in", () => {
    const text = joinMessage(row);
    for (const part of ["Ada Lovelace", "Analytical Engines", "ada@example.com", "Cater our offsite", "let in ada@example.com"]) expect(text).toContain(part);
  });

  it("escapes what a stranger typed, so it can't ping the channel or fake a link", () => {
    const text = joinMessage({ ...row, full_name: "<!channel> & co", use_case: "<https://evil.example|click me>" });
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<https://evil.example");
    expect(text).toContain("&lt;!channel&gt; &amp; co");
  });

  it("posts the message to the webhook", async () => {
    const sent: { url: string; body: { text?: string } }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) as { text?: string } });
      return new Response("ok");
    }) as unknown as typeof fetch;
    await postJoin("https://hooks.slack.test/x", row, fetchImpl);
    expect(sent[0]?.url).toBe("https://hooks.slack.test/x");
    expect(sent[0]?.body.text).toContain("Ada Lovelace");
  });

  it("does nothing without a webhook", async () => {
    let called = false;
    await postJoin(undefined, row, (async () => { called = true; return new Response("ok"); }) as unknown as typeof fetch);
    expect(called).toBe(false);
  });

  it("never throws when Slack fails", async () => {
    await expect(postJoin("https://hooks.slack.test/x", row, (async () => { throw new Error("slack down"); }) as unknown as typeof fetch)).resolves.toBeUndefined();
    await expect(postJoin("https://hooks.slack.test/x", row, (async () => new Response("no", { status: 500 })) as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
