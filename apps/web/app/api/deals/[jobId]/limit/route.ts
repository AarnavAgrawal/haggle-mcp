// POST { limit_usd }: the signed-in human sets this deal's spending limit (raise up to the server
// ceiling, or lower). POST { limit_usd, quote_id, action? }: "This is $X over the limit you set for this
// deal. Raise it to $Y and approve?" as one action, recorded as theirs. The model can never call this.
import { routeDeps } from "@/lib/approval/deps";
import { handleAction } from "@/lib/approval/route";

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  return handleAction("limit", req, (await ctx.params).jobId, routeDeps);
}
