// POST { kind }: the owner withdraws a pending approver change; the current approver stays.
import { settingsDeps } from "@/lib/settings/deps";
import { handleCancel } from "@/lib/settings/route";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleCancel(req, settingsDeps);
}
