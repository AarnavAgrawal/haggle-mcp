// GET: where the purchase stands after approval (stage, the business's payment instructions as
// untrusted text, which buttons make sense). POST { action: "paid" | "booked" | "cancel" }: the signed-in
// human reports paying the vendor directly, accepts the booking, or cancels it (recorded as theirs).
import { routeDeps } from "@/lib/approval/deps";
import { handleAction, handlePurchaseStatus } from "@/lib/approval/route";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  return handlePurchaseStatus((await ctx.params).jobId, routeDeps);
}

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  return handleAction("purchase", req, (await ctx.params).jobId, routeDeps);
}
