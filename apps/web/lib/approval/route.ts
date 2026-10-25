// The approve / pay / callback / purchase route handlers' logic, with auth and the Haggle client
// injected so it is testable without Next or Supabase (lib/approval/deps.ts wires the real ones). JSON
// in and out; never a redirect: 401 signed out, 403 no workspace, 400 bad body, 429 too many clicks,
// 404 / 409 / 422 the server's refusal (with its fix), 502 server unreachable.
//
//   POST approve  { quote_id, action? }                          → preview: what the human is confirming
//   POST approve  { quote_id, approval_id, decision }            → the human's confirm (or decline)
//   POST pay      { quote_id }                                   → charge rail: pay the approved amount
//   POST callback { business_id }                                → one callback, authorized
//   POST purchase { action: "paid" | "booked" | "cancel" }       → manual rail steps
//   GET  purchase                                                → where the purchase stands
import { z } from "zod";
import {
  authorizeCallback, decideApproval, payQuote, previewApproval, purchaseAction, purchaseStatus,
  type ApprovalClient, type FlowError,
} from "./flow.ts";
import { memoryLimiter, type Limiter } from "../rateLimit.ts";

/** The signed-in user, their workspace, and who decisions are recorded as (their email, else their id). */
export type Caller = { userId: string; workspaceId: string; actor: string };
export interface RouteDeps {
  /** The signed-in user and their workspace, or why not. */
  auth(): Promise<Caller | { status: 401 | 403 }>;
  client(workspaceId: string, actor: string): ApprovalClient;
  /** 30 clicks per user per minute: shared by every instance in production (lib/limiters.ts). */
  limiter?: Limiter;
}

// Without an injected limiter (tests), a per-process count with the same size.
const fallbackLimiter = memoryLimiter(30, 60_000);

// ── one action at a time per user + deal + target: a double click joins the first request ──
// In memory on purpose: a repeat that reaches another instance is still safe, because the server's
// approval transitions are compare-and-set and its sends and charges are idempotent by key.
const inFlight = new Map<string, Promise<{ body: unknown; status: number }>>();
async function once(key: string, run: () => Promise<{ body: unknown; status: number }>) {
  const running = inFlight.get(key);
  if (running) return running;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const id = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.:-]+$/, "unexpected characters");
const Bodies = {
  approve: z.union([
    z.object({ quote_id: id, approval_id: id, decision: z.enum(["approve", "decline"]) }).strict(),
    z.object({ quote_id: id, action: z.enum(["pay", "confirm"]).optional() }).strict(),
  ]),
  pay: z.object({ quote_id: id }),
  callback: z.object({ business_id: id }),
  purchase: z.object({ action: z.enum(["paid", "booked", "cancel"]) }),
} as const;
export type ActionKind = keyof typeof Bodies;
const FIELDS: Record<ActionKind, string> = {
  approve: "quote_id and optional action (pay or confirm); or quote_id, approval_id and decision (approve or decline)",
  pay: "quote_id",
  callback: "business_id",
  purchase: "action (paid, booked or cancel)",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, code: string, message: string, fix: string) => json({ ok: false, error: { code, message, fix }, next: null } satisfies FlowError, status);

/**
 * HTTP status for a flow error: a tool's own refusal is 422; the server's not-found (404) and wrong-stage
 * (409) refusals keep theirs; its other refusals (400, approvals switched off) are 422 with the fix; a
 * refused service credential (401) or an unreachable server is 502.
 */
export function statusOf(e: FlowError): number {
  if (!e.status) return 422;
  if (e.status >= 500 || e.status === 401) return 502;
  if (e.status === 404 || e.status === 409 || e.status === 429) return e.status;
  if (e.status === 403 && e.error.code !== "WEB_APPROVALS_OFF") return 502;
  return 422;
}

async function authorize(deps: RouteDeps): Promise<Caller | Response> {
  const who = await deps.auth();
  if ("status" in who) {
    return who.status === 401
      ? refuse(401, "signed_out", "You're signed out.", "Sign in again, then retry.")
      : refuse(403, "no_workspace", "Your account has no Haggle workspace yet.", "Finish onboarding, then retry.");
  }
  return who;
}
const out = (r: { ok: true } | FlowError) => (r.ok ? { body: r, status: 200 } : { body: { ok: false, error: r.error, next: r.next }, status: statusOf(r) });

export async function handleAction(kind: ActionKind, req: Request, jobIdParam: string, deps: RouteDeps): Promise<Response> {
  const who = await authorize(deps);
  if (who instanceof Response) return who;
  const jobId = id.safeParse(jobIdParam);
  if (!jobId.success) return refuse(400, "bad_job_id", "That deal id isn't valid.", "Open the deal from your deals list.");
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return refuse(400, "bad_body", "The request body isn't JSON.", "Send a JSON body.");
  }
  const parsed = Bodies[kind].safeParse(raw);
  if (!parsed.success) return refuse(400, "bad_body", "The request is missing or has invalid fields.", `Send ${FIELDS[kind]}.`);
  // Counted only once the request is well formed: a malformed one never uses up the user's clicks.
  if (!(await (deps.limiter ?? fallbackLimiter).take(who.userId)).ok) return refuse(429, "rate_limited", "Too many actions in a minute.", "Wait a minute, then try again.");

  const haggle = deps.client(who.workspaceId, who.actor);
  const job = jobId.data;
  const b = parsed.data as { quote_id?: string; business_id?: string; approval_id?: string; decision?: "approve" | "decline"; action?: string };
  const target = b.approval_id ?? b.quote_id ?? b.business_id ?? b.action ?? "";
  const r = await once(`${who.userId}\u0000${kind}\u0000${job}\u0000${target}\u0000${b.decision ?? ""}`, async () => {
    if (kind === "approve") return out(b.approval_id && b.decision ? await decideApproval(haggle, b.approval_id, b.decision) : await previewApproval(haggle, job, b.quote_id!, b.action as "pay" | "confirm" | undefined));
    if (kind === "pay") return out(await payQuote(haggle, job, b.quote_id!));
    if (kind === "callback") return out(await authorizeCallback(haggle, job, b.business_id!));
    return out(await purchaseAction(haggle, job, b.action as "paid" | "booked" | "cancel"));
  });
  return json(r.body, r.status);
}

/** GET purchase: where the purchase stands after approval (a read; not rate limited like a click). */
export async function handlePurchaseStatus(jobIdParam: string, deps: RouteDeps): Promise<Response> {
  const who = await authorize(deps);
  if (who instanceof Response) return who;
  const jobId = id.safeParse(jobIdParam);
  if (!jobId.success) return refuse(400, "bad_job_id", "That deal id isn't valid.", "Open the deal from your deals list.");
  const r = out(await purchaseStatus(deps.client(who.workspaceId, who.actor), jobId.data));
  return json(r.body, r.status);
}
