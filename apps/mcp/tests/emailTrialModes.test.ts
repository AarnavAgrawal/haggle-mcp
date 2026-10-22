// scripts/email-trial.ts validate and dry-run (no network, nothing written), every send gate refusing
// on its own, and the trial's offline replay of captured replies through the real pipeline (the same
// path collect reports). The script is run under plain node only in modes that contact nothing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InkboxMessageDetail } from "@haggle/engine";
import { buildReport, compareMessageIds, EMPTY_FS, evaluateReply, newRun, planTrial, plannedSend, problems, renderMarkdown, sendGates, TRIAL_FLAG, trialEmail, validateTrial, withPipeline, type TrialRun } from "../scripts/email-trial-lib.ts";
import { replayCaptures } from "../scripts/email-trial-replay.ts";

const REPO = "/repo/haggle";
const ME = "tester@gmail.example";
const OTHER = "tester2@outlook.example";
const BUYER = "haggle@inkboxmail.test";
const env = { HAGGLE_EMAIL_TRIAL: "1", HAGGLE_EMAIL_TRIAL_MAILBOXES: `${ME}, ${OTHER}`, HAGGLE_ENV: "staging", INKBOX_API_KEY: "ik_test_key_value", INKBOX_IDENTITY: "haggle-staging" };
const send = ["send", "--to", ME, "--run", "/tmp/trials/t1", TRIAL_FLAG];

describe("sending: each gate refuses on its own", () => {
  const cases: [string, string[], Record<string, string | undefined>, RegExp][] = [
    ["HAGGLE_EMAIL_TRIAL unset", send, { ...env, HAGGLE_EMAIL_TRIAL: undefined }, /disabled/],
    ["HAGGLE_EMAIL_TRIAL=true (only 1 counts)", send, { ...env, HAGGLE_EMAIL_TRIAL: "true" }, /disabled/],
    ["no allowlist", send, { ...env, HAGGLE_EMAIL_TRIAL_MAILBOXES: undefined }, /empty/],
    ["allowlist of malformed entries only", send, { ...env, HAGGLE_EMAIL_TRIAL_MAILBOXES: "not-an-address, @gmail.com" }, /not one plain ASCII address/],
    ["recipient not listed", ["send", "--to", "stranger@example.com", "--run", "/tmp/t", TRIAL_FLAG], env, /not an exact entry of HAGGLE_EMAIL_TRIAL_MAILBOXES/],
    ["no ownership flag", send.filter((a) => a !== TRIAL_FLAG), env, new RegExp(TRIAL_FLAG)],
    ["a look-alike flag", [...send.filter((a) => a !== TRIAL_FLAG), "--i-own-this-mailbox=yes"], env, new RegExp(TRIAL_FLAG)],
    ["run directory inside the repository", ["send", "--to", ME, "--run", `${REPO}/x`, TRIAL_FLAG], env, /outside the repository/],
    ["no run directory", ["send", "--to", ME, TRIAL_FLAG], env, /--run/],
    ["no recipient", ["send", "--run", "/tmp/t", TRIAL_FLAG], env, /--to/],
  ];
  for (const [name, argv, e, err] of cases) {
    it(name, () => expect(planTrial(argv, e, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(err) }));
  }
  it("collect is gated the same way (flag, allowlist, env)", () => {
    expect(planTrial(["collect", "--run", "/tmp/t"], env, REPO)).toMatchObject({ ok: false });
    expect(planTrial(["collect", "--run", "/tmp/t", TRIAL_FLAG], { ...env, HAGGLE_EMAIL_TRIAL: "0" }, REPO)).toMatchObject({ ok: false });
    expect(planTrial(["collect", "--run", "/tmp/t", TRIAL_FLAG], { HAGGLE_EMAIL_TRIAL: "1" }, REPO)).toMatchObject({ ok: false });
  });
  it("all gates passed: a send plan; sendGates reports each one", () => {
    expect(planTrial(send, env, REPO)).toMatchObject({ ok: true, cmd: { kind: "send", to: ME } });
    expect(problems(sendGates(env, send, ME, REPO, EMPTY_FS, "0.7.19", "/tmp/trials/t1"))).toEqual([]);
    expect(problems(sendGates({}, [], "x@y.example")).map((c) => `${c.status} ${c.check}`)).toEqual([
      "BLOCKED HAGGLE_EMAIL_TRIAL", "BLOCKED HAGGLE_ENV", "BLOCKED INKBOX_API_KEY", "BLOCKED INKBOX_IDENTITY", "BLOCKED HAGGLE_EMAIL_TRIAL_MAILBOXES", `BLOCKED ${TRIAL_FLAG}`, "FAIL --to", "BLOCKED --run",
    ]);
  });
});

describe("validate and dry-run contact nothing and need no gate", () => {
  it("plans validate and dry-run without HAGGLE_EMAIL_TRIAL; dry-run still refuses a run directory in the repository", () => {
    expect(planTrial(["validate"], {}, REPO)).toEqual({ ok: true, cmd: { kind: "validate", runDir: null, to: null } });
    expect(planTrial(["dry-run", "--to", ME.toUpperCase(), "--run", "/tmp/t"], {}, REPO)).toEqual({ ok: true, cmd: { kind: "dry-run", to: ME, runDir: "/tmp/t", buyer: null } });
    expect(planTrial(["dry-run", "--to", ME, "--run", `${REPO}/t`], {}, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(/outside the repository/) });
    expect(planTrial(["dry-run", "--run", "/tmp/t"], {}, REPO)).toMatchObject({ ok: false });
  });

  it("validate reports env names (never values), the allowlist, the run directory, the SDK and the gates", () => {
    const run = newRun({ to: ME, buyerMailbox: BUYER, now: new Date("2026-10-23T09:00:00Z") });
    run.send = { id: "out_1", messageId: "<a@b.example>", status: "sent", at: "2026-10-23T09:00:01Z" };
    const fs = { ...EMPTY_FS, exists: (p: string) => p === "/tmp/t" || p === "/tmp/t/run.json" || p === "/tmp/t/raw", list: () => ["a.json", "b.json", "x.txt"], mode: () => 0o700, read: () => JSON.stringify(run) };
    const v = validateTrial({ kind: "validate", runDir: "/tmp/t", to: ME }, { ...env, INKBOX_API_KEY: "ik_live_SECRET_VALUE" }, [TRIAL_FLAG], REPO, fs, "0.7.19");
    expect(JSON.stringify(v)).not.toContain("SECRET_VALUE");
    expect(v.target).toBe("collect"); // the directory holds a run: collect is next
    const by = Object.fromEntries(v.checks.map((c) => [c.check, c]));
    expect(by.INKBOX_API_KEY).toMatchObject({ status: "ok", detail: "set (value not shown)" });
    expect(by["run state"]).toMatchObject({ status: "ok", detail: expect.stringMatching(/sent .*2 capture/) });
    expect(by["@inkbox/sdk"]).toMatchObject({ status: "ok", detail: expect.stringMatching(/0\.7\.19/) });
    expect(v.ok).toBe(true);
    const junk = validateTrial({ kind: "validate", runDir: "/tmp/t", to: ME }, { ...env, HAGGLE_EMAIL_TRIAL_MAILBOXES: `${ME}, junk` }, [TRIAL_FLAG], REPO, fs, "0.7.19");
    expect(junk.checks.find((c) => c.check === "HAGGLE_EMAIL_TRIAL_MAILBOXES")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/1 entry is not one plain ASCII address/) });
    const bad = validateTrial({ kind: "validate", runDir: `${REPO}/t`, to: "x@y.example" }, {}, [], REPO, EMPTY_FS, null);
    expect(bad.ok).toBe(false);
    expect(problems(bad.checks).map((c) => c.check)).toEqual(["HAGGLE_EMAIL_TRIAL", "HAGGLE_ENV", "INKBOX_API_KEY", "INKBOX_IDENTITY", "@inkbox/sdk", "HAGGLE_EMAIL_TRIAL_MAILBOXES", TRIAL_FLAG, "--to", "--run"]);
    for (const c of problems(bad.checks)) expect(c.fix, c.check).toBeTruthy();
  });

  it("the planned send is exactly the test email with its idempotency key", () => {
    const run = newRun({ to: ME, buyerMailbox: BUYER, now: new Date("2026-10-23T09:00:00Z") });
    const p = plannedSend(run);
    expect(p).toEqual({ from: BUYER, to: [ME], subject: trialEmail(run).subject, bodyText: trialEmail(run).bodyText, idempotencyKey: `email-trial:${run.runId}` });
  });

  it("under plain node: validate and dry-run run with no credentials and write nothing; send without the gate refuses before any network", () => {
    const APP = join(import.meta.dirname, "..");
    const base = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const dir = join(mkdtempSync(join(tmpdir(), "haggle-trial-")), "run");
    const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, ["scripts/email-trial.ts", ...args], { cwd: APP, env: { ...base, ...extra }, encoding: "utf8", timeout: 60_000 });
    const v = run(["validate", "--run", dir, "--to", ME]);
    expect(v.stdout).toMatch(/nothing was contacted/);
    expect(v.status).toBe(1); // no INKBOX_API_KEY, no allowlist
    const d = run(["dry-run", "--to", ME, "--run", dir, "--buyer", BUYER]);
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/DRY RUN: nothing is sent/);
    expect(d.stdout).toMatch(/Subject: \[HAGGLE TEST\]/);
    expect(existsSync(dir)).toBe(false);
    const s = run(send.map((a) => (a === "/tmp/trials/t1" ? dir : a)), { HAGGLE_EMAIL_TRIAL_MAILBOXES: ME });
    expect(s.stderr).toMatch(/email-trial failed: send refused before any network call[\s\S]*BLOCKED HAGGLE_EMAIL_TRIAL /);
    const k = run(send.map((a) => (a === "/tmp/trials/t1" ? dir : a)), { HAGGLE_EMAIL_TRIAL: "1", HAGGLE_EMAIL_TRIAL_MAILBOXES: ME });
    expect(k.stderr).toMatch(/send refused before any network call/);
    expect(k.stderr).toMatch(/BLOCKED INKBOX_API_KEY/);
    expect(existsSync(dir)).toBe(false);
  }, 90_000);
});

describe("captured replies through the real pipeline (dry-run and collect)", () => {
  let byte = 0;
  const sentRun = (): TrialRun => {
    const run = newRun({ to: ME, buyerMailbox: BUYER, now: new Date("2026-10-23T09:00:00Z"), random: (n) => Buffer.alloc(n, ++byte) });
    run.send = { id: "msg_out_1", messageId: "<0100019AbCdEf-1234@email.amazonses.com>", status: "sent", at: "2026-10-23T09:00:01Z", threadId: "thr_1" };
    return run;
  };
  const reply = (run: TrialRun, o: Partial<InkboxMessageDetail> = {}): InkboxMessageDetail => ({
    id: `in_${Math.random().toString(36).slice(2, 8)}`, threadId: "thr_1", messageId: `<CA${Math.random().toString(36).slice(2, 8)}@mail.gmail.com>`, fromAddress: ME, toAddresses: [BUYER], subject: `Re: ${run.subject}`,
    bodyText: `We can do it: $1,150 total.\n\nOn Fri, Oct 23, 2026 at 9:00 AM Haggle <${BUYER}> wrote:\n> ${trialEmail(run).bodyText.split("\n").join("\n> ")}`,
    inReplyTo: run.send!.messageId, references: [run.send!.messageId], attachmentMetadata: null, createdAt: "2026-10-23T09:05:00Z", ...o,
  });

  it("a normal reply becomes a token-verified quote; edited-subject-no-quote, fresh email, forward, and a reply to another id are quarantined", async () => {
    const run = sentRun();
    const caps = [
      reply(run),
      reply(run, { subject: "pricing", bodyText: "$1,150 total" }),
      reply(run, { threadId: "thr_new", inReplyTo: null, references: null, subject: "new note", bodyText: `$1,150 total. ${run.token}` }),
      reply(run, { fromAddress: OTHER }),
      reply(run, { inReplyTo: "<different-id@inkbox.example>", references: ["<different-id@inkbox.example>"], threadId: "thr_9" }),
      reply(run, { attachmentMetadata: [{ filename: "quote.pdf", content_type: "application/pdf", size: 1000 }], bodyText: "Quote attached, $1,150 total" }),
    ];
    const r = await replayCaptures(run, caps);
    // The test email carries [HG-TRIAL] like a real RFQ: a reply naming another Message-ID is matched by the tag and fails the thread check; a fresh email with a new subject matches no deal.
    expect(r.map((x) => x.outcome)).toEqual(["stored", "quarantined:identity_unverified", "quarantined:no_signal", "quarantined:sender_mismatch", "quarantined:identity_unverified", "stored"]);
    expect(r[0]).toMatchObject({ trust_reason: "external-reply-token", quote_total_usd: 1150, approvable: false }); // keyword reader offline: never approvable
    expect(r.slice(1, 3).map((x) => x.quarantine_reason)).toEqual(["identity_unverified:token_missing", "no_signal"]);
    expect(r[4]!.quarantine_reason).toBe("identity_unverified:not_in_our_thread");
    expect(r[5]!.notes).toEqual(["1 attachment(s) not replayed offline"]);

    const evals = caps.map((c) => evaluateReply(c, run, { sendTime: run.send!.messageId, stored: run.send!.messageId, ses: null }));
    const report = buildReport(run, compareMessageIds(run.send!.messageId, run.send!.messageId, null), withPipeline(evals, r), new Date());
    expect(report.replies[0]!.pipeline).toMatchObject({ outcome: "stored", quote_total_usd: 1150 });
    // The pure verdict and the pipeline agree on every reply.
    for (const x of report.replies) expect(x.verdict.startsWith("ok:"), x.id).toBe(x.pipeline!.outcome === "stored");
    expect(renderMarkdown(report)).toMatch(/\| pipeline \|[\s\S]*stored \(external-reply-token\) quote \$1150 \(not approvable\)/);
  });

  it("if the mailbox's Message-ID differs from the send-time one, replies fail in the pipeline exactly as the report warns", async () => {
    const run = sentRun();
    const stored = "<stored-differs@email.amazonses.com>";
    const caps = [reply(run, { inReplyTo: stored, references: [stored], threadId: "thr_other" })];
    const [r] = await replayCaptures(run, caps);
    expect(r).toMatchObject({ outcome: "quarantined:identity_unverified", quarantine_reason: "identity_unverified:not_in_our_thread" });
    expect(compareMessageIds(run.send!.messageId, stored, null).verdict).toMatch(/^MISMATCH/);
  });

  it("dry-run under plain node replays a run directory's captures", () => {
    const APP = join(import.meta.dirname, "..");
    const dir = mkdtempSync(join(tmpdir(), "haggle-trial-"));
    const run = sentRun();
    writeFileSync(join(dir, "run.json"), JSON.stringify(run));
    mkdirSync(join(dir, "raw"));
    writeFileSync(join(dir, "raw", "in_1.json"), JSON.stringify(reply(run, { id: "in_1" })));
    const d = spawnSync(process.execPath, ["scripts/email-trial.ts", "dry-run", "--to", ME, "--run", dir], { cwd: APP, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/in_1\s+stored\s+external-reply-token\s+quote \$1150/);
  }, 90_000);
});
