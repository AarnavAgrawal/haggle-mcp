// Shared plumbing for the web app's service-only HTTP routes (x-haggle-service-token). Kept free of the
// HTTP framework's types so each route file stays small and testable.
import { getRuntime, type Runtime } from "../runtime.ts";
import { SERVICE_TOKEN_HEADER, SERVICE_WORKSPACE_HEADER, serviceTokenValid } from "../workspace.ts";

/** The parts of the request context a service route uses. */
export interface ServiceContext {
  req: { header(name: string): string | undefined; json(): Promise<unknown>; param(name: string): string | undefined; query(name: string): string | undefined };
  json(body: unknown, status?: number): Response;
}
export type ServiceHandler = (c: ServiceContext) => Promise<Response> | Response;
export interface ServiceApp {
  get(path: string, h: ServiceHandler): unknown;
  post(path: string, h: ServiceHandler): unknown;
}

/** Header naming the signed-in web user a request acts for (recorded on approvals and consents). */
export const SERVICE_ACTOR_HEADER = "x-haggle-actor";

export const fail = (c: ServiceContext, status: number, code: string, message: string, fix: string) => c.json({ ok: false, error: { code, message, fix } }, status);

/**
 * The service guard every route runs first: off (404) without HAGGLE_SERVICE_TOKEN, 401 for a wrong
 * token, then the runtime (503 when unconfigured). `workspace: true` also requires an existing,
 * unrevoked workspace in x-haggle-workspace.
 */
export async function serviceGuard(c: ServiceContext, opts: { workspace?: boolean } = {}): Promise<{ rt: Runtime; workspaceId: string | null; actor: string | null } | Response> {
  if ((process.env.HAGGLE_SERVICE_TOKEN?.trim().length ?? 0) < 32) return fail(c, 404, "DISABLED", "Service access is off.", "Set HAGGLE_SERVICE_TOKEN (at least 32 chars) on the server and the web app.");
  if (!serviceTokenValid(c.req.header(SERVICE_TOKEN_HEADER))) return fail(c, 401, "UNAUTHORIZED", "Unknown service token.", "Send x-haggle-service-token: HAGGLE_SERVICE_TOKEN.");
  let rt: Runtime;
  try {
    rt = await getRuntime();
  } catch {
    return fail(c, 503, "CONFIG_MISSING", "This server isn't fully configured.", "The operator must set the missing environment variables (see /health).");
  }
  let workspaceId: string | null = null;
  if (opts.workspace) {
    workspaceId = c.req.header(SERVICE_WORKSPACE_HEADER)?.trim() || null;
    const ws = workspaceId ? await rt.engine.workspaceById(workspaceId) : null;
    if (!ws || ws.revoked_at) return fail(c, 401, "UNAUTHORIZED", "Unknown or revoked workspace.", "Send x-haggle-workspace with the signed-in user's workspace id.");
  }
  const actor = c.req.header(SERVICE_ACTOR_HEADER)?.trim().slice(0, 200) || null;
  return { rt, workspaceId, actor };
}

/** An engine error ({ code, message, fix }) as a 4xx JSON answer. */
export function engineError(c: ServiceContext, err: unknown, status = 400) {
  const e = err as { code?: string; message?: string; fix?: string };
  return fail(c, status, e.code ?? "INVALID_INPUT", e.message ?? "Request failed.", e.fix ?? "Fix the input and try again.");
}
