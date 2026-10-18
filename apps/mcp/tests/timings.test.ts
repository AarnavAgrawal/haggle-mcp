// HAGGLE_DEMO_SPEED (decision 49): off by default with today's timings; on, Haggle's own waits are
// shortened for a ~2-minute demo video. Pure config; no network.
import { describe, expect, it } from "vitest";
import { liveTimings, mockDemoConfig } from "../src/timings.ts";

describe("demo speed switch", () => {
  it("off (unset or anything but 'true'): today's live timings, exactly", () => {
    for (const env of [{}, { HAGGLE_DEMO_SPEED: "false" }, { HAGGLE_DEMO_SPEED: "1" }]) {
      expect(liveTimings(env)).toEqual({
        demoSpeed: false, tickMs: 30_000, reconcileEveryMs: 60_000, reconcileJobMinIntervalMs: 15_000, reconcileCallGraceMs: 180_000,
        engine: { collectionWindowMs: 30 * 60_000, negotiationWindowMs: 5 * 60_000, callCooldownMs: 2 * 60_000 },
      });
      expect(mockDemoConfig(env)).toEqual({});
    }
    // The existing knobs still apply as before.
    expect(liveTimings({ HAGGLE_CALL_DELAY_S: "60", HAGGLE_ESCALATE_EMAIL_TO_CALL_S: "300", HAGGLE_RECONCILE_EVERY_S: "90" })).toMatchObject({
      reconcileEveryMs: 90_000, engine: { callDelayMs: 60_000, escalateEmailToCallAfterMs: 300_000 },
    });
  });

  it("on: negotiation 60 s, call spacing 5 s, question batching 5 s, sweep 15 s, tick 5 s", () => {
    const t = liveTimings({ HAGGLE_DEMO_SPEED: "true" });
    expect(t).toEqual({
      demoSpeed: true, tickMs: 5_000, reconcileEveryMs: 15_000, reconcileJobMinIntervalMs: 5_000, reconcileCallGraceMs: 30_000,
      engine: {
        collectionWindowMs: 4 * 60_000, negotiationWindowMs: 60_000, callCooldownMs: 5_000, counterCallGapMs: 5_000, minCallGapMs: 5_000, callRetryMs: 10_000,
        questionBatchMs: 5_000, replyGraceMs: 60_000, questionHoldMs: 60_000, followUpHoldMs: 30_000,
      },
    });
    // HAGGLE_CALL_DELAY_S / HAGGLE_ESCALATE_EMAIL_TO_CALL_S / HAGGLE_RECONCILE_EVERY_S are capped, never lengthened.
    expect(liveTimings({ HAGGLE_DEMO_SPEED: "true", HAGGLE_CALL_DELAY_S: "60", HAGGLE_ESCALATE_EMAIL_TO_CALL_S: "300", HAGGLE_RECONCILE_EVERY_S: "60" })).toMatchObject({
      reconcileEveryMs: 15_000, engine: { callDelayMs: 5_000, escalateEmailToCallAfterMs: 30_000 },
    });
    expect(liveTimings({ HAGGLE_DEMO_SPEED: "true", HAGGLE_CALL_DELAY_S: "2" }).engine.callDelayMs).toBe(2_000);
  });

  it("mock: the same shorter windows, no call spacing (the simulated fleet has none)", () => {
    expect(mockDemoConfig({ HAGGLE_DEMO_SPEED: "true" })).toEqual({
      collectionWindowMs: 4 * 60_000, negotiationWindowMs: 60_000, questionBatchMs: 5_000, replyGraceMs: 60_000, questionHoldMs: 60_000, followUpHoldMs: 30_000,
    });
  });
});
