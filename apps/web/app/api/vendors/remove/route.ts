// POST { contact }: Haggle stops contacting this vendor for the workspace.
import { vendorDeps } from "@/lib/vendors/deps";
import { handleRemove } from "@/lib/vendors/route";

export async function POST(req: Request) {
  return handleRemove(req, vendorDeps);
}
