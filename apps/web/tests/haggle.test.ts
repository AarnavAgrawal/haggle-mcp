// The web app's MCP client (lib/haggle.ts) against a fake fetch: the service headers on every call,
// JSON and server-sent-event answers, the tool error envelope and HTTP refusals as HaggleErrors with
// the server's fix, and `_meta` kept apart from the data. No network.
import { describe, expect, it } from "vitest";
import { haggleClient, HaggleError, parseRpcBody, provisionWorkspace, toolError } from "../lib/haggle.ts";

function fakeFetch(respond: (body: { method: string; params: Record<string, unknown> }) => { status?: number; text: string }) {
  const calls: { url: string; headers: Record<string, string>; body: { method: string; params: Record<string, unknown> } }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const r = respond(body);
    return new Response(r.text, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const cfg = (f: typeof fetch) => ({ baseUrl: "http://haggle.test/", serviceToken: "svc_token", fetchImpl: f });
const sse = (o: unknown) => `event: message\ndata: ${JSON.stringify(o)}\n\n`;

describe("Haggle MCP client", () => {
  it("calls tools as the workspace with the service headers; data, text and meta come back apart", async () => {
    const { f, calls } = fakeFetch(() => ({ text: sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[DEMO] 1 deal" }], structuredContent: { deals: [] }, _meta: { "haggle/approval": { code: "1234" } } } }) }));
    const r = await haggleClient(cfg(f), "ws_u_abc").callTool("list_deals", { limit: 5 });
    expect(r).toEqual({ data: { deals: [] }, text: "[DEMO] 1 deal", meta: { "haggle/approval": { code: "1234" } } });
    expect(calls[0]!.url).toBe("http://haggle.test/mcp");
    expect(calls[0]!.headers).toMatchObject({ "x-haggle-service-token": "svc_token", "x-haggle-workspace": "ws_u_abc" });
    expect(calls[0]!.body).toMatchObject({ method: "tools/call", params: { name: "list_deals", arguments: { limit: 5 } } });
  });

  it("a tool's error envelope and an HTTP refusal become HaggleErrors carrying the server's fix", async () => {
    const env = { ok: false, mode: "mock", error: { code: "job_not_found", message: "No such deal.", fix: "Call list_deals." }, next: "list_deals" };
    const { f } = fakeFetch(() => ({ text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: JSON.stringify(env) }] } }) }));
    await expect(haggleClient(cfg(f), "ws_u_abc").callTool("get_quotes", { job_id: "job_x" })).rejects.toMatchObject({ code: "job_not_found", fix: "Call list_deals.", next: "list_deals" });
    const refused = fakeFetch(() => ({ status: 401, text: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unknown workspace token.", fix: "Connect with …" } }) }));
    const e = await haggleClient(cfg(refused.f), "ws_u_abc").listTools().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HaggleError);
    expect(e).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("parses plain JSON or an SSE frame; a plain-text tool error stays readable", () => {
    expect(parseRpcBody('{"result":1}')).toEqual({ result: 1 });
    expect(parseRpcBody(sse({ result: 2 }))).toEqual({ result: 2 });
    expect(toolError("boom")).toMatchObject({ code: "TOOL_ERROR", message: "boom" });
  });

  it("provisions the workspace with the service token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, workspace_id: "ws_u_abc", created: true }), { status: 201 });
    }) as unknown as typeof fetch;
    expect(await provisionWorkspace(cfg(f), { owner_ref: "user-1", name: "Ada" })).toMatchObject({ workspace_id: "ws_u_abc", created: true });
    expect(calls[0]!.url).toBe("http://haggle.test/internal/workspaces");
    expect(calls[0]!.init.headers).toMatchObject({ "x-haggle-service-token": "svc_token" });
  });
});
