// POST { email, full_name, organization, use_case?, hp_ref? }: join the waitlist. Public: no session needed.
// Same-origin JSON only; lib/waitlist/route.ts has the rules.
import { waitlistDeps } from "@/lib/waitlist/deps";
import { handleJoin } from "@/lib/waitlist/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleJoin(request, waitlistDeps);
}
