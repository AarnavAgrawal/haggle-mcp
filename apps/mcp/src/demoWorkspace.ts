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

/** A placed call as the engine's PhonePort sees it (the fields the demo needs). */
export interface DemoCallRequest { jobId: string; businessId: string; reason: string; idempotencyKey: string }
export interface DemoCallEnded { callId: string; outcome: "completed"; transcript: string; endedAt: string; simulated: true }

/**
 * The PhonePort for a server with demo workspaces: a demo workspace's call is played, not dialed (it
 * shows as placed, then ends after `delayMs` with the phone persona's transcript, stored as simulated);
 * every other workspace's call goes to the real port.
 */
export function demoPhonePort<R extends DemoCallRequest>(o: {
  real: { placeCall(req: R): Promise<{ callId: string }> };
  workspaceOf: (jobId: string) => Promise<string | null>;
  demoIds: Set<string>;
  transcript: (reason: string) => string;
  ingest: (call: DemoCallEnded) => Promise<unknown>;
  delayMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}): { placeCall(req: R): Promise<{ callId: string }> } {
  let n = 0;
  return {
    async placeCall(req) {
      const ws = await o.workspaceOf(req.jobId);
      if (!ws || !o.demoIds.has(ws)) return o.real.placeCall(req);
      const callId = `demo-call-${Date.now().toString(36)}-${(++n).toString(36)}`;
      const t = setTimeout(() => {
        o.ingest({ callId, outcome: "completed", transcript: o.transcript(req.reason), endedAt: new Date().toISOString(), simulated: true })
          .catch((e: unknown) => o.log?.("demo_call_ingest_failed", { job_id: req.jobId, error: (e as Error).message }));
      }, o.delayMs ?? 20_000);
      (t as { unref?: () => void }).unref?.();
      o.log?.("demo_call_played", { job_id: req.jobId, business_id: req.businessId, call_id: callId });
      return { callId };
    },
  };
}
