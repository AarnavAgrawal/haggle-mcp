// POST { category, area? }: businesses from public listings (the MCP discover tool). Contacts nobody.
import { vendorDeps } from "@/lib/vendors/deps";
import { handleDiscover } from "@/lib/vendors/route";

export async function POST(req: Request) {
  return handleDiscover(req, vendorDeps);
}
