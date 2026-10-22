// Secrets never reach logs, test output, reports or committed docs:
//  * the redacting logger (packages/engine/src/live/log.ts) on a matrix of secret formats, in free
//    text, in errors and under secret-named fields;
//  * the secret scanner (scripts/secret-scan.ts) on committed docs and generated reports.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, redact } from "@haggle/engine";
import { defaultTargets, scanPaths, scanText } from "../scripts/secret-scan.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

// Realistic shapes, fake values. Each must disappear from a log line.
const COVERED: [string, string][] = [
  // Formerly gaps, masked since sprint 4 integration.
  ["supabase secret key (new format)", "sb_secret_AbCdEfGhIjKlMnOpQrStUvWx0123"],
  ["google api key", "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456"],
  ["slack incoming webhook", "https://hooks.slack.com/" + "services/T0ABCDEFG/B0ABCDEFG/AbCdEfGhIjKlMnOpQrStUvWx"],
  ["postgres URL with password", "postgres://postgres.abcdefghijklmnopqrst:Sup3rS3cretPassw0rd@aws-0-us-west-1.pooler.supabase.com:5432/postgres"],
  ["postgresql URL", "postgresql://haggle:hunter2hunter2@db.internal:5432/app"],
  ["bearer token", "Bearer hgw_AbCdEfGhIjKlMnOpQrStUvWx"],
  ["stripe live key", "sk_" + "live_51AbCdEfGhIjKlMnOpQrStUv"],
  ["stripe test key", "sk_" + "test_51AbCdEfGhIjKlMnOpQrStUv"],
  ["stripe restricted key", "rk_" + "live_51AbCdEfGhIjKlMnOpQrStUv"],
  ["anthropic key", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
  ["webhook secret", "whsec_AbCdEfGhIjKlMnOpQrStUvWx0123"],
  ["workspace token", "hgw_AbCdEfGhIjKlMnOpQrStUvWx"],
  ["connector secret", "hgc_AbCdEfGhIjKlMnOpQrStUvWx"],
  ["supabase service-role JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
  ["connector URL", "https://haggle.run.mcp-use.com/c/AbCdEfGhIjKlMnOp/mcp"],
  ["key=value token", "https://api.example.com/hook?token=AbCdEfGhIjKl123"],
  ["email", "ops@acme-catering.example"],
  ["E.164 phone", "+14155550123"],
];

// Formats the redactor doesn't recognise in free text yet (handoff to workstream F, live/log.ts).
// it.fails: these tests pass today only because the leak is real; fixing log.ts turns them red,
// which is the cue to move the case to COVERED.
const GAPS: [string, string][] = [];

function logged(data: Record<string, unknown>): string {
  const lines: string[] = [];
  createLogger({ sink: (_l, line) => lines.push(line) }).error("provider_failed", data);
  return lines.join("\n");
}

describe("the redacting logger, secret formats", () => {
  for (const [name, secret] of COVERED) {
    it(`masks a ${name} in free text, in an error and in nested data`, () => {
      const out = logged({ message: `request failed for ${secret} (retrying)`, error: new Error(`401 using ${secret}`), nested: { list: [`x ${secret} y`] } });
      expect(out).not.toContain(secret);
      expect(out).toContain("retrying");
    });
  }

  it("masks every value under a secret-named field, whatever it looks like", () => {
    const fields = { api_key: "plainvalue1", INKBOX_API_KEY: "ik_live_plainvalue2", webhookSecret: "plainvalue3", authorization: "Basic cGxhaW52YWx1ZTQ=", password: "plainvalue5", db_url: "plainvalue6", connector_url: "plainvalue7", replyTokenSecret: "plainvalue8" };
    const out = logged(fields);
    for (const v of Object.values(fields)) expect(out).not.toContain(v);
    expect(redact({ approver_phone: "415 555 0123", to: "ops@acme.example" })).toEqual({ approver_phone: "[phone]", to: "[email]" });
  });

  for (const [name, secret] of GAPS) {
    it.fails(`known gap (handoff to F): a ${name} in free text is not masked yet`, () => {
      expect(logged({ message: `failed with ${secret}` })).not.toContain(secret);
    });
  }
});

describe("committed docs and generated reports carry no secrets", () => {
  it("the scanner finds each credential shape and ignores placeholders", () => {
    for (const [, s] of [...COVERED.slice(0, 11), ...GAPS]) expect(scanText(`see ${s}`).length, s).toBeGreaterThan(0);
    for (const placeholder of [
      "postgres://postgres:postgres@localhost:5432/postgres", "postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres",
      "postgresql://postgres:[YOUR-PASSWORD]@db.ref.supabase.co:5432/postgres", "STRIPE_SECRET_KEY=sk_test_...", "INKBOX_WEBHOOK_SECRET=whsec_...", "Bearer $HAGGLE_TICK_SECRET",
      "postgres://u:${PASSWORD}@host/db",
    ]) expect(scanText(placeholder), placeholder).toEqual([]);
  });

  it("docs/, the root Markdown files and app READMEs are clean (file:line and pattern only on failure)", () => {
    const findings = scanPaths(defaultTargets(ROOT), ROOT);
    expect(findings.map((f) => `${f.file}:${f.line} ${f.pattern}`)).toEqual([]);
  });
});
