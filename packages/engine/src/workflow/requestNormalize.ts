// PURE: normalize what an agent wrote into requirements the engine can check. An agent request in
// plain words ("at least 12 vegetarian meals", "must deliver to the venue by 11:30", "nut-free") is
// accepted as a string or with a coarse kind; this infers the kind, the dietary need and a minimum
// count from the text, so quantity checks are arithmetic instead of guesses. It never invents a
// requirement the agent didn't state, and an explicit kind/min_count from the agent always wins.
import type { Requirement } from "../contract.ts";

const DIETS = ["vegetarian", "vegan", "gluten-free", "gluten free", "halal", "kosher", "nut-free", "nut free", "dairy-free", "dairy free", "pescatarian"];

type Kind = Requirement["kind"];

function inferKind(t: string): Kind {
  const s = t.toLowerCase();
  if (DIETS.some((d) => s.includes(d)) || /\b(allerg\w*|dietary)\b/.test(s)) return "dietary";
  if (/\b(deliver\w*|drop[- ]?off|set[- ]?up at|on[- ]?site)\b/.test(s)) return "delivery";
  if (/\b(by|before|no later than|on)\s+(\d{1,2}(:\d{2})?\s*(am|pm)?|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b(date|deadline|time)\b/.test(s)) return "date";
  if (/\b(at|to)\s+(the\s+)?(venue|office|address|location)\b|\b(location|address|venue)\b/.test(s)) return "location";
  if (/\b(\d+)\s*(people|guests|servings|meals|heads|attendees)\b|\bheadcount\b/.test(s)) return "quantity";
  if (/\b(licen[cs]ed|insured|insurance|certified|permit|staff|server|warranty)\b/.test(s)) return "service";
  return "other";
}

/** "at least 12 vegetarian", "12+ vegan meals", "minimum of 20": the stated minimum count. */
export function minCountFromText(t: string): number | undefined {
  const m = /\b(?:at least|min(?:imum)?(?: of)?|no fewer than)\s+(\d{1,5})\b/i.exec(t) ?? /\b(\d{1,5})\s*\+?\s*(?:or more\s+)?(?:vegetarian|vegan|gluten[- ]free|halal|kosher|nut[- ]free|dairy[- ]free|pescatarian|people|guests|servings|meals|portions|plates)\b/i.exec(t);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export type RequirementInput = string | (Partial<Requirement> & { text: string });

/** One requirement: kind inferred when absent (an explicit kind always stands), min_count from the text when absent. */
export function normalizeRequirement(r: RequirementInput, index: number): Requirement {
  const o = typeof r === "string" ? { text: r } : r;
  const text = o.text.trim().replace(/\s+/g, " ").slice(0, 200);
  const kind: Kind = o.kind ?? inferKind(text);
  const min = o.min_count ?? ((kind === "dietary" || kind === "quantity") ? minCountFromText(text) : undefined);
  return { id: o.id ?? `r${index + 1}`, kind, text, hard: o.hard ?? true, ...(min !== undefined ? { min_count: min } : {}) };
}

/** Every requirement normalized; exact duplicates (same kind and text) collapse to one; ids stay unique. */
export function normalizeRequirements(rs: readonly RequirementInput[]): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const [i, r] of rs.entries()) {
    const n = normalizeRequirement(r, i);
    const key = `${n.kind}:${n.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let id = n.id;
    for (let k = 2; ids.has(id); k++) id = `${n.id}_${k}`;
    ids.add(id);
    out.push({ ...n, id });
  }
  return out;
}
