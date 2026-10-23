// POST /api/account/delete { confirm: "DELETE" }: deletes the signed-in user's account (lib/account/delete.ts
// has the order: revoke the workspace on the MCP server, then chats, membership, profile, sign-in, session).
// Same-origin JSON only; 401 signed out; 3 attempts per user per 10 minutes. Never a redirect.
import { z } from "zod";
import { DELETE_CONFIRMATION, deleteAccount } from "@/lib/account/delete";
import { accountError, accountJson, Limiter, sameOrigin } from "@/lib/account/request";
import { deleteDeps } from "@/lib/account/server";
import { membership, sessionUser } from "@/lib/workspace";

export const runtime = "nodejs";

const Body = z.object({ confirm: z.literal(DELETE_CONFIRMATION) });
const limiter = new Limiter(3, 10 * 60_000);

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request) || !request.headers.get("content-type")?.includes("application/json")) {
    return accountError(403, "cross_site", "This request must come from Haggle's own account page.", "Use the Delete button on /account.");
  }
  const user = await sessionUser().catch(() => null);
  if (!user) return accountError(401, "signed_out", "You're signed out.", "Sign in again.");
  if (!Body.safeParse(await request.json().catch(() => null)).success) return accountError(400, "not_confirmed", `Type ${DELETE_CONFIRMATION} to confirm.`, `Send { "confirm": "${DELETE_CONFIRMATION}" }.`);
  if (!limiter.take(user.id)) return accountError(429, "rate_limited", "Too many attempts.", "Wait a few minutes, then try again.");

  let m: Awaited<ReturnType<typeof membership>>;
  let deps: ReturnType<typeof deleteDeps>;
  try {
    m = await membership(user.id);
    deps = deleteDeps(user, m);
  } catch {
    return accountError(500, "server_config", "The web app couldn't look up your account.", "Try again; if it keeps failing, contact support.");
  }
  const r = await deleteAccount(deps);
  if (!r.ok) {
    const fix = r.failed_at === "revoke" ? "Nothing was deleted. Try again in a moment; if it keeps failing, contact support." : "Your workspace is already revoked. Try again to finish deleting the rest; if it keeps failing, contact support.";
    return accountError(r.failed_at === "revoke" ? 502 : 500, `delete_failed_at_${r.failed_at}`, "Your account couldn't be fully deleted.", fix);
  }
  return accountJson(200, { ok: true, cancelled_deals: r.cancelled.length, not_cancelled: r.not_cancelled, next: "Your account is deleted. You've been signed out." });
}
