// Quote Broker MCP server entry (DESIGN.md §3). mcp-use dev/build/start use the
// default export; this file only wires things together.
import { isBuilding, MCPServer } from "mcp-use";
import { oauthSupabaseProvider } from "mcp-use/oauth/supabase";
import { secretMatches } from "./src/auth.js";
import { assertSafeStartup } from "./src/config.js";
import { handleLive } from "./src/live/route.js";
import { handleConsent } from "./src/oauth/consent.js";
import { startHostedSimulators } from "./src/sim/hosted.js";
import { registerCreateQuoteRequest } from "./src/tools/createQuoteRequest.js";
import { registerListDemoVendors } from "./src/tools/listDemoVendors.js";
import { registerWaitForJob } from "./src/tools/waitForJob.js";
import { registerListQuotes } from "./src/tools/listQuotes.js";
import { registerRequestApproval } from "./src/tools/requestApproval.js";
import { registerPay } from "./src/tools/pay.js";
import { registerGetJob } from "./src/tools/getJob.js";
import { registerCancelJob } from "./src/tools/cancelJob.js";
import { handlePrimitiveWebhook } from "./src/webhooks/primitive.js";
import { handleTick } from "./src/webhooks/tick.js";

// Refuse to boot with a live Stripe key (§16).
assertSafeStartup();

// AUTH_MODE=oauth: public mode. Anyone signs in with Supabase (GitHub or an
// email link) and gets their own jobs, approvals, and Stripe test customer.
// Otherwise one operator with the shared MCP_AUTH_TOKEN. `mcp-use build` only
// checks views, so it never needs the sign-in settings.
const publicMode = process.env.AUTH_MODE === "oauth" && !isBuilding();
if (publicMode && (!process.env.SUPABASE_URL || !process.env.PUBLIC_BASE_URL)) {
  throw new Error("AUTH_MODE=oauth needs SUPABASE_URL and PUBLIC_BASE_URL.");
}
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");

const config = {
  name: "quote-broker",
  title: "Quote Broker",
  version: "0.2.0",
  description: "Get catering quotes from restaurants by email, compare them, and pay a deposit after a human approves.",
  // §8.2. Returned on initialize so the agent knows the whole flow up front.
  instructions:
    "Use this server to get catering quotes from restaurants and pay a deposit. Typical flow: list_demo_vendors (on the public demo only those restaurants can be contacted), create_quote_request, then wait_for_job until status is ready, then list_quotes, then request_approval for the chosen quote, then wait_for_job until the approval is decided, then pay. Vendors reply over minutes, so always use wait_for_job instead of repeated get_job calls. Share the live_url with the human so they can watch. You cannot pay without a human approval; the server enforces this.",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
};

// Tools read the signed-in user from ctx.auth at runtime (src/caller.ts), so
// both modes share one server type here.
const server = (
  publicMode
    ? new MCPServer({
        ...config,
        oauth: oauthSupabaseProvider({
          supabaseUrl: process.env.SUPABASE_URL!,
          resource: `${publicBaseUrl}/mcp`,
          resourceName: "Quote Broker",
        }),
      })
    : new MCPServer(config)
) as unknown as MCPServer;

// ---------- Token mode: shared bearer token on the MCP endpoint (§16) ----------
// Active only when MCP_AUTH_TOKEN is set, so local dev and the Inspector work
// without it. The Inspector UI itself is left open; its MCP calls still need
// the header. In public mode mcp-use's OAuth gate protects /mcp instead.
if (!publicMode) {
  server.use("*", async (c, next) => {
    const token = process.env.MCP_AUTH_TOKEN;
    const path = c.req.path;
    const isMcp = path === "/mcp" || (path.startsWith("/mcp/") && !path.startsWith("/mcp/inspector"));
    if (token && isMcp && !secretMatches(c.req.header("authorization"), token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}

// ---------- Routes ----------
server.post("/webhooks/primitive", (c) => handlePrimitiveWebhook(c));
server.post("/internal/tick", (c) => handleTick(c));
server.get("/health", (c) => c.json({ ok: true, mode: publicMode ? "public" : "token" }));
// Read-only demo page; off unless LIVE_PAGE_TOKEN is set (S2).
server.get("/live", (c) => handleLive(c));
server.get("/live/:jobId", (c) => handleLive(c));
// Sign-in and consent page that Supabase's OAuth server sends people to.
server.get("/oauth/consent", (c) => handleConsent(c));

// ---------- Tools: the agent API (§8.3), in flow order ----------
export const listDemoVendors = registerListDemoVendors(server);
export const createQuoteRequest = registerCreateQuoteRequest(server);
export const waitForJob = registerWaitForJob(server);
export const listQuotes = registerListQuotes(server);
export const requestApproval = registerRequestApproval(server);
export const pay = registerPay(server);
export const getJob = registerGetJob(server);
export const cancelJob = registerCancelJob(server);

// Restaurant simulators inside the server, so the public demo needs no laptop.
if (process.env.SIM_ON_SERVER === "true" && !isBuilding()) startHostedSimulators();

export default server;
