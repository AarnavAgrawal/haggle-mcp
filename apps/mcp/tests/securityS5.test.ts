// Sprint 5 adversarial review (workstream D), MCP side. See docs/security-review-s5.md.
import type { Profile } from "@haggle/core";
import { describe, expect, it } from "vitest";
import { historyOnly } from "../src/brain.ts";

describe("S5-D F15: business_profile never shows what a shared profile learned from rows outside this workspace", () => {
  const row = (job_id: string, total: number) => ({ date: "2026-10-20", job_id, kind: "quote", channel: "email", total_usd: total, per_unit_usd: total / 40, quantity: 40, round: 1 });
  // Every remaining history row is this workspace's, but the brain keeps only the newest rows: the menu,
  // area and reply speed were accumulated from rows (another tenant's) that were already evicted.
  const p = {
    business_id: "biz_1", name: "Casa Lunch", category: "catering", area: "Alpha HQ, 1 Secret St", best_channel: "email", channels_seen: ["email", "phone"], price_model: "per_person",
    menu: ["secret menu from Alpha's reply"], flags_seen: ["alpha_flag"], minimum_order_usd: 999, deposit_pct: 0.5, median_reply_minutes: 7, asks_questions: true,
    history: [row("job_beta", 2000)], n_quotes: 1, confidence: 0.8, per_unit_usd: { low: 10, typical: 25, high: 80 }, updated_at: "2026-10-20T00:00:00Z",
  } as unknown as Profile;

  it("exact mode rebuilds from the kept rows even when nothing was filtered", () => {
    const beta = historyOnly(p, (j) => j === "job_beta", { exact: true })!;
    expect(beta.history.map((h) => h.job_id)).toEqual(["job_beta"]);
    expect(JSON.stringify(beta)).not.toMatch(/secret menu|alpha_flag|Secret St|999/);
    expect(beta.median_reply_minutes).toBeUndefined();
    expect(beta.per_unit_usd).toEqual({ low: 50, typical: 50, high: 50 });
    expect(beta.channels_seen).toEqual(["email"]);
  });
});
