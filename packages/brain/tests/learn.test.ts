import { describe, expect, it } from "vitest";
import type { ReplyMeta } from "@haggle/core";
import { applyReply } from "../index.ts";

const request = { what: "Lunch catering", quantity: 40, area: "SF", requirements: ["12 vegetarian"] };
const meta = (over: Partial<ReplyMeta> = {}): ReplyMeta => ({
  job_id: "job_1",
  business_name: "Harbor Table",
  channel: "email",
  contacted_at: "2026-10-17T13:00:00-07:00",
  received_at: "2026-10-17T13:25:00-07:00",
  round: 1,
  request,
  ...over,
});

describe("applyReply (business learning)", () => {
  it("builds a profile from a first email quote", () => {
    const p = applyReply(
      null,
      "biz_harbor_table",
      { kind: "quote", total_usd: 1150, deposit_usd: 345, items: ["Family-style lunch"], flags: ["hidden_deposit"] },
      meta(),
    );
    expect(p).toMatchObject({
      business_id: "biz_harbor_table",
      name: "Harbor Table",
      category: "catering",
      area: "san francisco",
      best_channel: "email",
      price_model: "per_unit",
      per_unit_usd: { low: 28.75, typical: 28.75, high: 28.75 },
      deposit_pct: 0.3,
      median_reply_minutes: 25,
      n_quotes: 1,
      flags_seen: ["hidden_deposit"],
      menu: ["Family-style lunch"],
    });
  });

  it("learns the negotiation discount and that it needed a competing quote", () => {
    let p = applyReply(null, "b", { kind: "quote", total_usd: 1150 }, meta());
    p = applyReply(
      p,
      "b",
      { kind: "quote", total_usd: 1035 },
      meta({ round: 2, negotiated_from: 1150, cited_competing_quote: true, received_at: "2026-10-17T13:41:00-07:00" }),
    );
    expect(p.discount_pct).toBe(0.1);
    expect(p.discount_needs_competing_quote).toBe(true);
    expect(p.n_quotes).toBe(2);
    expect(p.per_unit_usd).toEqual({ low: 25.88, typical: 27.32, high: 28.75 });
  });

  it("does not double count a repeated negotiation reply in the discount", () => {
    let p = applyReply(null, "b", { kind: "quote", total_usd: 1000 }, meta());
    p = applyReply(p, "b", { kind: "quote", total_usd: 900 }, meta({ job_id: "job_2", round: 2, negotiated_from: 1000 }));
    const counter = meta({ job_id: "job_3", round: 2, negotiated_from: 1000 });
    p = applyReply(p, "b", { kind: "quote", total_usd: 1000 }, counter);
    expect(p.discount_pct).toBe(0.05);
    p = applyReply(p, "b", { kind: "quote", total_usd: 1000 }, counter);
    expect(p.discount_pct).toBe(0.05);
  });

  it("treats a $0 total as unknown, not a price", () => {
    const p = applyReply(null, "b", { kind: "quote", total_usd: 0 }, meta({ channel: "phone" }));
    expect(p.per_unit_usd).toBeUndefined();
    expect(p.history[0]!.total_usd).toBeUndefined();
  });

  it("keeps learning when a deposit exceeds the total (a misread figure)", () => {
    const p = applyReply(null, "b", { kind: "quote", total_usd: 100, deposit_usd: 150 }, meta());
    expect(p.n_quotes).toBe(1);
    expect(p.deposit_pct).toBeUndefined();
  });

  it("does not double count a reply reported twice", () => {
    const parsed = { kind: "quote" as const, total_usd: 1150 };
    const once = applyReply(null, "b", parsed, meta());
    const twice = applyReply(once, "b", parsed, meta());
    expect(twice.history).toHaveLength(1);
    expect(twice.n_quotes).toBe(1);
  });

  it("learns from phone calls and questions, and picks the channel that quotes", () => {
    let p = applyReply(null, "m", { kind: "no_answer" }, meta({ business_name: "Mission Eats", channel: "email" }));
    p = applyReply(p, "m", { kind: "question", question: "Plates?" }, meta({ business_name: "Mission Eats", channel: "email", job_id: "j2" }));
    p = applyReply(p, "m", { kind: "quote", total_usd: 1080 }, meta({ business_name: "Mission Eats", channel: "phone", job_id: "j3" }));
    expect(p.best_channel).toBe("phone");
    expect(p.channels_seen).toEqual(["email", "phone"]);
    expect(p.asks_questions).toBe(true);
  });
});
