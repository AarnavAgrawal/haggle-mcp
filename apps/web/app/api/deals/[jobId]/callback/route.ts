// POST { business_id }: the signed-in human authorizes one Voice AI callback to that business.
import { routeDeps } from "@/lib/approval/deps";
import { handleAction } from "@/lib/approval/route";

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  return handleAction("callback", req, (await ctx.params).jobId, routeDeps);
}
