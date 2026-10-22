// Launch gate, sprint 5: bounce and failure events are part of the email channel (sprint-4 report §8,
// blocker 2: without message.bounced / message.failed, bounces are seen only by the reconciler's
// sweep). A staging or production subscription without them fails the gate; it names what's missing.
import { describe, expect, it } from "vitest";
import { findMigrationsDir, isEngineMigration, repoMigrations } from "@haggle/engine";
import { EMAIL_EVENTS, runLaunchGate, WEBHOOK_EVENTS, type GateDeps } from "../scripts/launch-gate.ts";

const DIR = findMigrationsDir(import.meta.dirname)!;
const LEDGER = repoMigrations(DIR).filter((m) => isEngineMigration(m.name)).map((m) => ({ name: m.name, checksum: m.checksum, applied_at: "2026-10-22T00:00:00.000Z" }));
const FILE = ["HAGGLE_ENV=staging", "HAGGLE_MODE=live", "INKBOX_API_KEY=ik_SECRETVALUE", "INKBOX_WEBHOOK_SECRET=whsec_SECRETVALUE", "ANTHROPIC_API_KEY=sk-ant-SECRETVALUE", "SUPABASE_DB_URL=postgres://u:hunter2pw@db.stagingref.supabase.co:5432/postgres", "HAGGLE_PROD_DB_HOSTS=prodref123", "HAGGLE_PAYMENTS=manual"].join("\n");
const URL_ = "https://staging.example/webhooks/inkbox";
const gate = (eventTypes: string[]) => runLaunchGate(
  { target: "staging", envFile: "s.env", allowAhead: false, checkWebhooks: true, webhookUrl: URL_, skipConfig: false, skipBuild: true, json: false },
  { readFile: () => FILE, processEnv: {}, migrationsDir: DIR, readLedger: async () => LEDGER, build: () => null, listWebhooks: async () => [{ url: URL_, eventTypes }] } satisfies GateDeps,
).then((r) => r.checks.find((c) => c.name === "webhook subscriptions")!);

describe("launch gate: bounce and failure events", () => {
  it("the email events are message.received, message.bounced and message.failed, all checked", () => {
    expect(EMAIL_EVENTS).toEqual(["message.received", "message.bounced", "message.failed"]);
    expect(WEBHOOK_EVENTS).toEqual(expect.arrayContaining([...EMAIL_EVENTS, "call.ended", "imessage.received", "a2a.sent_task.updated"]));
  });

  it("a subscription without bounce or failure events fails, naming them", async () => {
    expect(await gate(["message.received", "call.ended", "imessage.received", "a2a.sent_task.updated"])).toMatchObject({ status: "fail", detail: expect.stringMatching(/message\.bounced, message\.failed/) });
    expect(await gate(["message.received", "message.bounced"])).toMatchObject({ status: "fail", detail: expect.stringMatching(/message\.failed/) });
  });

  it("all email events pass; the other channels' events only warn when missing", async () => {
    expect(await gate([...EMAIL_EVENTS])).toMatchObject({ status: "warn", detail: expect.stringMatching(/call\.ended/) });
    expect(await gate([...WEBHOOK_EVENTS])).toMatchObject({ status: "pass" });
  });
});
