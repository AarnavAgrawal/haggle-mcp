// The /api/settings route handlers' logic, with auth and the server calls injected so it is testable
// without Next or Supabase (lib/settings/deps.ts wires the real ones). JSON in and out, never a redirect.
// Only the workspace's owner, signed in with an email (never a guest), may change settings; the session
// is confirmed by the Auth server (verifiedSessionUser), not the cached claims. Writes must come from
// this site's own page (same origin). 401 signed out, 403 not allowed, 400 bad body, 429 too many, the
// MCP server's own 4xx (with its fix) passed through, 502 when the server can't be reached.
import { z } from "zod";
import { sameOrigin } from "../account/request.ts";
import { HaggleError } from "../haggle.ts";
import { memoryLimiter, type Limiter } from "../rateLimit.ts";
import { validateSettingsForm } from "./form.ts";
import type { SettingsSaved, WorkspaceSettings } from "./types.ts";

export type SettingsCaller = { userId: string; workspaceId: string; actor: string; guest: boolean; owner: boolean };
export interface SettingsDeps {
  auth(): Promise<SettingsCaller | { status: 401 | 403 }>;
  /** callService against the MCP server as this workspace (and actor, for writes). */
  service<T>(path: string, opts: { workspaceId: string; actor?: string; body?: unknown }): Promise<T>;
  /** Per user: 10 settings changes or code attempts a minute (lib/limiters.ts in production). */
  limiter?: Limiter;
}

const fallback = memoryLimiter(10, 60_000);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, code: string, message: string, fix: string, extra: Record<string, unknown> = {}) => json({ ok: false, error: { code, message, fix }, ...extra }, status);

async function caller(deps: SettingsDeps, write: boolean): Promise<SettingsCaller | Response> {
  const who = await deps.auth().catch(() => ({ status: 401 as const }));
  if ("status" in who) {
    return who.status === 401
      ? refuse(401, "signed_out", "You're signed out.", "Sign in again, then retry.")
      : refuse(403, "no_workspace", "Your account has no Haggle workspace yet.", "Finish onboarding, then retry.");
  }
  if (write && who.guest) return refuse(403, "guest_account", "Guest accounts can't change settings.", "Sign in with your email to change your settings.");
  if (write && !who.owner) return refuse(403, "not_owner", "Only the workspace's owner can change its settings.", "Ask the owner to make this change.");
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

async function writeGate(req: Request, deps: SettingsDeps): Promise<SettingsCaller | Response> {
  if (!sameOrigin(req)) return refuse(403, "cross_site", "This request must come from Haggle's own settings page.", "Use the Settings page.");
  const who = await caller(deps, true);
  if (who instanceof Response) return who;
  if (!(await (deps.limiter ?? fallback).take(who.userId)).ok) return refuse(429, "rate_limited", "Too many settings changes in a minute.", "Wait a minute, then try again.");
  return who;
}

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : refuse(400, "bad_body", "The request body must be a JSON object.", "Send a JSON object.");
  } catch {
    return refuse(400, "bad_body", "The request body isn't JSON.", "Send a JSON body.");
  }
}

/** The settings page this request came from; the confirm email links back to it. */
function confirmUrl(req: Request): string {
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  return `${origin.replace(/\/+$/, "")}/settings`;
}

/** GET /api/settings: any member may read (approver contacts are masked by the server). */
export async function handleGet(deps: SettingsDeps): Promise<Response> {
  const who = await caller(deps, false);
  if (who instanceof Response) return who;
  try {
    const r = await deps.service<{ settings: WorkspaceSettings; mode: string }>("/internal/workspaces/settings", { workspaceId: who.workspaceId });
    return json({ ok: true, mode: r.mode, settings: r.settings, can_edit: who.owner && !who.guest });
  } catch (err) {
    return serverError(err);
  }
}

/** POST /api/settings { name?, timezone?, sender_name?, default_area?, approver_email?, approver_phone?, default_deal_limit_usd? } */
export async function handleSave(req: Request, deps: SettingsDeps): Promise<Response> {
  const who = await writeGate(req, deps);
  if (who instanceof Response) return who;
  const raw = await body(req);
  if (raw instanceof Response) return raw;
  const form = validateSettingsForm(raw);
  if (!form.ok) return refuse(400, "invalid_form", "Some fields need fixing.", "Correct the highlighted fields.", { fields: form.errors });
  if (!Object.keys(form.value).length) return refuse(400, "nothing_to_change", "Nothing to change.", "Edit a field, then save.");
  const changesApprover = form.value.approver_email || form.value.approver_phone;
  try {
    const r = await deps.service<SettingsSaved>("/internal/workspaces/settings", {
      workspaceId: who.workspaceId, actor: who.actor,
      body: { ...form.value, ...(changesApprover ? { confirm_url: confirmUrl(req) } : {}) },
    });
    return json(r);
  } catch (err) {
    return serverError(err);
  }
}

const ConfirmBody = z.union([
  z.object({ kind: z.enum(["phone", "email"]), code: z.string().trim().regex(/^\d{3}[\s-]?\d{3}$/) }).strict(),
  z.object({ token: z.string().trim().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
]);

/** POST /api/settings/confirm { kind, code } | { token }: confirm a new approver. */
export async function handleConfirm(req: Request, deps: SettingsDeps): Promise<Response> {
  const who = await writeGate(req, deps);
  if (who instanceof Response) return who;
  const raw = await body(req);
  if (raw instanceof Response) return raw;
  const b = ConfirmBody.safeParse(raw);
  if (!b.success) return refuse(400, "bad_code", "Enter the 6-digit code.", "Type the code Haggle sent to the new contact.");
  try {
    return json(await deps.service("/internal/workspaces/settings/confirm", { workspaceId: who.workspaceId, actor: who.actor, body: b.data }));
  } catch (err) {
    return serverError(err);
  }
}

const CancelBody = z.object({ kind: z.enum(["phone", "email"]) }).strict();

/** POST /api/settings/cancel { kind }: withdraw a pending approver change. */
export async function handleCancel(req: Request, deps: SettingsDeps): Promise<Response> {
  const who = await writeGate(req, deps);
  if (who instanceof Response) return who;
  const raw = await body(req);
  if (raw instanceof Response) return raw;
  const b = CancelBody.safeParse(raw);
  if (!b.success) return refuse(400, "bad_body", "Say which change to cancel.", "Send { kind: \"phone\" } or { kind: \"email\" }.");
  try {
    return json(await deps.service("/internal/workspaces/settings/cancel", { workspaceId: who.workspaceId, actor: who.actor, body: b.data }));
  } catch (err) {
    return serverError(err);
  }
}
