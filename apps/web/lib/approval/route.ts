// The approve / pay / callback route handlers' logic, with auth and the Haggle client injected so it
// is testable without Next or Supabase (lib/approval/deps.ts wires the real ones). JSON in and out;
// never a redirect: 401 signed out, 403 no workspace, 400 bad body, 429 too many clicks.
import { z } from "zod";
import { approveQuote, authorizeCallback, payQuote, type FlowError, type HostClient } from "./flow.ts";

export type Caller = { userId: string; workspaceId: string };
export interface RouteDeps {
  /** The signed-in user and their workspace, or why not. */
  auth(): Promise<Caller | { status: 401 | 403 }>;
  client(workspaceId: string): HostClient;
  limiter?: RateLimiter;
}

// ── rate limit: a fixed one-minute window per user, in memory (one server process) ──
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private readonly max = 30, private readonly windowMs = 60_000, private readonly now = () => Date.now()) {}
  /** True if this key may act now (and counts the hit). */
  take(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (t - v.start >= this.windowMs) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { start: t, n: 1 });
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
  }
}
const sharedLimiter = new RateLimiter();

// ── one action at a time per user + deal + target: a double click joins the first request ──
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
  approve: z.object({ quote_id: id, action: z.enum(["pay", "confirm"]).optional() }),
  pay: z.object({ quote_id: id }),
  callback: z.object({ business_id: id }),
} as const;
export type ActionKind = keyof typeof Bodies;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, code: string, message: string, fix: string) => json({ ok: false, error: { code, message, fix }, next: null } satisfies FlowError, status);

/** HTTP status for a flow error: transport refusals keep theirs (5xx as 502), tool refusals are 422. */
function statusOf(e: FlowError): number {
  if (!e.status) return 422;
  return e.status >= 500 ? 502 : e.status === 401 || e.status === 403 ? 502 : e.status;
}

export async function handleAction(kind: ActionKind, req: Request, jobIdParam: string, deps: RouteDeps): Promise<Response> {
  const who = await deps.auth();
  if ("status" in who) {
    return who.status === 401
      ? refuse(401, "signed_out", "You're signed out.", "Sign in again, then retry.")
      : refuse(403, "no_workspace", "Your account has no Haggle workspace yet.", "Finish onboarding, then retry.");
  }
  if (!(deps.limiter ?? sharedLimiter).take(who.userId)) return refuse(429, "rate_limited", "Too many actions in a minute.", "Wait a minute, then try again.");

  const jobId = id.safeParse(jobIdParam);
  if (!jobId.success) return refuse(400, "bad_job_id", "That deal id isn't valid.", "Open the deal from your deals list.");
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return refuse(400, "bad_body", "The request body isn't JSON.", "Send a JSON body.");
  }
  const parsed = Bodies[kind].safeParse(raw);
  if (!parsed.success) {
    const fields = kind === "callback" ? "business_id" : kind === "approve" ? "quote_id and optional action (pay or confirm)" : "quote_id";
    return refuse(400, "bad_body", "The request is missing or has invalid fields.", `Send ${fields}.`);
  }

  const haggle = deps.client(who.workspaceId);
  const job = jobId.data;
  const b = parsed.data as { quote_id?: string; business_id?: string; action?: "pay" | "confirm" };
  const target = b.quote_id ?? b.business_id ?? "";
  const r = await once(`${who.userId}\u0000${kind}\u0000${job}\u0000${target}`, async () => {
    const out = kind === "approve" ? await approveQuote(haggle, job, target, b.action)
      : kind === "pay" ? await payQuote(haggle, job, target)
      : await authorizeCallback(haggle, job, target);
    return out.ok ? { body: out, status: 200 } : { body: { ok: false, error: out.error, next: out.next }, status: statusOf(out) };
  });
  return json(r.body, r.status);
}
