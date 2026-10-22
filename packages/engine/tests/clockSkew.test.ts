import { describe, expect, it, vi } from "vitest";

// scripts/test-clock-skew.sh runs the suites with the wall clock moved (scripts/clock-skew.mjs). This
// proves the skew really reaches the test workers, so a green skewed run means something.
const target = process.env.HAGGLE_TEST_CLOCK_SKEW;
const near = (ms: number) => Math.abs(ms - Date.parse(target!)) < 6 * 3600_000;

describe.skipIf(!target)("clock skew (HAGGLE_TEST_CLOCK_SKEW)", () => {
  it("the worker's wall clock reads as the skew date", () => {
    expect(near(Date.now())).toBe(true);
    expect(near(new Date().getTime())).toBe(true);
  });
  it("a test's own fake timers still work, and the skewed clock comes back afterwards", () => {
    vi.useFakeTimers({ now: new Date("2000-01-01T00:00:00Z") });
    expect(new Date().toISOString()).toBe("2000-01-01T00:00:00.000Z");
    vi.useRealTimers();
    expect(near(Date.now())).toBe(true);
  });
});
