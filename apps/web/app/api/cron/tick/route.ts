// GET /api/cron/tick: the scheduled backup of the MCP server's own 30 s tick (apps/web/vercel.json;
// docs/production-deploy.md). Bearer CRON_SECRET in, POST /internal/tick with HAGGLE_TICK_SECRET out.
import { handleCronTick } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return handleCronTick(request, { env: process.env });
}
