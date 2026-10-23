// The real dependencies of the approve / pay / callback / purchase routes: the Supabase session, the
// user's workspace membership, and the server-side Haggle client (it holds the service token). Each
// decision is recorded on the server as web:<actor>: the user's email, else their account id.
import { haggleConfig } from "@/lib/env";
import { callService, haggleClient } from "@/lib/haggle";
import { membership, sessionUser } from "@/lib/workspace";
import type { ApprovalClient } from "./flow.ts";
import type { RouteDeps } from "./route.ts";

export const routeDeps: RouteDeps = {
  async auth() {
    const user = await sessionUser();
    if (!user) return { status: 401 };
    const m = await membership(user.id);
    if (!m) return { status: 403 };
    return { userId: user.id, workspaceId: m.workspace_id, actor: user.email || `user:${user.id}` };
  },
  client(workspaceId, actor): ApprovalClient {
    const cfg = haggleConfig();
    const haggle = haggleClient(cfg, workspaceId);
    return {
      callTool: (name, args) => haggle.callTool(name, args),
      service: (path, body) => callService(cfg, path, { workspaceId, actor, body }),
    };
  },
};
