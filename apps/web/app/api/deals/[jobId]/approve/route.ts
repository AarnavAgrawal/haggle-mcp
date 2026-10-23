// POST { quote_id, action?: "pay" | "confirm" }: preview the approval for this exact quote (business,
// amount paid now, total, caveats). POST { quote_id, approval_id, decision }: the signed-in human's
// confirm (or decline), recorded as theirs. No code ever reaches the browser.
import { routeDeps } from "@/lib/approval/deps";
import { handleAction } from "@/lib/approval/route";

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  return handleAction("approve", req, (await ctx.params).jobId, routeDeps);
}
