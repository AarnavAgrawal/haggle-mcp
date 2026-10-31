// POST { contact, category | null }: what this vendor does; deals contact it only for that kind of work.
import { vendorDeps } from "@/lib/vendors/deps";
import { handleCategory } from "@/lib/vendors/route";

export async function POST(req: Request) {
  return handleCategory(req, vendorDeps);
}
