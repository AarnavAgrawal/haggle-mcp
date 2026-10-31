// GET /api/account/export: the signed-in user's data as a JSON download (lib/account/export.ts), generated
// on the server. 401 signed out; 5 exports per user per 10 minutes. Never a redirect.
import { buildExport } from "@/lib/account/export";
import { accountError, accountJson } from "@/lib/account/request";
import { exportDeps } from "@/lib/account/server";
import { limiters } from "@/lib/limiters";
import { membership, verifiedSessionUser } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  const user = await verifiedSessionUser().catch(() => null);
  if (!user) return accountError(401, "signed_out", "You're signed out.", "Sign in again.");
  if (!(await limiters.accountExport.take(user.id)).ok) return accountError(429, "rate_limited", "Too many exports in a short time.", "Wait a few minutes, then try again.");
  try {
    const data = await buildExport(exportDeps(user, await membership(user.id)));
    const day = new Date().toISOString().slice(0, 10);
    return accountJson(200, data, { "content-disposition": `attachment; filename="haggle-export-${day}.json"` });
  } catch {
    return accountError(500, "export_failed", "Your data couldn't be exported.", "Try again in a moment; if it keeps failing, contact support.");
  }
}
