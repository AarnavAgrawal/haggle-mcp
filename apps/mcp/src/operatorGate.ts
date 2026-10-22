// A suspended workspace (scripts/workspace-admin.ts suspend; engine ops/operator.ts) keeps valid
// credentials but every MCP request but the handshake is refused with WORKSPACE_SUSPENDED, so an
// agent sees why and what to do. Its deals are held by the engine; inbound replies are still stored.
// Kept free of the HTTP framework so it can be unit tested.
import type { Runtime } from "./runtime.ts";

export type GateRefusal = { status: 403 | 503; body: { error: { code: string; message: string; fix: string } } };

export async function suspensionRefusal(rt: Pick<Runtime, "engine">, workspaceId: string): Promise<GateRefusal | null> {
  let s: Awaited<ReturnType<Runtime["engine"]["workspaceSuspension"]>>;
  try {
    s = await rt.engine.workspaceSuspension(workspaceId);
  } catch {
    // Fail closed: if the suspension can't be read, nothing of this workspace runs.
    return { status: 503, body: { error: { code: "UNAVAILABLE", message: "Haggle couldn't check this workspace's status.", fix: "Retry in a minute; if it persists, contact the Haggle operator." } } };
  }
  if (!s) return null;
  return {
    status: 403,
    body: { error: { code: "WORKSPACE_SUSPENDED", message: `This Haggle workspace is suspended by its operator (since ${s.at.slice(0, 10)}). Nothing is sent to businesses for its deals while it is suspended.`, fix: "Contact the Haggle operator to resume it. Don't retry and don't contact the businesses through Haggle meanwhile." } },
  };
}
