// POST { quote_id }: the signed-in human pays the amount they approved (never an amount input).
import { routeDeps } from "@/lib/approval/deps";
import { handleAction } from "@/lib/approval/route";

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  return handleAction("pay", req, (await ctx.params).jobId, routeDeps);
}
