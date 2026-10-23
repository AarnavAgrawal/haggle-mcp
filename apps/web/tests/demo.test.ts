// Demo-site switches (lib/demo.ts) and the site-wide daily chat cap (lib/chat/limits.ts). Pure, no network.
import { describe, expect, it } from "vitest";
import { autoOnboard, chatExamples, DEMO_EXAMPLES } from "../lib/demo.ts";
import { dailyCap } from "../lib/chat/limits.ts";

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
  it("allows up to the cap per UTC day, then refuses until the next day", () => {
    const take = dailyCap(3);
    const t0 = Date.UTC(2026, 9, 22, 10);
    expect([take(t0), take(t0 + 1), take(t0 + 2)].every((r) => r.ok)).toBe(true);
    expect(take(t0 + 3)).toMatchObject({ ok: false });
    expect(take(t0 + DAY).ok).toBe(true);
  });

  it("no cap configured: unlimited", () => {
    const take = dailyCap(0);
    for (let i = 0; i < 1000; i++) expect(take(i).ok).toBe(true);
  });
});
