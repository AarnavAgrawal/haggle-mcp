// The web app's rate limits (lib/rateLimit.ts): a fixed-window memory limiter, and the durable one over
// take_rate_slot (migration 124) through supabase.rpc, which fails open to the memory limiter (logged
// once per outage) when the database can't answer. Fake clients only.
import { describe, expect, it } from "vitest";
import { durableLimiter, memoryLimiter, unlimited, type RpcClient } from "../lib/rateLimit.ts";

describe("memoryLimiter", () => {
  it("grants max per window per key, then refuses with the seconds until the window ends", async () => {
    let t = 1_000_000; // a 600 s window aligned to the epoch: [600 000, 1 200 000)
    const l = memoryLimiter(2, 600_000, { now: () => t });
    expect(await l.take("a")).toEqual({ ok: true });
    expect(await l.take("a")).toEqual({ ok: true });
    expect(await l.take("a")).toEqual({ ok: false, retryAfterS: 200 });
    expect(await l.take("b")).toEqual({ ok: true });
    t = 1_200_000;
    expect(await l.take("a")).toEqual({ ok: true });
  });

  it("an 86 400 s window is the UTC day", async () => {
    let t = Date.UTC(2026, 9, 22, 23, 59, 0);
    const l = memoryLimiter(1, 86_400_000, { now: () => t });
    expect((await l.take("site")).ok).toBe(true);
    expect(await l.take("site")).toEqual({ ok: false, retryAfterS: 60 });
    t = Date.UTC(2026, 9, 23, 0, 0, 0);
    expect((await l.take("site")).ok).toBe(true);
  });

  it("stays bounded as keys pile up", async () => {
    let t = 0;
    const l = memoryLimiter(1, 60_000, { now: () => t });
    for (let i = 0; i < 12_000; i++) await l.take(`u${i}`);
    t = 120_000;
    // The next sweep runs once the map has doubled since the last one; it drops the 12,000 finished windows.
    for (let i = 0; i < 9_000; i++) await l.take(`fresh${i}`);
    expect(l.size()).toBeLessThanOrEqual(9_000);
    expect((await l.take("fresh0")).ok).toBe(false); // the live window survived the sweep
  });

  it("unlimited never refuses", async () => {
    for (let i = 0; i < 100; i++) expect((await unlimited.take("x")).ok).toBe(true);
  });
});

/** A fake supabase client: records rpc calls and answers with `answer()`. */
function fakeRpc(answer: () => Promise<{ data: unknown; error: { message: string } | null }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client: RpcClient = { rpc: (fn, args) => { calls.push({ fn, args }); return answer(); } };
  return { client, calls };
}

describe("durableLimiter", () => {
  it("asks take_rate_slot with the bucket, key, window and max, and follows its answer", async () => {
    const { client, calls } = fakeRpc(async () => ({ data: [{ allowed: false, used: 20, retry_after_s: 42 }], error: null }));
    const l = durableLimiter("web_chat_turns", 20, 600, () => client);
    expect(await l.take("user-1")).toEqual({ ok: false, retryAfterS: 42 });
    expect(calls).toEqual([{ fn: "take_rate_slot", args: { p_bucket: "web_chat_turns", p_key: "user-1", p_window_s: 600, p_max: 20 } }]);
    const ok = durableLimiter("b", 1, 60, () => fakeRpc(async () => ({ data: [{ allowed: true, used: 1, retry_after_s: 0 }], error: null })).client);
    expect(await ok.take("k")).toEqual({ ok: true });
  });

  it("an RPC error falls back to the memory limiter for that process, logged once per outage", async () => {
    let t = 0;
    let fail = true;
    const logs: unknown[] = [];
    const { client, calls } = fakeRpc(async () => (fail ? { data: null, error: { message: "relation \"rate_limit_slots\" does not exist" } } : { data: [{ allowed: true, used: 1, retry_after_s: 0 }], error: null }));
    const l = durableLimiter("web_account_delete", 2, 600, () => client, { now: () => t, log: (e, d) => logs.push([e, d]), retryMs: 30_000 });
    expect(await l.take("u")).toEqual({ ok: true });
    expect(await l.take("u")).toEqual({ ok: true });
    expect((await l.take("u")).ok).toBe(false); // the memory limiter still limits
    expect(calls).toHaveLength(1); // while it is down, the database isn't asked again until retryMs passes
    t = 31_000;
    await l.take("v");
    expect(calls).toHaveLength(2);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).toMatch(/web_account_delete/);
    expect(JSON.stringify(logs)).not.toMatch(/service_role|eyJ/);
    fail = false;
    t = 62_000;
    expect(await l.take("w")).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("a thrown client, a missing client, a malformed answer or a hung call falls back too (fail open, never closed)", async () => {
    const logs: unknown[] = [];
    const log = (e: string) => { logs.push(e); };
    const thrown = durableLimiter("b", 5, 60, () => fakeRpc(async () => { throw new TypeError("fetch failed"); }).client, { log });
    expect(await thrown.take("k")).toEqual({ ok: true });
    const missing = durableLimiter("b", 5, 60, () => { throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set"); }, { log });
    expect(await missing.take("k")).toEqual({ ok: true });
    const weird = durableLimiter("b", 5, 60, () => fakeRpc(async () => ({ data: [{ nope: 1 }], error: null })).client, { log });
    expect(await weird.take("k")).toEqual({ ok: true });
    const hung = durableLimiter("b", 5, 60, () => fakeRpc(() => new Promise(() => {})).client, { log, timeoutMs: 20 });
    expect(await hung.take("k")).toEqual({ ok: true });
    expect(logs).toHaveLength(4);
  });
});
