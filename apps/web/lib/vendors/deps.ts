// The real dependencies of the vendor routes and page: the Supabase session, the user's workspace
// membership, and the server-side Haggle calls (they hold the service token).
import type { User } from "@supabase/supabase-js";
import { DEMO } from "@/lib/demo";
import { haggleConfig } from "@/lib/env";
import { callService, haggleClient, type HaggleConfig } from "@/lib/haggle";
import { membership, sessionUser } from "@/lib/workspace";
import type { VendorDeps } from "./route.ts";

/**
 * The MCP server (mcp-use) answers 400 "Invalid JSON" to a GET that says content-type: application/json
 * but has no body, which callService sends on every request: drop the header when there is no body.
 */
const bodylessGetFetch: typeof fetch = (input, init) => {
  if (init && init.body === undefined && (init.method ?? "GET") === "GET" && init.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)) {
    const { "content-type": _drop, ...headers } = init.headers as Record<string, string>;
    return fetch(input, { ...init, headers });
  }
  return fetch(input, init);
};
export const vendorServiceConfig = (): HaggleConfig => ({ ...haggleConfig(), fetchImpl: bodylessGetFetch });

/** Who attested a consent, as recorded on the vendor row: the sign-in email (and the account id). */
export const actorOf = (user: Pick<User, "id" | "email">) => (user.email ? `${user.email} (${user.id})` : user.id).slice(0, 200);

export const vendorDeps: VendorDeps = {
  async auth() {
    const user = await sessionUser();
    if (!user) return { status: 401 };
    const m = await membership(user.id);
    if (!m) return { status: 403 };
    return { userId: user.id, workspaceId: m.workspace_id, actor: actorOf(user), guest: user.is_anonymous === true };
  },
  service: (path, opts) => callService(vendorServiceConfig(), path, opts),
  async discover(workspaceId, args) {
    return (await haggleClient(haggleConfig(), workspaceId).callTool<Record<string, unknown>>("discover", args)).data;
  },
  demo: DEMO,
};
