// A scripted stand-in for the Claude Messages API, for the tier-2 browser test only (e2e/tier2.ts points
// the web app at it with ANTHROPIC_BASE_URL; the SDK reads that variable). It answers POST /v1/messages
// with the streaming event sequence the SDK's BetaMessageStream parses (message_start,
// content_block_start/_delta/_stop, message_delta, message_stop), following the chat prompt's contract
// (lib/chat/prompt.ts "Starting a deal"):
//   1. a new request              -> a deal tool call with dry_run: true
//   2. the dry run's tool result  -> a short preview, asking the user to confirm
//   3. the user confirms ("yes")  -> the same deal call without dry_run
//   4. the deal's tool result     -> "DEMO: the deal has started", with the live page's path
// Stateless: each step is read from the conversation the web app sends. Nothing leaves this machine.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Message = { role: "user" | "assistant"; content: string | Block[] };

/** The catering request the mock caterers answer (approval.e2e.test.ts uses the same one). */
export function demoDealArgs(now = Date.now()): Record<string, unknown> {
  return {
    request: {
      what: "lunch catering", quantity: 40, unit: "people", date: new Date(now + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA",
      requirements: [
        { id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 },
        { id: "delivery", kind: "delivery", text: "Delivery included", hard: true },
      ],
    },
    budget_usd: 1200,
  };
}

const blocks = (m: Message | undefined): Block[] => (!m ? [] : typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
const textOf = (m: Message | undefined) => blocks(m).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
const resultText = (b: Block) => (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c.text ?? "").join("\n") : "");

/** The scripted reply to a conversation: content blocks and a stop reason. */
export function scriptedReply(messages: Message[]): { content: Block[]; stop_reason: "tool_use" | "end_turn" } {
  const last = messages[messages.length - 1];
  const results = blocks(last).filter((b) => b.type === "tool_result");
  if (results.length) {
    const uses = blocks(messages[messages.length - 2]).filter((b) => b.type === "tool_use");
    const r = results[0]!;
    const use = uses.find((u) => u.id === r.tool_use_id);
    if (r.is_error) return say(`Haggle couldn't do that: ${resultText(r).split("\n")[0]}`);
    if (use?.name === "deal" && use.input?.dry_run === true) {
      return say("DEMO: here's the preview. Lunch for 40 in San Francisco, at least 12 vegetarian, delivery included, budget $1,200. Haggle would contact the simulated caterers. Reply yes to start.");
    }
    if (use?.name === "deal") {
      const job = resultText(r).match(/"job_id"\s*:\s*"([^"]+)"/)?.[1];
      return say(`DEMO: the deal has started. Live progress is at /deals/${job ?? "<job>"}.`);
    }
    return say("Done.");
  }
  const previewed = messages.some((m) => m.role === "assistant" && blocks(m).some((b) => b.type === "tool_use" && b.name === "deal" && b.input?.dry_run === true));
  const confirmed = /\b(yes|confirm|go ahead|start it)\b/i.test(textOf(last));
  const input = previewed && confirmed ? demoDealArgs() : { ...demoDealArgs(), dry_run: true };
  return { content: [{ type: "tool_use", id: `toolu_fake_${Date.now().toString(36)}`, name: "deal", input }], stop_reason: "tool_use" };
}

function say(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" as const };
}

function writeStream(res: ServerResponse, model: string, reply: ReturnType<typeof scriptedReply>) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "request-id": "req_fake" });
  const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", {
    message: { id: `msg_fake_${Date.now().toString(36)}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  reply.content.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      // Two deltas, so the UI's streaming path runs.
      const t = b.text ?? "";
      const cut = Math.ceil(t.length / 2);
      for (const part of [t.slice(0, cut), t.slice(cut)]) if (part) send("content_block_delta", { index, delta: { type: "text_delta", text: part } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", {});
  res.end();
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface FakeAnthropic {
  url: string;
  /** Tool calls the fake asked for, in order (name + whether it was a dry run). */
  calls: { tool: string; dry_run: boolean }[];
  close(): Promise<void>;
}

export async function startFakeAnthropic(port = 0): Promise<FakeAnthropic> {
  const calls: FakeAnthropic["calls"] = [];
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "POST" || !path?.endsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake: only POST /v1/messages" } }));
        return;
      }
      const params = JSON.parse(await body(req)) as { model?: string; messages?: Message[]; stream?: boolean };
      const reply = scriptedReply(params.messages ?? []);
      for (const b of reply.content) if (b.type === "tool_use") calls.push({ tool: b.name ?? "", dry_run: b.input?.dry_run === true });
      writeStream(res, params.model ?? "claude-fake", reply);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: p } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${p}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
