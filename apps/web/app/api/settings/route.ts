// GET: this workspace's settings (approver masked). POST: the owner changes them; a new approver phone
// or email waits for its code (lib/settings/route.ts has the rules).
import { settingsDeps } from "@/lib/settings/deps";
import { handleGet, handleSave } from "@/lib/settings/route";

export const runtime = "nodejs";

export async function GET() {
  return handleGet(settingsDeps);
}

export async function POST(req: Request) {
  return handleSave(req, settingsDeps);
}
