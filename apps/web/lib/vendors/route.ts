// The /api/vendors route handlers' logic, with auth and the server calls injected so it is testable
// without Next or Supabase (lib/vendors/deps.ts wires the real ones). JSON in and out, never a
// redirect: 401 signed out, 403 no workspace (or a guest on a live site), 400 bad body, 429 too many,
// the MCP server's own 4xx (with its fix) passed through, 502 when the server can't be reached.
import { z } from "zod";
import { HaggleError } from "../haggle.ts";
import { memoryLimiter, type Limiter } from "../rateLimit.ts";
import { toDiscoverResult } from "./discover.ts";
import { validateVendorForm } from "./form.ts";
import type { VendorList } from "./types.ts";

export type VendorCaller = { userId: string; workspaceId: string; actor: string; guest: boolean };
export interface VendorDeps {
  auth(): Promise<VendorCaller | { status: 401 | 403 }>;
  /** callService against the MCP server as this workspace (and actor, for writes). */
  service<T>(path: string, opts: { workspaceId: string; actor?: string; body?: unknown }): Promise<T>;
  /** The MCP discover tool's structuredContent, as this workspace. */
  discover(workspaceId: string, args: { category: string; area?: string; count: number }): Promise<Record<string, unknown>>;
  /** A demo site (mock server): guests may add vendors there, since nothing real is contacted. */
  demo: boolean;
  /** Per user: 20 vendor changes and 10 searches a minute, shared by every instance in production (lib/limiters.ts). */
  writeLimiter?: Limiter;
  discoverLimiter?: Limiter;
}

// Without injected limiters (tests), a per-process count with the same sizes.
const fallbackWrites = memoryLimiter(20, 60_000);
const fallbackDiscover = memoryLimiter(10, 60_000);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, code: string, message: string, fix: string, extra: Record<string, unknown> = {}) => json({ ok: false, error: { code, message, fix }, ...extra }, status);

async function caller(deps: VendorDeps): Promise<VendorCaller | Response> {
  const who = await deps.auth();
  if ("status" in who) {
    return who.status === 401
      ? refuse(401, "signed_out", "You're signed out.", "Sign in again, then retry.")
      : refuse(403, "no_workspace", "Your account has no Haggle workspace yet.", "Finish onboarding, then retry.");
  }
  return who;
}

/** A server refusal keeps its status and fix; credentials or transport trouble is 502. */
function serverError(err: unknown): Response {
  if (err instanceof HaggleError) {
    const s = err.status;
    const status = s === undefined ? 422 : s >= 500 || s === 401 || s === 403 ? 502 : s;
    return refuse(status, err.code, err.message, err.fix || "Try again in a moment.");
  }
  return refuse(502, "unreachable", "The Haggle server couldn't be reached.", "Try again in a moment.");
}

async function body(req: Request): Promise<unknown | Response> {
  try {
    return await req.json();
  } catch {
    return refuse(400, "bad_body", "The request body isn't JSON.", "Send a JSON body.");
  }
}

/** GET /api/vendors */
export async function handleList(deps: VendorDeps): Promise<Response> {
  const who = await caller(deps);
  if (who instanceof Response) return who;
  try {
    return json(await deps.service<VendorList>("/internal/vendors", { workspaceId: who.workspaceId }));
  } catch (err) {
    return serverError(err);
  }
}

/** POST /api/vendors { name, contact, channel?, consent_basis, note?, attested: true } */
export async function handleAdd(req: Request, deps: VendorDeps): Promise<Response> {
  const who = await caller(deps);
  if (who instanceof Response) return who;
  if (who.guest && !deps.demo) return refuse(403, "guest_account", "Guest accounts can't add real businesses.", "Sign in with your email to add the businesses you work with.");
  if (!(await (deps.writeLimiter ?? fallbackWrites).take(who.userId)).ok) return refuse(429, "rate_limited", "Too many vendor changes in a minute.", "Wait a minute, then try again.");
  const raw = await body(req);
  if (raw instanceof Response) return raw;
  const form = validateVendorForm((raw ?? {}) as Record<string, unknown>);
  if (!form.ok) return refuse(400, "invalid_form", "Some fields need fixing.", "Correct the highlighted fields.", { fields: form.errors });
  try {
    return json(await deps.service("/internal/vendors", { workspaceId: who.workspaceId, actor: who.actor, body: form.value }), 201);
  } catch (err) {
    return serverError(err);
  }
}

const RemoveBody = z.object({ contact: z.string().trim().min(3).max(254) });

/** POST /api/vendors/remove { contact } */
export async function handleRemove(req: Request, deps: VendorDeps): Promise<Response> {
  const who = await caller(deps);
  if (who instanceof Response) return who;
  if (!(await (deps.writeLimiter ?? fallbackWrites).take(who.userId)).ok) return refuse(429, "rate_limited", "Too many vendor changes in a minute.", "Wait a minute, then try again.");
  const raw = await body(req);
  if (raw instanceof Response) return raw;
  const b = RemoveBody.safeParse(raw);
  if (!b.success) return refuse(400, "bad_body", "Say which vendor to remove.", "Send the vendor's contact.");
  try {
    return json(await deps.service("/internal/vendors/remove", { workspaceId: who.workspaceId, actor: who.actor, body: { contact: b.data.contact } }));
  } catch (err) {
    return serverError(err);
  }
}

const DiscoverBody = z.object({ category: z.string().trim().min(2).max(100), area: z.string().trim().min(2).max(200).optional().or(z.literal("").transform(() => undefined)) });

/** POST /api/vendors/discover { category, area? }: public listings only; contacts nobody. */
export async function handleDiscover(req: Request, deps: VendorDeps): Promise<Response> {
  const who = await caller(deps);
  if (who instanceof Response) return who;
  if (!(await (deps.discoverLimiter ?? fallbackDiscover).take(who.userId)).ok) return refuse(429, "rate_limited", "Too many searches in a minute.", "Wait a minute, then search again.");
  const raw = await body(req);
  if (raw instanceof Response) return raw;
  const b = DiscoverBody.safeParse(raw);
  if (!b.success) return refuse(400, "bad_body", "Say what kind of business to look for.", "Enter a kind of business (2 to 100 characters) and, optionally, an area.");
  try {
    const data = await deps.discover(who.workspaceId, { category: b.data.category, ...(b.data.area ? { area: b.data.area } : {}), count: 8 });
    return json(toDiscoverResult(data));
  } catch (err) {
    return serverError(err);
  }
}
