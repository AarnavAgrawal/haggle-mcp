// list_demo_vendors: the simulated restaurants this server may contact. On the
// public demo these are the only allowed vendors (DESIGN.md §16), so the agent
// calls this first instead of guessing addresses.
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getConfig } from "../config.js";
import { parseDemoVendors } from "../vendors/demoVendors.js";
import { ok, runTool } from "./format.js";

const outputSchema = z.object({
  vendors: z.array(z.object({ name: z.string(), email: z.string() })),
  restricted: z.boolean().describe("True when create_quote_request accepts only these vendors"),
  next: z.string(),
});

export function registerListDemoVendors(server: MCPServer) {
  return server.tool(
    {
      name: "list_demo_vendors",
      description:
        "List the simulated demo restaurants you can request catering quotes from. Pass them to create_quote_request as the vendors.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      runTool("list_demo_vendors", async () => {
        const cfg = getConfig();
        const vendors = parseDemoVendors(cfg.DEMO_VENDORS);
        const restricted = cfg.AUTH_MODE === "oauth" || vendors.length > 0;
        return ok({
          vendors,
          restricted,
          next: vendors.length
            ? "Call create_quote_request with these vendors (up to 5)."
            : "No demo restaurants are configured; pass your own vendors to create_quote_request.",
        });
      }),
  );
}
