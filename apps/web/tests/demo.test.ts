// Demo-site switches (lib/demo.ts) and the site-wide daily chat cap (lib/chat/limits.ts). Pure, no network.
import { describe, expect, it } from "vitest";
import { autoOnboard, chatExamples, DEMO_EXAMPLES } from "../lib/demo.ts";
import { dailyCap, takeChatTurn } from "../lib/chat/limits.ts";
import { memoryLimiter } from "../lib/rateLimit.ts";

describe("demo site", () => {
  it("guests always skip the onboarding form; on a demo site everyone does", () => {
    expect(autoOnboard({ is_anonymous: true }, false)).toBe(true);
    expect(autoOnboard({ is_anonymous: false }, false)).toBe(false);
    expect(autoOnboard({ is_anonymous: false }, true)).toBe(true);
  });

  it("demo examples are catering requests the simulated businesses can answer", () => {
    expect(chatExamples(true)).toBe(DEMO_EXAMPLES);
    expect(DEMO_EXAMPLES.every((x) => /cater|breakfast|lunch|dinner/i.test(x))).toBe(true);
    expect(chatExamples(false).some((x) => /sink/i.test(x))).toBe(true);
  });
});

describe("site-wide daily chat cap", () => {
  const DAY = 24 * 3600 * 1000;
  it("allows up to the cap per UTC day, then refuses until the next day", async () => {
    let t = 0;
    const cap = dailyCap(3, (max, windowS) => memoryLimiter(max, windowS * 1000, { now: () => t }));
    const take = (at: number) => { t = at; return cap.take("site"); };
    const t0 = Date.UTC(2026, 9, 22, 10);
    expect([await take(t0), await take(t0 + 1), await take(t0 + 2)].every((r) => r.ok)).toBe(true);
    expect(await take(t0 + 3)).toMatchObject({ ok: false });
    expect((await take(t0 + DAY)).ok).toBe(true);
  });

  it("no cap configured: unlimited", async () => {
    const cap = dailyCap(0, () => { throw new Error("no limiter for no cap"); });
    for (let i = 0; i < 1000; i++) expect((await cap.take("site")).ok).toBe(true);
  });
});

describe("chat turn gate order (per-user first, then the site-wide cap)", () => {
  it("a user's refused turns never use the shared daily budget", async () => {
    const chatTurns = memoryLimiter(2, 600_000, { now: () => 0 });
    const chatDaily = dailyCap(3, (max, windowS) => memoryLimiter(max, windowS * 1000, { now: () => 0 }));
    const gate = { chatTurns, chatDaily };
    expect(await takeChatTurn(gate, "spammer")).toEqual({ ok: true });
    expect(await takeChatTurn(gate, "spammer")).toEqual({ ok: true });
    for (let i = 0; i < 10; i++) expect(await takeChatTurn(gate, "spammer")).toMatchObject({ ok: false, code: "rate_limited" });
    // The cap is 3 and the spammer was granted 2, so exactly one more turn fits for everyone else.
    expect(await takeChatTurn(gate, "someone-else")).toEqual({ ok: true });
    expect(await takeChatTurn(gate, "a-third-user")).toEqual({ ok: false, code: "daily_limit" });
  });

  it("a per-user refusal carries retry_after; the cap isn't consulted", async () => {
    let dailyTakes = 0;
    const gate = {
      chatTurns: { take: async () => ({ ok: false as const, retryAfterS: 120 }) },
      chatDaily: { take: async () => { dailyTakes++; return { ok: true as const }; } },
    };
    expect(await takeChatTurn(gate, "u")).toEqual({ ok: false, code: "rate_limited", retryAfterS: 120 });
    expect(dailyTakes).toBe(0);
  });
});
