import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobRequirements, QuotePart, parseProtocolPart, usdToCents } from "../src/index.ts";

// Guards the buyer fixtures themselves: if a fixture is internally inconsistent,
// tests built on it later would be asserting against a wrong oracle.
const FIXTURES = join(import.meta.dirname, "../../../fixtures/buyer");

interface Fixture {
  id: string;
  provider_message_id: string;
  attachments: { filename: string; inline?: string; path?: string }[];
  expect: Record<string, unknown>;
}

const fixtures: Fixture[] = readdirSync(join(FIXTURES, "emails"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, "emails", f), "utf8")));

const quoteJson = (f: Fixture) => f.attachments.find((a) => a.filename === "quote.json")?.inline;

describe("buyer fixtures", () => {
  it("covers the six benchmark traps plus edge cases", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
    const scenario = JSON.parse(readFileSync(join(FIXTURES, "scenarios/offsite-lunch.json"), "utf8"));
    for (const id of scenario.benchmark_fixtures) {
      expect(fixtures.map((f) => f.id)).toContain(id);
    }
    expect(() => JobRequirements.parse(scenario.deal.requirements)).not.toThrow();
  });

  it("has valid quote.json parts everywhere except the malformed fixture", () => {
    for (const f of fixtures) {
      const raw = quoteJson(f);
      if (!raw) continue;
      const r = parseProtocolPart(QuotePart, raw);
      expect(r.ok, `${f.id}: ${r.ok ? "" : r.error}`).toBe(f.id !== "07-malformed-json");
    }
  });

  it("keeps quote.json arithmetic consistent with the expected totals", () => {
    for (const f of fixtures) {
      const raw = quoteJson(f);
      if (!raw || f.id === "07-malformed-json") continue;
      const q = QuotePart.parse(JSON.parse(raw));
      expect(usdToCents(q.total_usd), f.id).toBe(f.expect.total_cents);
      const itemTotals = (q.items ?? []).map((i) => i.total_usd).filter((t): t is number => t !== undefined);
      if (q.subtotal_usd !== undefined && itemTotals.length === (q.items ?? []).length) {
        const sum = itemTotals.reduce((a, t) => a + usdToCents(t), 0);
        expect(sum, `${f.id} items vs subtotal`).toBe(usdToCents(q.subtotal_usd));
      }
    }
  });

  it("references attachment files that exist", () => {
    for (const f of fixtures) {
      for (const a of f.attachments) {
        if (a.path) expect(() => readFileSync(join(FIXTURES, a.path!))).not.toThrow();
      }
    }
  });

  it("uses one duplicate provider id on purpose and no accidental ones", () => {
    const ids = fixtures.map((f) => f.provider_message_id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual(["prov_01-clean-agent-quote"]);
  });

  it("puts the hidden deposit only on page 2 of the PDF", () => {
    const pdf = readFileSync(join(FIXTURES, "attachments/golden-gate-quote-hidden-deposit.pdf"), "latin1");
    const pages = pdf.split("/Type /Page ").slice(1);
    expect(pages).toHaveLength(2);
    // Content streams follow page order in this generator; the deposit text must not be on page 1.
    const streams = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]!);
    expect(streams[0]).not.toMatch(/deposit/i);
    expect(streams[1]).toMatch(/deposit of 30% of the total \\\(\$304\.80\\\)/);
  });
});
