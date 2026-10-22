// The environment manifest (src/envManifest.ts) covers every variable the code reads, names only
// variables that exist, drives config.ts's checks, and is mirrored by docs/env-manifest.md and
// .env.example. A new process.env read without a manifest entry fails here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConfig, DB_URL_VARS, LIVE_REQUIRED, MOCK_ONLY_FLAGS, PRODUCTION_FORBIDDEN_TRUE } from "../src/config.ts";
import { manifestTable } from "../scripts/env-manifest.ts";
import { ENV_MANIFEST, MANIFEST_BY_NAME, manifestFormatProblems, missingRecommended, OS_VARS, satisfiesRule, targetOf } from "../src/envManifest.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
/** Where configuration is read: the server, its scripts, the engine (+ its scripts and eval harness), the brain it hosts. */
const SCANNED = ["apps/mcp/index.ts", "apps/mcp/src", "apps/mcp/scripts", "packages/engine/src", "packages/engine/scripts", "packages/engine/eval", "packages/brain/src"];

function files(p: string, abs = join(ROOT, p)): string[] {
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? (d.name === "node_modules" || d.name.startsWith(".") ? [] : files("", join(abs, d.name))) : /\.(ts|mts|mjs|js)$/.test(d.name) ? [join(abs, d.name)] : []);
}

/** Static environment reads: env.X, process.env.X, env["X"], env?.X, and { X } = process.env. */
export function envReads(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\b(?:process\.env|env)\s*\??\.\s*([A-Z][A-Z0-9_]*)\b/g)) out.add(m[1]!);
  for (const m of source.matchAll(/\b(?:process\.env|env)\s*\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g)) out.add(m[1]!);
  for (const m of source.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.)?env\b/g)) {
    for (const part of m[1]!.split(",")) {
      const key = part.split(":")[0]!.replace(/\.\.\..*/, "").trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) out.add(key);
    }
  }
  return [...out];
}

const reads = new Map<string, string[]>();
for (const p of SCANNED) for (const f of files(p)) for (const name of envReads(readFileSync(f, "utf8"))) reads.set(name, [...(reads.get(name) ?? []), relative(ROOT, f)]);

describe("the manifest covers every environment read", () => {
  it("the scanner finds each read form (and would catch a new variable)", () => {
    const src = `const a = process.env.HAGGLE_NEW_THING; const b = env?.OTHER_VAR ?? ""; const c = process.env["THIRD_VAR"]; const { FOURTH_VAR, FIFTH_VAR: x, ...rest } = process.env; env.step_id;`;
    expect(envReads(src).sort()).toEqual(["FIFTH_VAR", "FOURTH_VAR", "HAGGLE_NEW_THING", "OTHER_VAR", "THIRD_VAR"]);
    expect(reads.size).toBeGreaterThan(40);
  });

  it("every variable the code reads is in the manifest", () => {
    const missing = [...reads.entries()].filter(([n]) => !MANIFEST_BY_NAME.has(n) && !(OS_VARS as readonly string[]).includes(n)).map(([n, where]) => `${n} (${[...new Set(where)].join(", ")})`);
    expect(missing, "add these to apps/mcp/src/envManifest.ts and docs/env-manifest.md").toEqual([]);
  });

  it("every manifest entry is really read somewhere (no invented names)", () => {
    const corpus = [...SCANNED, "apps/sellers/src", "apps/sellers/scripts", "scripts"].flatMap((p) => files(p)).map((f) => readFileSync(f, "utf8")).join("\n")
      + readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".sh")).map((f) => readFileSync(join(ROOT, "scripts", f), "utf8")).join("\n");
    const unread = ENV_MANIFEST.filter((s) => !s.readBy.includes("platform") && !s.pendingIntegration && !new RegExp(`\\b${s.name}\\b`).test(corpus)).map((s) => s.name);
    expect(unread).toEqual([]);
    // Named ahead of another branch's code: once the code reads it here, drop pendingIntegration.
    const landed = ENV_MANIFEST.filter((s) => s.pendingIntegration && reads.has(s.name)).map((s) => s.name);
    expect(landed, "remove pendingIntegration from these manifest entries").toEqual([]);
  });

  it("names are unique; secrets have no default; each entry says what it is for", () => {
    expect(new Set(ENV_MANIFEST.map((s) => s.name)).size).toBe(ENV_MANIFEST.length);
    for (const s of ENV_MANIFEST) {
      expect(s.purpose.length, s.name).toBeGreaterThan(10);
      if (s.secret) expect(s.default, s.name).toBeUndefined();
      if (s.need.dev === "required") expect([s.need.staging, s.need.production], s.name).toEqual(["required", "required"]);
    }
  });

  it("docs/env-manifest.md and .env.example list every variable", () => {
    const doc = readFileSync(join(ROOT, "docs", "env-manifest.md"), "utf8");
    const table = doc.split("<!-- manifest:start -->\n")[1]?.split("\n<!-- manifest:end -->")[0];
    expect(table, "regenerate with: npx tsx apps/mcp/scripts/env-manifest.ts").toBe(manifestTable());
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(ENV_MANIFEST.filter((s) => !s.readBy.includes("platform") && !new RegExp(`\\b${s.name}=`).test(example)).map((s) => s.name)).toEqual([]);
  });
});

describe("config.ts is driven by the manifest", () => {
  it("live-required, production-refused, refused-when-true and database URL lists come from it", () => {
    expect(LIVE_REQUIRED).toEqual(["INKBOX_API_KEY", "INKBOX_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "SUPABASE_DB_URL"]);
    expect(MOCK_ONLY_FLAGS).toEqual(["HAGGLE_SIM_DELAY_SCALE", "HAGGLE_MOCK_VENDORS", "HAGGLE_MOCK_PERSONAS_FILE", "HAGGLE_PLACES_FIXTURE", "HAGGLE_MOCK_DATABASE_URL", "HAGGLE_MOCK_BRAIN_FILE", "HAGGLE_MOCK_WORKSPACES", "HAGGLE_APPROVALS"]);
    expect(PRODUCTION_FORBIDDEN_TRUE).toEqual(["HAGGLE_DEMO_SPEED", "HAGGLE_ALLOW_ANY_RECIPIENT", "SELLERS_ALLOW_UNSIGNED"]);
    expect(DB_URL_VARS).toEqual(["SUPABASE_DB_URL", "HAGGLE_MOCK_DATABASE_URL", "HAGGLE_TEST_DATABASE_URL"]);
  });

  it("money and data settings that used to fall back silently are refused when malformed", () => {
    const bad = { HAGGLE_GLOBAL_PAYMENT_CAP_CENTS: "$2500", HAGGLE_SPENDING_CAP_CEILING_CENTS: "0", HAGGLE_PAYMENTS: "Manual", HAGGLE_EXTERNAL_SENDERS: "yes", HAGGLE_DB_SCHEMA: "Haggle;drop", HAGGLE_DB_QUEUE_TIMEOUT_MS: "5" };
    expect(checkConfig(bad).errors).toEqual([
      "HAGGLE_DB_QUEUE_TIMEOUT_MS must be an integer from 100 to 60000",
      "HAGGLE_DB_SCHEMA must be a lower-case schema name ([a-z_][a-z0-9_]*)",
      "HAGGLE_PAYMENTS must be one of manual",
      "HAGGLE_GLOBAL_PAYMENT_CAP_CENTS must be an integer from 1 to 1000000",
      "HAGGLE_SPENDING_CAP_CEILING_CENTS must be a positive integer",
      "HAGGLE_EXTERNAL_SENDERS must be one of off, reply_token",
    ]);
    expect(JSON.stringify(checkConfig(bad))).not.toMatch(/\$2500|drop/);
  });

  it("settings with a safe fallback only warn", () => {
    const r = checkConfig({ HAGGLE_ENABLE_CALLS: "yes", HAGGLE_LOG_LEVEL: "verbose", HAGGLE_CALL_HOURS: "nine-five", INKBOX_SENDER_TRUST: "trusting" });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(expect.arrayContaining(["HAGGLE_ENABLE_CALLS must be true or false (anything else counts as false)", "HAGGLE_LOG_LEVEL must be one of debug, info, warn, error", "HAGGLE_CALL_HOURS must be start-end hours, e.g. 9-20", "INKBOX_SENDER_TRUST must be one of outbound-verified, pinned-org-identity"]));
  });

  it("a live development or staging server without HAGGLE_PROD_DB_HOSTS is warned", () => {
    const live = { HAGGLE_MODE: "live", HAGGLE_ENV: "staging", INKBOX_API_KEY: "k", INKBOX_WEBHOOK_SECRET: "s", ANTHROPIC_API_KEY: "a", SUPABASE_DB_URL: "postgres://u:p@db.stagingref.supabase.co:5432/postgres" };
    expect(checkConfig(live).warnings).toContain("HAGGLE_PROD_DB_HOSTS is not set: this server can recognize a production database only by a prod/production marker in its URL");
    expect(checkConfig({ ...live, HAGGLE_PROD_DB_HOSTS: "prodref" }).warnings).toEqual([]);
  });

  it("rules, targets and recommended variables", () => {
    expect(satisfiesRule({ kind: "intRange", min: 1, max: 10 }, " 4 ")).toBe(true);
    expect(satisfiesRule({ kind: "posInt", allowZero: true }, "0")).toBe(true);
    expect(satisfiesRule({ kind: "posInt" }, "1e9")).toBe(false);
    expect(satisfiesRule({ kind: "postgresUrl" }, "mysql://x@y")).toBe(false);
    expect(manifestFormatProblems({}).errors).toEqual([]);
    expect(manifestFormatProblems({ HAGGLE_CONTACT_HOURS: "08:00-19:00", HAGGLE_CONTACT_DAYS: "Mon-Sat", HAGGLE_CONTACT_TIMEZONE: "America/Los_Angeles" })).toEqual({ errors: [], warnings: [] });
    expect(manifestFormatProblems({ HAGGLE_CONTACT_HOURS: "off" }).warnings).toEqual([]);
    expect(manifestFormatProblems({ HAGGLE_CONTACT_HOURS: "8am-7pm", HAGGLE_CONTACT_DAYS: "weekdays", HAGGLE_CONTACT_TIMEZONE: "Pacific" }).warnings).toEqual([
      "HAGGLE_CONTACT_HOURS must be HH:MM-HH:MM (e.g. 08:00-19:00) or off", "HAGGLE_CONTACT_DAYS must be weekday names, e.g. Mon-Sat or Mon,Wed,Fri", "HAGGLE_CONTACT_TIMEZONE must be an IANA time zone, e.g. America/Los_Angeles",
    ]);
    expect(targetOf({})).toBe("mock");
    expect(targetOf({ HAGGLE_MODE: "live" })).toBe("dev");
    expect(targetOf({ HAGGLE_MODE: "live", HAGGLE_ENV: "staging" })).toBe("staging");
    expect(targetOf({ HAGGLE_ENV: "production" })).toBe("production");
    expect(missingRecommended({ HAGGLE_MODE: "live", HAGGLE_ENV: "production", HAGGLE_PAYMENTS: "manual" }, "production")).toEqual(expect.arrayContaining(["HAGGLE_BUILD_SHA", "HAGGLE_ALERT_WEBHOOK_URL", "HAGGLE_AI_DAILY_TOKEN_BUDGET"]));
    expect(missingRecommended({ HAGGLE_PAYMENTS: "manual" }, "production")).not.toContain("HAGGLE_PAYMENTS");
  });
});
