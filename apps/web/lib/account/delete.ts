// "Delete my account", in a fixed order so a failure never leaves a live workspace behind a deleted
// user: (1) the MCP server cancels open deals and revokes the workspace (POST /internal/account/revoke),
// (2) chat threads (their messages cascade), (3) the membership, (4) the terms acceptance, (5) the
// Supabase Auth user, (6) the session cookie. If the revoke fails nothing else is touched; it is
// idempotent on the server, so a retry after a later failure completes the rest. Deps are injected
// (lib/account/server.ts wires the real ones) so the order is testable without Supabase or a server.

export type DeleteStep = "revoke" | "threads" | "memberships" | "profile" | "auth_user" | "sign_out";

export interface RevokeResult {
  cancelled: string[];
  not_cancelled: { job_id: string; reason: string }[];
}

export interface DeleteDeps {
  /** Only an owner's deletion revokes the workspace (a plain member leaves it running for the others). */
  role: string;
  revoke(): Promise<RevokeResult>;
  deleteThreads(): Promise<void>;
  deleteMemberships(): Promise<void>;
  deleteProfile(): Promise<void>;
  deleteAuthUser(): Promise<void>;
  signOut(): Promise<void>;
}

export type DeleteOutcome =
  | { ok: true; steps: DeleteStep[]; cancelled: string[]; not_cancelled: RevokeResult["not_cancelled"] }
  | { ok: false; failed_at: DeleteStep; steps: DeleteStep[]; message: string };

export async function deleteAccount(d: DeleteDeps): Promise<DeleteOutcome> {
  const steps: DeleteStep[] = [];
  let revoked: RevokeResult = { cancelled: [], not_cancelled: [] };
  const run = async (step: DeleteStep, f: () => Promise<unknown>) => {
    await f();
    steps.push(step);
  };
  const order: [DeleteStep, () => Promise<unknown>][] = [];
  if (d.role === "owner") order.push(["revoke", async () => { revoked = await d.revoke(); }]);
  order.push(["threads", d.deleteThreads], ["memberships", d.deleteMemberships], ["profile", d.deleteProfile], ["auth_user", d.deleteAuthUser]);
  for (const [step, f] of order) {
    try {
      await run(step, f);
    } catch (err) {
      return { ok: false, failed_at: step, steps, message: err instanceof Error ? err.message : String(err) };
    }
  }
  // The user no longer exists; a failed cookie clear is harmless (the session can't refresh).
  await run("sign_out", d.signOut).catch(() => undefined);
  return { ok: true, steps, cancelled: revoked.cancelled, not_cancelled: revoked.not_cancelled };
}

/** The confirmation the user types. */
export const DELETE_CONFIRMATION = "DELETE";
