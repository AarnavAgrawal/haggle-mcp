// Demo workspaces on a live server (HAGGLE_DEMO_WORKSPACES, comma-separated workspace ids): a login
// that shows the real product against Haggle's own simulated sellers (Inkbox mailboxes answered by the
// seller personas), e.g. for a reviewer. Its deals contact only the vendors the operator saved for it
// (workspace-admin add-vendor): Haggle never finds businesses for it, and nobody can add vendors to it
// from the app, so a demo login can never email a real business.

/** The demo workspace ids configured on this server. */
export function demoWorkspaceIds(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.HAGGLE_DEMO_WORKSPACES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/** Is this workspace a demo workspace? */
export const isDemoWorkspace = (workspaceId: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean =>
  !!workspaceId && demoWorkspaceIds(env).has(workspaceId);

/** Why a demo workspace doesn't find or add businesses (shown to the user). */
export const DEMO_WORKSPACE_REASON = "this is a demo workspace: it contacts only Haggle's own demo businesses, never real ones";
