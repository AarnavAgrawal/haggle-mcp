// Sprint 2026-10-22 (found by WS-D): a delivery requirement with a time ("Delivered by 11:30 AM") was
// marked met by the keyword rule whenever delivery was included or priced, even when Claude said the
// business never addressed the time. Offering delivery doesn't confirm a deadline: it's a follow-up.
import { describe, expect, it } from "vitest";
import { heuristicExtract } from "../src/parsing/heuristic.ts";
import { validateQuote } from "../src/parsing/validate.ts";
import { evaluateRequirements, meetsHardRequirements, type EngineRequirement } from "../src/parsing/requirements.ts";

const req = { what: "lunch", location: "SF", dietary: [], requirements: [] } as never;
const record = (body: string) => validateQuote(heuristicExtract({ request: req, bodyText: body }), 40);
const delivery = (text: string): EngineRequirement => ({ id: "r_del", kind: "delivery", text, hard: true });

describe("delivery deadlines are never assumed met", () => {
  it("delivery included doesn't confirm 'by 11:30 AM' (keyword path)", () => {
    const q = record("Total: $1,150, delivery included.");
    for (const t of ["Delivered by 11:30 AM", "Delivery before noon", "Must arrive no later than 9am", "Delivery at 11:30"]) {
      const [r] = evaluateRequirements(q, [delivery(t)], 40);
      expect(r, t).toMatchObject({ met: null, reason: "delivery time not confirmed" });
      expect(meetsHardRequirements([r!], [delivery(t)])).toBe(false);
    }
  });

  it("Claude finding the time unaddressed stays unknown even though delivery is included", () => {
    const q = { ...record("Total: $1,150, delivery included."), requirement_checks: { r_del: { met: null, note: "time not mentioned", evidence: null, carried: false } } } as never;
    expect(evaluateRequirements(q, [delivery("Delivered by 11:30 AM")], 40)[0]).toMatchObject({ met: null });
  });

  it("a plain delivery requirement is still met by included delivery; not offered is still a no", () => {
    expect(evaluateRequirements(record("Total: $1,150, delivery included."), [delivery("Must deliver")], 40)[0]!.met).toBe(true);
  });
});
