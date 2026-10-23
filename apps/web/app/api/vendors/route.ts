// GET: this workspace's vendors. POST { name, contact, channel?, consent_basis, note?, attested: true }:
// add one, with the consent the signed-in user attests (recorded on the MCP server).
import { vendorDeps } from "@/lib/vendors/deps";
import { handleAdd, handleList } from "@/lib/vendors/route";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleList(vendorDeps);
}

export async function POST(req: Request) {
  return handleAdd(req, vendorDeps);
}
