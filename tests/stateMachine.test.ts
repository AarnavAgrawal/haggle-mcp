// One test per row of the transition table in DESIGN.md §7.2, plus guards.
import { describe, expect, it } from "vitest";
import { transition, type JobState, type TransitionContext } from "../src/jobs/stateMachine.js";

const NOW = new Date("2026-10-17T20:00:00Z");
const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  now: NOW,
  availableQuotes: 3,
  negotiationWindowSeconds: 45,
  ...over,
});
const job = (over: Partial<JobState> = {}): JobState => ({
  status: "collecting",
  round: 0,
  max_rounds: 1,
  collect_until: "2026-10-17T19:59:00Z",
  ...over,
});

describe("collecting", () => {
  it("quote_parsed keeps collecting (version bump only)", () => {
    const r = transition(job(), { type: "quote_parsed" }, ctx());
    expect(r).toEqual({ ok: true, next: job(), effects: [] });
  });

  for (const type of ["deadline_passed", "all_vendors_replied"] as const) {
    describe(type, () => {
      it("expires with zero available quotes", () => {
        const r = transition(job(), { type }, ctx({ availableQuotes: 0 }));
        expect(r.ok && r.next.status).toBe("expired");
      });

      it("starts a negotiation round with >= 2 quotes and rounds left", () => {
        const r = transition(job(), { type }, ctx({ availableQuotes: 2 }));
        expect(r).toEqual({
          ok: true,
          next: { status: "negotiating", round: 1, max_rounds: 1, collect_until: "2026-10-17T20:00:45.000Z" },
          effects: [{ type: "send_counteroffers", round: 1 }],
        });
      });

      it("goes to ready with only 1 quote", () => {
        const r = transition(job(), { type }, ctx({ availableQuotes: 1 }));
        expect(r).toEqual({ ok: true, next: job({ status: "ready" }), effects: [] });
      });

      it("goes to ready when max_rounds is 0", () => {
        const r = transition(job({ max_rounds: 0 }), { type }, ctx());
        expect(r.ok && r.next.status).toBe("ready");
      });
    });
  }
});

describe("negotiating", () => {
  const neg = (over: Partial<JobState> = {}) => job({ status: "negotiating", round: 1, max_rounds: 2, ...over });

  it("quote_parsed stays negotiating", () => {
    const r = transition(neg(), { type: "quote_parsed" }, ctx());
    expect(r.ok && r.next.status).toBe("negotiating");
  });

  it("deadline with rounds left runs another round", () => {
    const r = transition(neg(), { type: "deadline_passed" }, ctx());
    expect(r.ok && r.next).toMatchObject({ status: "negotiating", round: 2 });
    expect(r.ok && r.effects).toEqual([{ type: "send_counteroffers", round: 2 }]);
  });

  it("deadline at max_rounds goes to ready", () => {
    const r = transition(neg({ round: 2 }), { type: "deadline_passed" }, ctx());
    expect(r).toEqual({ ok: true, next: neg({ round: 2, status: "ready" }), effects: [] });
  });

  it("all countered vendors replied at max_rounds goes to ready", () => {
    const r = transition(neg({ round: 2 }), { type: "all_vendors_replied" }, ctx());
    expect(r.ok && r.next.status).toBe("ready");
  });
});

describe("approval", () => {
  it("ready -> awaiting_approval on approval_requested", () => {
    const r = transition(job({ status: "ready" }), { type: "approval_requested" }, ctx());
    expect(r.ok && r.next.status).toBe("awaiting_approval");
  });

  it("approval_requested is rejected outside ready", () => {
    expect(transition(job(), { type: "approval_requested" }, ctx()).ok).toBe(false);
    expect(transition(job({ status: "awaiting_approval" }), { type: "approval_requested" }, ctx()).ok).toBe(false);
  });

  it("awaiting_approval -> approved on approval_verified", () => {
    const r = transition(job({ status: "awaiting_approval" }), { type: "approval_verified" }, ctx());
    expect(r.ok && r.next.status).toBe("approved");
  });

  it("declined and expired both return to ready", () => {
    for (const type of ["approval_declined", "approval_expired"] as const) {
      const r = transition(job({ status: "awaiting_approval" }), { type }, ctx());
      expect(r.ok && r.next.status).toBe("ready");
    }
  });

  it("approval_verified is rejected unless awaiting_approval", () => {
    expect(transition(job({ status: "ready" }), { type: "approval_verified" }, ctx()).ok).toBe(false);
  });
});

describe("payment", () => {
  it("approved -> paid on payment_succeeded", () => {
    const r = transition(job({ status: "approved" }), { type: "payment_succeeded" }, ctx());
    expect(r.ok && r.next.status).toBe("paid");
  });

  it("approved -> payment_failed on payment_failed", () => {
    const r = transition(job({ status: "approved" }), { type: "payment_failed" }, ctx());
    expect(r.ok && r.next.status).toBe("payment_failed");
  });

  it("payment_failed -> paid on a successful retry", () => {
    const r = transition(job({ status: "payment_failed" }), { type: "payment_succeeded" }, ctx());
    expect(r.ok && r.next.status).toBe("paid");
  });

  it("payment events are rejected before approval", () => {
    for (const status of ["collecting", "ready", "awaiting_approval"] as const) {
      expect(transition(job({ status }), { type: "payment_succeeded" }, ctx()).ok).toBe(false);
    }
  });
});

describe("cancel and terminal states", () => {
  it("any non-terminal state can be cancelled", () => {
    for (const status of ["collecting", "negotiating", "ready", "awaiting_approval", "approved", "payment_failed"] as const) {
      const r = transition(job({ status }), { type: "cancelled" }, ctx());
      expect(r).toEqual({ ok: true, next: job({ status: "cancelled" }), effects: [{ type: "notify_cancelled" }] });
    }
  });

  it("terminal states accept no events", () => {
    for (const status of ["paid", "expired", "cancelled"] as const) {
      for (const type of ["cancelled", "deadline_passed", "payment_succeeded", "quote_parsed"] as const) {
        expect(transition(job({ status }), { type }, ctx()).ok).toBe(false);
      }
    }
  });

  it("deadline events are ignored outside the collection phases", () => {
    expect(transition(job({ status: "ready" }), { type: "deadline_passed" }, ctx()).ok).toBe(false);
  });

  it("never mutates its input", () => {
    const j = job();
    transition(j, { type: "deadline_passed" }, ctx({ availableQuotes: 2 }));
    expect(j).toEqual(job());
  });
});
