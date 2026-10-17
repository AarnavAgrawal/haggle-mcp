/**
 * Seller webhook server: Inkbox posts mail and A2A events for each seller identity to
 * POST /webhooks/inkbox/<handle>. Signatures are verified with that identity's signing key.
 *
 *   npm run setup -w @haggle/sellers   # once: identities, phone persona, A2A, webhooks
 *   npm run dev -w @haggle/sellers     # SELLERS_FAST=1 for demo-speed replies
 */
import { createServer, type IncomingMessage } from "node:http";
import { Inkbox, verifyWebhook, type AgentIdentity } from "@inkbox/sdk";
import { createSellerApp, type SellerPorts } from "./app.ts";
import { createClaudeComposer, templateReply, type Composer } from "./compose.ts";
import { PERSONAS } from "./personas.ts";
import { join } from "node:path";
import { DATA_DIR, StateStore, loadRegistry } from "./store.ts";

const PORT = Number(process.env.SELLERS_PORT ?? 8787);
const ROUTE = /^\/webhooks\/inkbox\/([a-z0-9-]+)\/?$/;

const registry = loadRegistry();
const inkbox = new Inkbox(); // INKBOX_API_KEY
const identities = new Map<string, Promise<AgentIdentity>>();
const identity = (handle: string) => {
  if (!identities.has(handle)) identities.set(handle, inkbox.getIdentity(handle));
  return identities.get(handle)!;
};

const ports: SellerPorts = {
  async replyEmail(handle, { messageId, bodyText, attachments }) {
    await (await identity(handle)).replyAllEmail(messageId, { bodyText, attachments, idempotencyKey: `seller-reply-${messageId}` });
  },
  async getEmailBody(handle, messageId) {
    return (await (await identity(handle)).getMessage(messageId)).bodyText ?? "";
  },
  async getA2ATask(handle, taskId) {
    const task = await (await identity(handle)).a2aTask(taskId);
    const last = [...task.messages].reverse().find((m) => m.role !== "agent") ?? task.messages.at(-1);
    const parts = last?.parts ?? [];
    const text = parts.flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("\n");
    const data = parts.find((part) => part.data && typeof part.data === "object")?.data;
    return { contextId: task.contextId, text, data };
  },
  async replyA2A(handle, taskId, { text, data }) {
    await (await identity(handle)).a2aReply(taskId, { intent: "complete", text, ...(data ? { parts: [{ data }] } : {}) });
  },
};

const useClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const composer: Composer = useClaude ? createClaudeComposer() : { write: async (p, plan) => templateReply(p, plan) };

const app = createSellerApp({
  ports,
  composer,
  state: new StateStore(process.env.SELLERS_STATE_FILE ?? join(DATA_DIR, "sellers-state.json")),
  ownAddresses: new Set(Object.values(registry).flatMap((r) => (r.email ? [r.email.toLowerCase()] : []))),
  fast: process.env.SELLERS_FAST === "1",
});

const allowUnsigned = process.env.SELLERS_ALLOW_UNSIGNED === "1";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, sellers: PERSONAS.map((p) => p.handle) }));
    return;
  }
  const match = req.method === "POST" ? url.pathname.match(ROUTE) : null;
  if (!match) {
    res.writeHead(404).end();
    return;
  }
  const handle = match[1]!;
  const raw = await readBody(req);
  const secret = registry[handle]?.signingKey;
  const signed = secret ? verifyWebhook({ payload: raw, headers: req.headers, secret }) : allowUnsigned;
  if (!signed) {
    res.writeHead(401).end("bad or missing signature");
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    res.writeHead(400).end("invalid JSON");
    return;
  }
  // Acknowledge fast; replies are scheduled (businesses take time to answer).
  res.writeHead(202).end();
  app.handleEvent(handle, payload).then(
    (r) => console.log(`[sellers] ${handle}: ${r.accepted ? r.action : `rejected: ${r.reason}`}`),
    (e: unknown) => console.error(`[sellers] ${handle}: ${(e as Error).message}`),
  );
});

server.listen(PORT, async () => {
  console.log(`[sellers] listening on http://localhost:${PORT} (fast=${process.env.SELLERS_FAST === "1"}, replies=${useClaude ? "claude" : "templates"})`);
  const tunnelName = process.env.SELLERS_TUNNEL;
  if (tunnelName) {
    const { connect } = await import("@inkbox/sdk/tunnels/connect");
    await connect(inkbox, { name: tunnelName, forwardTo: `http://127.0.0.1:${PORT}` });
    console.log(`[sellers] tunnel up: https://${tunnelName}.inkboxwire.com → localhost:${PORT}`);
  }
});

process.on("SIGINT", async () => {
  console.log("[sellers] finishing scheduled replies…");
  await app.idle();
  process.exit(0);
});
