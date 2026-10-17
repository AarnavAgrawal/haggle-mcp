import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Approval, BusinessProfile, DealBoard, Estimates } from "@haggle/core";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./views/${name}.json`, import.meta.url), "utf8"));

describe("view fixtures match packages/core/views.ts", () => {
  it.each([
    ["deal-board", DealBoard],
    ["approval", Approval],
    ["estimates", Estimates],
    ["business-profile", BusinessProfile],
  ] as const)("%s", (name, schema) => {
    const parsed = schema.safeParse(load(name));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("deal board ranks compliant quotes first, cheapest first", () => {
    const board = DealBoard.parse(load("deal-board"));
    const compliant = board.quotes.filter((q) => q.meets_requirements);
    const firstNonCompliant = board.quotes.findIndex((q) => !q.meets_requirements);
    expect(firstNonCompliant).toBe(compliant.length);
    const totals = compliant.map((q) => q.total_usd);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    expect(board.recommended_quote_id).toBe(compliant[0]?.quote_id);
  });

  it("every quote belongs to a listed business", () => {
    const board = DealBoard.parse(load("deal-board"));
    const ids = new Set(board.businesses.map((b) => b.id));
    for (const q of board.quotes) expect(ids.has(q.business_id)).toBe(true);
  });
});
