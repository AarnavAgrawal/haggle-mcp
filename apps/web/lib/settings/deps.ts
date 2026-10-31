// The real dependencies of the settings routes: the session confirmed by the Auth server
// (verifiedSessionUser, not the cached claims), the user's membership and role, and the server-side
// Haggle calls (they hold the service token).
import { limiters } from "@/lib/limiters";
import { callService } from "@/lib/haggle";
import { actorOf, vendorServiceConfig } from "@/lib/vendors/deps";
import { membership, verifiedSessionUser } from "@/lib/workspace";
import type { SettingsDeps } from "./route.ts";

export const settingsDeps: SettingsDeps = {
  async auth() {
    const user = await verifiedSessionUser();
    if (!user) return { status: 401 };
    const m = await membership(user.id);
    if (!m) return { status: 403 };
    return { userId: user.id, workspaceId: m.workspace_id, actor: actorOf(user), guest: user.is_anonymous === true, owner: m.role === "owner" };
  },
  service: (path, opts) => callService(vendorServiceConfig(), path, opts),
  limiter: limiters.settingsWrites,
};
