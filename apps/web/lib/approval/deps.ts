// The real dependencies of the approve / pay / callback routes: the Supabase session, the user's
// workspace membership, and the server-side Haggle client (it holds the service token).
import { haggleConfig } from "@/lib/env";
import { haggleClient } from "@/lib/haggle";
import { membership, sessionUser } from "@/lib/workspace";
import type { RouteDeps } from "./route.ts";

export const routeDeps: RouteDeps = {
  async auth() {
    const user = await sessionUser();
    if (!user) return { status: 401 };
    const m = await membership(user.id);
    if (!m) return { status: 403 };
    return { userId: user.id, workspaceId: m.workspace_id };
  },
  client: (workspaceId) => haggleClient(haggleConfig(), workspaceId),
};
