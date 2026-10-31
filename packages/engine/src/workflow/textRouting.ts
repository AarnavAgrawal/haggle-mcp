// Workspace scoping for inbound texts (overnight sprint B). Haggle has one text line for every
// workspace, so a reply from a number is tied to a workspace only by durable records: the number is
// that workspace's approver, or a business Haggle contacted at it on one of its deals. When those
// records tie a number to more than one workspace, only an explicit identifier the sender typed
// decides (the deal code "HG-…" the human was given, an approval code exactly one of them has, or a
// description of exactly one of the requests). Never the most recent text, never a guess: an ambiguous
// text is held; the human is asked to include the deal code, a business which request (in words).
import type { JobRow, TextRouteRow } from "../store/types.ts";

const CODE = /\bHG-([A-Z0-9]{4,8})\b/i;

/** The deal code a text names ("HG-AB12" / "hg-ab12"), uppercased, or null. */
export function jobCodeIn(text: string): string | null {
  return CODE.exec(text)?.[1]?.toUpperCase() ?? null;
}

/**
 * The text without a deal code the sender put first or last to say which deal it's for:
 * "HG-AB12: drop-off is fine" -> "drop-off is fine"; "YES 4821 (HG-AB12)" -> "YES 4821".
 * A code in the middle of a sentence is part of what they said and stays.
 */
export function withoutJobCode(text: string): string {
  const out = text.replace(/^\s*\(?\bHG-[A-Z0-9]{4,8}\b\)?\s*[:,\-–]?\s*/i, "").replace(/[\s,]*\(?\bHG-[A-Z0-9]{4,8}\b\)?[\s.!]*$/i, "").trim();
  return out || text.trim();
}

export type TextScope =
  /** Nothing ties the number to a workspace's deal: there is nothing to scope (it is ignored later). */
  | { kind: "none" }
  /** Exactly one workspace (and, when the sender named one, one of its deals). */
  | { kind: "workspace"; workspaceId: string; jobId: string | null; text: string }
  /** Several workspaces and nothing the sender typed tells them apart. */
  | { kind: "ambiguous"; workspaces: string[]; jobs: JobRow[] };

/**
 * Which workspace a text from a number belongs to. `owners`: the deals tied to the number, by
 * workspace. `codeWorkspaces`: the workspaces with an approval for this number under the approval
 * code the text quotes (empty when it quotes none).
 */
export function decideTextScope(owners: Map<string, JobRow[]>, text: string, codeWorkspaces: string[] = []): TextScope {
  if (owners.size === 0) return { kind: "none" };
  const code = jobCodeIn(text);
  const named = code ? [...owners.values()].flat().find((j) => j.short_code.toUpperCase() === code) : undefined;
  if (named) return { kind: "workspace", workspaceId: named.workspace_id, jobId: named.id, text: withoutJobCode(text) };
  if (owners.size === 1) return { kind: "workspace", workspaceId: [...owners.keys()][0]!, jobId: null, text };
  const coded = [...new Set(codeWorkspaces)].filter((w) => owners.has(w));
  if (coded.length === 1) return { kind: "workspace", workspaceId: coded[0]!, jobId: null, text };
  // Businesses aren't sent codes any more: a text that describes exactly one of the requests ("the
  // lunch for 40 on Nov 3") names it, after Haggle asked which one it was about.
  const described = jobByDescription(text, [...owners.values()].flat());
  if (described) return { kind: "workspace", workspaceId: described.workspace_id, jobId: described.id, text };
  return { kind: "ambiguous", workspaces: [...owners.keys()].sort(), jobs: [...owners.values()].flat() };
}

type Described = Pick<JobRow, "id" | "workspace_id" | "request">;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const STOP = new Set(["the", "and", "for", "with", "our", "your", "food", "order", "request", "quote", "people", "about", "from", "this", "that", "event", "service", "services"]);

/** "lunch for 40 on Nov 3": how a request is named to a business in place of a code. */
export function requestLabel(r: JobRow["request"]): string {
  const qty = r.quantity === undefined ? "" : ` for ${r.quantity}${r.unit && r.unit !== "people" ? ` ${r.unit}` : ""}`;
  const d = r.date ? /^\d{4}-(\d{2})-(\d{2})$/.exec(r.date) : null;
  const when = d ? ` on ${MONTHS[Number(d[1]) - 1]![0]!.toUpperCase()}${MONTHS[Number(d[1]) - 1]!.slice(1)} ${Number(d[2])}` : "";
  return `${r.what.trim().replace(/\s+/g, " ").slice(0, 40)}${qty}${when}`;
}

/** The words, number and date a text would use to name this request. */
function descriptionMarks(r: JobRow["request"]): { words: string[]; qty: string | null; day: { m: number; d: number } | null } {
  const words = [...new Set(r.what.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
  const d = r.date ? /^\d{4}-(\d{2})-(\d{2})$/.exec(r.date) : null;
  return { words, qty: r.quantity === undefined ? null : String(r.quantity), day: d ? { m: Number(d[1]), d: Number(d[2]) } : null };
}

/**
 * The one request among `jobs` a text describes (by what, how many and when), or null when it
 * describes none or several equally. Deterministic and conservative: a word of what was asked for,
 * the count, or the date ("Nov 3", "11/3", "3rd"), and strictly more than any other request.
 */
export function jobByDescription<T extends Described>(text: string, jobs: T[]): T | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ")} `;
  const unique = [...new Map(jobs.filter((j) => j.request?.what).map((j) => [j.id, j])).values()];
  if (unique.length < 2) return null;
  const score = (j: T) => {
    const m = descriptionMarks(j.request);
    let s = m.words.filter((w) => t.includes(` ${w} `) || t.includes(` ${w}s `)).length;
    if (m.qty && t.includes(` ${m.qty} `)) s += 1;
    if (m.day) {
      const mon = MONTHS[m.day.m - 1]!;
      if (new RegExp(` ${mon}[a-z]* ${m.day.d}(st|nd|rd|th)? `).test(t) || t.includes(` ${m.day.m}/${m.day.d} `)) s += 1;
    }
    return s;
  };
  const ranked = unique.map((j) => ({ j, s: score(j) })).sort((a, b) => b.s - a.s);
  return ranked[0]!.s > 0 && ranked[0]!.s > ranked[1]!.s ? ranked[0]!.j : null;
}

/** Is this job inside the scope (everything is, when there is none)? */
export function inTextScope(scope: TextScope, job: Pick<JobRow, "id" | "workspace_id">): boolean {
  if (scope.kind !== "workspace") return true;
  return job.workspace_id === scope.workspaceId && (scope.jobId === null || job.id === scope.jobId);
}

/** What Haggle last texted the number within the scope (newest route first), in the shape routing reads. */
export function lastRoute(routes: TextRouteRow[], scope: TextScope): { kind: "human" | "business"; jobId: string; workspaceId: string; questionId?: string; approvalId?: string } | undefined {
  const r = routes.find((x) => inTextScope(scope, { id: x.job_id, workspace_id: x.workspace_id }));
  if (!r) return undefined;
  return { kind: r.purpose, jobId: r.job_id, workspaceId: r.workspace_id, ...(r.question_id ? { questionId: r.question_id } : {}), ...(r.approval_id ? { approvalId: r.approval_id } : {}) };
}
