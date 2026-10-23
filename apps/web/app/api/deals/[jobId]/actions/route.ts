// POST /api/deals/<jobId>/actions: the deal page's buttons and forms (answer_business, send_message,
// negotiate, cancel_deal) through the Haggle MCP server, as the signed-in user's workspace.
// Body: lib/dashboard/actions.ts ActionBody. Errors carry the server's message and fix.
import { apiHaggle } from "@/lib/dashboard/api";
import { runDealAction } from "@/lib/dashboard/actions";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const access = await apiHaggle();
  if ("response" in access) return access.response;
  const raw: unknown = await request.json().catch(() => null);
  const r = await runDealAction(access.haggle, jobId, raw);
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
