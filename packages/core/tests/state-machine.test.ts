import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  JobState,
  TERMINAL_JOB_STATES,
  allowedJobTransitions,
  assertJobTransition,
  assertSellerTransition,
  canTransitionJob,
} from "../src/index.ts";

describe("job state machine", () => {
  it("walks the full happy path", () => {
    const path = [
      "created",
      "dispatching",
      "collecting_quotes",
      "clarifying",
      "negotiating",
      "comparing",
      "awaiting_approval",
      "approved",
      "payment_pending",
      "settled",
    ] as const;
    for (let i = 1; i < path.length; i++) {
      expect(() => assertJobTransition(path[i - 1]!, path[i]!)).not.toThrow();
    }
  });

  it("never allows skipping approval on the way to payment", () => {
    for (const from of JobState.options) {
      if (from === "approved" || from === "payment_failed") continue;
      expect(canTransitionJob(from, "payment_pending"), `${from} -> payment_pending`).toBe(false);
    }
  });

  it("only reaches settled from payment_pending", () => {
    for (const from of JobState.options) {
      expect(canTransitionJob(from, "settled")).toBe(from === "payment_pending");
    }
  });

  it("cannot cancel an in-flight payment", () => {
    expect(() => assertJobTransition("payment_pending", "cancelled")).toThrow(InvalidTransitionError);
  });

  it("treats terminal states as terminal", () => {
    for (const s of TERMINAL_JOB_STATES) {
      expect(allowedJobTransitions(s)).toEqual([]);
    }
  });

  it("sends a revised quote awaiting approval back to comparing", () => {
    expect(canTransitionJob("awaiting_approval", "comparing")).toBe(true);
    expect(canTransitionJob("approved", "comparing")).toBe(true);
  });

  it("explains what is allowed when a transition is rejected", () => {
    try {
      assertJobTransition("created", "approved");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as Error).message).toContain("allowed from created: [dispatching, cancelled, failed]");
    }
  });
});

describe("seller conversation state machine", () => {
  it("allows a typical agent seller path", () => {
    expect(() => assertSellerTransition("pending", "contacted")).not.toThrow();
    expect(() => assertSellerTransition("contacted", "quoted")).not.toThrow();
    expect(() => assertSellerTransition("quoted", "negotiating")).not.toThrow();
    expect(() => assertSellerTransition("negotiating", "quoted")).not.toThrow();
    expect(() => assertSellerTransition("quoted", "won")).not.toThrow();
  });

  it("keeps blocked sellers blocked", () => {
    expect(() => assertSellerTransition("blocked", "quoted")).toThrow(InvalidTransitionError);
    expect(() => assertSellerTransition("blocked", "won")).toThrow(InvalidTransitionError);
  });

  it("cannot win without a quote", () => {
    expect(() => assertSellerTransition("contacted", "won")).toThrow(InvalidTransitionError);
    expect(() => assertSellerTransition("clarifying", "won")).toThrow(InvalidTransitionError);
  });
});
