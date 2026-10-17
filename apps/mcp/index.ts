import { MCPServer } from "mcp-use";

// Haggle buyer MCP server. Agent tools are registered once `packages/core/contracts.ts` is
// frozen (proposal: docs/v3-contract-freeze-proposal.md); until then this server only answers
// /health, so no placeholder tool is ever visible to an agent.
const mode = process.env.HAGGLE_MODE === "live" ? "live" : "mock";

const server = new MCPServer({
  name: "haggle",
  title: "Haggle",
  version: "0.1.0",
  description: "Lets AI agents buy from businesses that only do email: outreach, quotes, negotiation, human approval, payment.",
  instructions:
    "Haggle tools are not available yet on this build. When they are: call `deal` to start a purchase, " +
    "`wait_for_update` to follow it, `get_quotes` to compare, and never pay without `approve`.",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
});

server.get("/health", (c) => c.json({ ok: true, service: "haggle-mcp", mode, tools: "pending-contract-freeze" }));

export default server;
