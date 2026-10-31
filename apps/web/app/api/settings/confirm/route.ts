// POST { kind, code } | { token }: the owner confirms a new approver with the code Haggle sent (or the email's link).
import { settingsDeps } from "@/lib/settings/deps";
import { handleConfirm } from "@/lib/settings/route";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleConfirm(req, settingsDeps);
}
