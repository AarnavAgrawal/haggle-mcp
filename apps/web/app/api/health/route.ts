// GET /api/health: { ok, demo, mcp: { reachable, ... }, config: { required_set, required_missing, optional_set } }.
// Variable names only, never values. 200 when ok, 503 otherwise (for a host's health check).
import { healthReport } from "@/lib/account/health";
import { DEMO } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await healthReport({ env: process.env, demo: DEMO });
  return Response.json(report, { status: report.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
