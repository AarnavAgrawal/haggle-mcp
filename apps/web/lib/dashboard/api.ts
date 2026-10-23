// API-route access: the signed-in user's Haggle client, or a JSON refusal (API routes never redirect).
import { haggleConfig } from "@/lib/env";
import { haggleClient, type HaggleClient } from "@/lib/haggle";
import { membership, sessionUser } from "@/lib/workspace";

const json = (status: number, code: string, message: string, fix: string) =>
  Response.json({ ok: false, error: { code, message, fix } }, { status, headers: { "cache-control": "no-store" } });

export async function apiHaggle(): Promise<{ haggle: HaggleClient } | { response: Response }> {
  try {
    const user = await sessionUser();
    if (!user) return { response: json(401, "signed_out", "You're signed out.", "Sign in again.") };
    const m = await membership(user.id);
    if (!m) return { response: json(403, "no_workspace", "You don't belong to a Haggle workspace yet.", "Finish onboarding first.") };
    return { haggle: haggleClient(haggleConfig(), m.workspace_id) };
  } catch {
    return { response: json(500, "server_config", "The web app couldn't check your workspace.", "Try again; if it keeps failing, the operator should check the web app's configuration.") };
  }
}
