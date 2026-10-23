// POST { quote_id, action?: "pay" | "confirm" }: the signed-in human approves this exact quote.
import { routeDeps } from "@/lib/approval/deps";
import { handleAction } from "@/lib/approval/route";

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  return handleAction("approve", req, (await ctx.params).jobId, routeDeps);
}
