// The background-tick backup (app/api/cron/tick): GET with Authorization: Bearer <CRON_SECRET> forwards
// one POST /internal/tick to the MCP server with HAGGLE_TICK_SECRET and returns its JSON. Anything else
// is refused before any request is made. No response ever carries either secret. Fake fetch, no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCronTick, type CronTickDeps } from "../app/api/cron/tick/handler.ts";

const CRON = "cron-secret-0123456789abcdef";
const TICK = "tick-secret-fedcba9876543210";
const WEB = join(import.meta.dirname, "..");

const get = (auth?: string) => new Request("https://web.test/api/cron/tick", { headers: auth === undefined ? {} : { authorization: auth } });

function deps(over: Partial<CronTickDeps> = {}, reply: () => Promise<Response> = async () => Response.json({ ok: true, advanced: 3, failed: 0 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { calls, deps: { env: { CRON_SECRET: CRON, HAGGLE_TICK_SECRET: TICK, HAGGLE_MCP_URL: "https://mcp.example.com/" }, fetchImpl, ...over } satisfies CronTickDeps };
}

async function body(r: Response) {
  const text = await r.text();
  expect(text).not.toContain(CRON);
  expect(text).not.toContain(TICK);
  return JSON.parse(text) as { ok?: boolean; error?: { code: string; message: string; fix?: string } } & Record<string, unknown>;
}

describe("cron tick: authorization", () => {
  it("404 when CRON_SECRET isn't set (or is too short); nothing is called", async () => {
    for (const secret of [undefined, "", "short"]) {
      const d = deps({ env: { CRON_SECRET: secret, HAGGLE_TICK_SECRET: TICK } });
      const r = await handleCronTick(get(`Bearer ${secret ?? ""}`), d.deps);
      expect(r.status).toBe(404);
      expect((await body(r)).error?.code).toBe("cron_disabled");
      expect(d.calls).toEqual([]);
    }
  });

  it("401 without the right bearer; nothing is called", async () => {
    for (const auth of [undefined, "", CRON, `Basic ${CRON}`, "Bearer wrong", `Bearer ${CRON}x`, `Bearer ${TICK}`, "Bearer é".padEnd(CRON.length + 7, "é")]) {
      const d = deps();
      const r = await handleCronTick(get(auth), d.deps);
      expect(r.status, String(auth)).toBe(401);
      expect((await body(r)).error?.code).toBe("unauthorized");
      expect(d.calls).toEqual([]);
    }
  });

  it("503 when HAGGLE_TICK_SECRET isn't set on the web app; nothing is called", async () => {
    const d = deps({ env: { CRON_SECRET: CRON, HAGGLE_MCP_URL: "https://mcp.example.com" } });
    const r = await handleCronTick(get(`Bearer ${CRON}`), d.deps);
    expect(r.status).toBe(503);
    const b = await body(r);
    expect(b.error?.code).toBe("tick_not_configured");
    expect(b.error?.fix).toMatch(/HAGGLE_TICK_SECRET/);
    expect(d.calls).toEqual([]);
  });

  it("refuses to send the tick secret over plain http to a remote host", async () => {
    const d = deps({ env: { CRON_SECRET: CRON, HAGGLE_TICK_SECRET: TICK, HAGGLE_MCP_URL: "http://mcp.example.com" } });
    const r = await handleCronTick(get(`Bearer ${CRON}`), d.deps);
    expect(r.status).toBe(503);
    expect((await body(r)).error?.code).toBe("insecure_mcp_url");
    expect(d.calls).toEqual([]);
  });
});

describe("cron tick: forwarding", () => {
  it("forwards one POST /internal/tick with the tick secret (never the cron secret) and returns its JSON", async () => {
    const d = deps();
    const r = await handleCronTick(get(`Bearer ${CRON}`), d.deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
    expect(await body(r)).toEqual({ ok: true, advanced: 3, failed: 0 });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.url).toBe("https://mcp.example.com/internal/tick");
    expect(d.calls[0]!.init.method).toBe("POST");
    const h = new Headers(d.calls[0]!.init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${TICK}`);
    expect(JSON.stringify(d.calls[0]!.init)).not.toContain(CRON);
    expect(d.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts a case-insensitive Bearer scheme and a local http server (development)", async () => {
    const d = deps({ env: { CRON_SECRET: CRON, HAGGLE_TICK_SECRET: TICK } });
    const r = await handleCronTick(get(`bearer ${CRON}`), d.deps);
    expect(r.status).toBe(200);
    expect(d.calls[0]!.url).toBe("http://localhost:3000/internal/tick");
  });

  const upstream: [string, () => Promise<Response>, number, string][] = [
    ["401 (secrets differ)", async () => Response.json({ error: "unauthorized" }, { status: 401 }), 502, "tick_refused"],
    ["404 (tick off on the server)", async () => Response.json({ error: "tick is disabled" }, { status: 404 }), 502, "tick_disabled"],
    ["503 (server not configured)", async () => Response.json({ error: "not configured" }, { status: 503 }), 503, "mcp_not_ready"],
    ["500", async () => new Response("boom", { status: 500 }), 502, "mcp_error"],
    ["200 that isn't JSON", async () => new Response("<html>login</html>", { status: 200 }), 502, "bad_response"],
    ["a network failure", async () => { throw new TypeError("fetch failed"); }, 502, "mcp_unreachable"],
    ["a timeout", async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, 504, "mcp_timeout"],
  ];
  for (const [what, reply, status, code] of upstream) {
    it(`maps ${what} to ${status} ${code}, with a fix`, async () => {
      const d = deps({}, reply);
      const r = await handleCronTick(get(`Bearer ${CRON}`), d.deps);
      expect(r.status).toBe(status);
      const b = await body(r);
      expect(b.ok).toBe(false);
      expect(b.error?.code).toBe(code);
      expect(b.error?.fix).toBeTruthy();
    });
  }
});

describe("cron tick: deployment files", () => {
  it("vercel.json schedules GET /api/cron/tick with a five-field cron expression", () => {
    const v = JSON.parse(readFileSync(join(WEB, "vercel.json"), "utf8")) as { crons?: { path: string; schedule: string }[] };
    const tick = v.crons?.find((c) => c.path === "/api/cron/tick");
    expect(tick).toBeDefined();
    expect(tick!.schedule.trim().split(/\s+/)).toHaveLength(5);
  });

  it("the route is GET only, on the Node runtime, never cached", () => {
    const src = readFileSync(join(WEB, "app", "api", "cron", "tick", "route.ts"), "utf8");
    expect(src).toMatch(/export (async )?function GET\b/);
    expect(src).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)\b/);
    expect(src).toMatch(/runtime = "nodejs"/);
    expect(src).toMatch(/dynamic = "force-dynamic"/);
  });
});
