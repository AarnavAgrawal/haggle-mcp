// scripts/check-env.ts: the web app's pre-deploy env check. Every rule, for a live site and a demo
// site, and no value ever printed (only names and rules).
import { describe, expect, it } from "vitest";
import { checkWebEnv, formatReport } from "../scripts/check-env.ts";

const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ iss: "supabase", role })).toString("base64url")}.c2lnbmF0dXJl`;

const LIVE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijkl.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("anon"),
  SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
  HAGGLE_MCP_URL: "https://haggle.run.mcp-use.com",
  HAGGLE_SERVICE_TOKEN: "s".repeat(43),
  ANTHROPIC_API_KEY: "sk-ant-api03-secretvalue",
  CRON_SECRET: "c".repeat(32),
  HAGGLE_TICK_SECRET: "t".repeat(32),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey",
  WEB_CHAT_DAILY_CAP: "2000",
  NEXT_PUBLIC_SUPPORT_EMAIL: "support@haggle.example",
} as const;

const status = (r: ReturnType<typeof checkWebEnv>, name: string) => r.checks.find((c) => c.name === name)?.status;

describe("check-env: live site", () => {
  it("a complete live configuration passes with no warnings", () => {
    const r = checkWebEnv({ ...LIVE }, "live");
    expect(r.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("every required variable missing fails, by name", () => {
    const r = checkWebEnv({}, "live");
    expect(r.ok).toBe(false);
    for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "HAGGLE_MCP_URL", "HAGGLE_SERVICE_TOKEN", "ANTHROPIC_API_KEY", "CRON_SECRET"]) expect(status(r, k), k).toBe("fail");
    for (const k of ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "WEB_CHAT_DAILY_CAP", "NEXT_PUBLIC_SUPPORT_EMAIL"]) expect(status(r, k), k).toBe("warn");
  });

  const bad: [string, Record<string, string>][] = [
    ["NEXT_PUBLIC_SUPABASE_URL", { NEXT_PUBLIC_SUPABASE_URL: "http://abcdefghijkl.supabase.co" }],
    ["NEXT_PUBLIC_SUPABASE_URL", { NEXT_PUBLIC_SUPABASE_URL: "not a url" }],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", { NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("service_role") }],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", { NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_abcdef" }],
    ["SUPABASE_SERVICE_ROLE_KEY", { SUPABASE_SERVICE_ROLE_KEY: jwt("anon") }],
    ["SUPABASE_SERVICE_ROLE_KEY", { SUPABASE_SERVICE_ROLE_KEY: LIVE.NEXT_PUBLIC_SUPABASE_ANON_KEY }],
    ["HAGGLE_MCP_URL", { HAGGLE_MCP_URL: "http://haggle.run.mcp-use.com" }],
    ["HAGGLE_MCP_URL", { HAGGLE_MCP_URL: "https://haggle.run.mcp-use.com/mcp" }],
    ["HAGGLE_MCP_URL", { HAGGLE_MCP_URL: "https://localhost:3000" }],
    ["HAGGLE_SERVICE_TOKEN", { HAGGLE_SERVICE_TOKEN: "too-short" }],
    ["NEXT_PUBLIC_HAGGLE_DEMO", { NEXT_PUBLIC_HAGGLE_DEMO: "true" }],
    ["CRON_SECRET", { CRON_SECRET: "short" }],
    ["HAGGLE_TICK_SECRET", { HAGGLE_TICK_SECRET: "" }],
    ["WEB_CHAT_DAILY_CAP", { WEB_CHAT_DAILY_CAP: "lots" }],
    ["NEXT_PUBLIC_SUPPORT_EMAIL", { NEXT_PUBLIC_SUPPORT_EMAIL: "not-an-email" }],
    ["NEXT_OUTPUT", { NEXT_OUTPUT: "export" }],
    ["NEXT_PUBLIC_STRIPE_SECRET_KEY", { NEXT_PUBLIC_STRIPE_SECRET_KEY: "sk_live_x" }],
  ];
  for (const [name, over] of bad) {
    it(`${name}: ${JSON.stringify(Object.keys(over))} with a bad value fails`, () => {
      const r = checkWebEnv({ ...LIVE, ...over }, "live");
      expect(status(r, name)).toBe("fail");
      expect(r.ok).toBe(false);
    });
  }

  it("a non-Anthropic-looking key and a tick secret reused as the cron secret only warn", () => {
    expect(status(checkWebEnv({ ...LIVE, ANTHROPIC_API_KEY: "something-else" }, "live"), "ANTHROPIC_API_KEY")).toBe("warn");
    const reused = checkWebEnv({ ...LIVE, HAGGLE_TICK_SECRET: LIVE.CRON_SECRET }, "live");
    expect(status(reused, "HAGGLE_TICK_SECRET")).toBe("warn");
    expect(reused.ok).toBe(true);
  });

  it("the service token must not double as the cron or tick secret", () => {
    expect(status(checkWebEnv({ ...LIVE, CRON_SECRET: LIVE.HAGGLE_SERVICE_TOKEN }, "live"), "CRON_SECRET")).toBe("fail");
  });

  it("never prints a value, in text or JSON", () => {
    const env = { ...LIVE, HAGGLE_SERVICE_TOKEN: "short-token-value", NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("service_role"), NEXT_PUBLIC_HAGGLE_DEMO: "true" };
    const r = checkWebEnv(env, "live");
    const out = formatReport(r) + JSON.stringify(r);
    for (const v of Object.values(env)) if (v.length > 5) expect(out).not.toContain(v);
    expect(out).toMatch(/FAIL\s+HAGGLE_SERVICE_TOKEN/);
  });
});

describe("check-env: demo site", () => {
  const DEMO = { ...LIVE, NEXT_PUBLIC_HAGGLE_DEMO: "true", CRON_SECRET: "", HAGGLE_TICK_SECRET: "" };

  it("needs NEXT_PUBLIC_HAGGLE_DEMO=true; the cron secrets are optional", () => {
    const r = checkWebEnv(DEMO, "demo");
    expect(r.ok).toBe(true);
    expect(status(r, "CRON_SECRET")).toBe("pass");
    expect(status(checkWebEnv({ ...DEMO, NEXT_PUBLIC_HAGGLE_DEMO: "" }, "demo"), "NEXT_PUBLIC_HAGGLE_DEMO")).toBe("fail");
  });

  it("a set CRON_SECRET still needs a tick secret", () => {
    expect(status(checkWebEnv({ ...DEMO, CRON_SECRET: "c".repeat(32) }, "demo"), "HAGGLE_TICK_SECRET")).toBe("fail");
  });
});
