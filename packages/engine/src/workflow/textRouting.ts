// Workspace scoping for inbound texts (overnight sprint B). Haggle has one text line for every
// workspace, so a reply from a number is tied to a workspace only by durable records: the number is
// that workspace's approver, or a business Haggle contacted at it on one of its deals. When those
// records tie a number to more than one workspace, only an explicit identifier the sender typed
// decides (the deal code "HG-…", or an approval code exactly one of them has). Never the most recent
// text, never a guess: an ambiguous text is held and the human is asked to include the deal code.
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
  return { kind: "ambiguous", workspaces: [...owners.keys()].sort(), jobs: [...owners.values()].flat() };
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
