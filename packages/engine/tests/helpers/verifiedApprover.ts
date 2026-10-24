// The operator's out-of-band approver check (workspace-admin verify-approver), as the tests' setup: a live
// workspace with its own vendors contacts nobody until its approver phone is verified (Engine.outreachBlock).
import { recordOperatorAction } from "../../src/ops/operator.ts";
import type { Repository } from "../../src/store/types.ts";

export async function verifyApprover(repo: Pick<Repository, "getSettings" | "appendOperatorAction" | "listOperatorActions">, workspaceId: string, phone?: string): Promise<void> {
  const p = phone ?? (await repo.getSettings(workspaceId))?.approver_phone;
  if (!p) throw new Error(`verifyApprover: ${workspaceId} has no approver phone`);
  await recordOperatorAction(repo, { action: "approver_verified", operator: "ops@test", reason: "code read back on a call", workspaceId, detail: { phone: p } });
}
