// Hardening of the operator email trial for its first staging run: it refuses production, matches
// recipients exactly, keeps the run directory private and outside the repository, sends exactly
// once, opens only allowlisted senders' mail and restores its unread state, never prints secrets,
// and refuses every network command before any call when a prerequisite is missing. Fakes only:
// nothing here contacts Inkbox (the flows run against an in-memory mailbox and a temp directory).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InkboxListedMessage, InkboxMessageDetail } from "@haggle/engine";
import { collectRun, sendOnce, type TrialMailbox } from "../scripts/email-trial-io.ts";
import {
  EMPTY_FS, MAX_TRIAL_MAILBOXES, outsideRepo, parseAllowlist, planTrial, problems, scrubSecrets, strictAddress, TRIAL_FLAG, trialChecks, type FsProbe, type TrialRun,
} from "../scripts/email-trial-lib.ts";

const REPO = "/repo/haggle";
const ME = "tester@gmail.example";
const OTHER = "tester2@outlook.example";
const BUYER = "haggle-staging@inkboxmail.test";
const STAGING = { HAGGLE_EMAIL_TRIAL: "1", HAGGLE_EMAIL_TRIAL_MAILBOXES: `${ME},${OTHER}`, HAGGLE_ENV: "staging", INKBOX_API_KEY: "ik_staging_key_value_123", INKBOX_IDENTITY: "haggle-staging" };
const send = (to = ME, run = "/tmp/trials/t1") => ["send", "--to", to, "--run", run, TRIAL_FLAG];
const refused = (argv: string[], env: Record<string, string | undefined>, re: RegExp, fs?: FsProbe) => expect(planTrial(argv, env, REPO, fs ? { fs } : {})).toMatchObject({ ok: false, error: expect.stringMatching(re) });

describe("never against production", () => {
  it("HAGGLE_ENV must be staging for send, collect and check-subscription: production FAILs, unset is BLOCKED", () => {
    for (const argv of [send(), ["check-subscription"]]) {
      refused(argv, { ...STAGING, HAGGLE_ENV: "production" }, /FAIL\s+HAGGLE_ENV\s+production: the email trial never runs against production/);
      refused(argv, { ...STAGING, HAGGLE_ENV: " Production " }, /FAIL\s+HAGGLE_ENV/);
      refused(argv, { ...STAGING, HAGGLE_ENV: undefined }, /BLOCKED HAGGLE_ENV[\s\S]*fix: set HAGGLE_ENV=staging/);
      refused(argv, { ...STAGING, HAGGLE_ENV: "development" }, /FAIL\s+HAGGLE_ENV\s+"development"/);
    }
    expect(planTrial(send(), STAGING, REPO)).toMatchObject({ ok: true });
  });

  it("the production buyer identity is refused, and the identity must be set explicitly (no default)", () => {
    refused(send(), { ...STAGING, INKBOX_IDENTITY: undefined }, /BLOCKED INKBOX_IDENTITY\s+not set: the default handle "haggle" is the production buyer/);
    refused(send(), { ...STAGING, INKBOX_IDENTITY: "haggle" }, /FAIL\s+INKBOX_IDENTITY\s+"haggle" is the production buyer identity/);
    refused(send(), { ...STAGING, INKBOX_IDENTITY: "HAGGLE" }, /production buyer identity/);
    refused(["check-subscription"], { ...STAGING, INKBOX_IDENTITY: "haggle" }, /production buyer identity/);
    refused(send(), { ...STAGING, INKBOX_IDENTITY: "bad handle!" }, /FAIL\s+INKBOX_IDENTITY\s+not an Inkbox handle/);
  });
});

describe("recipients: exact allowlist matches only", () => {
  it("normalizes case and surrounding whitespace, nothing else", () => {
    expect(planTrial(send("  TESTER@Gmail.Example "), STAGING, REPO)).toMatchObject({ ok: true, cmd: { to: "tester@gmail.example" } });
    expect(strictAddress(" Tester@Gmail.Example ")).toBe(ME);
  });
  it("no plus-address, dot, look-alike, display-name, list or trailing-dot bypass", () => {
    for (const to of ["tester+x@gmail.example", "tes.ter@gmail.example", "tеster@gmail.example" /* Cyrillic е */, "Tester <tester@gmail.example>", `${ME},evil@attacker.example`, `${ME} evil@attacker.example`, `${ME}.`, "tester@gmail.example.attacker.example", "tester@gmail..example"]) {
      expect(planTrial(send(to), STAGING, REPO), to).toMatchObject({ ok: false, error: expect.stringMatching(/--to/) });
    }
  });
  it("a look-alike or malformed allowlist entry FAILs the whole allowlist (no silent skipping)", () => {
    expect(parseAllowlist({ HAGGLE_EMAIL_TRIAL_MAILBOXES: `${ME}, tеster@gmail.example` })).toMatchObject({ allowed: [ME], rejected: ["tеster@gmail.example"] });
    refused(send(), { ...STAGING, HAGGLE_EMAIL_TRIAL_MAILBOXES: `${ME}, Me <x@y.example>` }, /FAIL\s+HAGGLE_EMAIL_TRIAL_MAILBOXES\s+1 entry is not one plain ASCII address/);
  });
  it(`at most ${MAX_TRIAL_MAILBOXES} mailboxes; --to given twice is refused`, () => {
    const many = Array.from({ length: MAX_TRIAL_MAILBOXES + 1 }, (_, i) => `t${i}@gmail.example`).join(",");
    refused(send("t0@gmail.example"), { ...STAGING, HAGGLE_EMAIL_TRIAL_MAILBOXES: many }, /at most 5/);
    refused([...send(), "--to", OTHER], STAGING, /--to is given twice/);
  });
});

describe("run directory: outside the repository and private", () => {
  it("a symlink outside the repository that points into it is refused (realpath)", () => {
    const fs: FsProbe = { ...EMPTY_FS, realpath: (p) => (p === "/tmp/link" ? `${REPO}/captures` : p === REPO ? REPO : null) };
    expect(outsideRepo("/tmp/link/t1", REPO, fs)).toBe(false);
    refused(send(ME, "/tmp/link/t1"), STAGING, /FAIL\s+--run\s+inside the repository \(directly or through a symlink\)/, fs);
    expect(outsideRepo("/tmp/elsewhere/t1", REPO, fs)).toBe(true);
  });
  it("an existing directory others can read, or a world-readable run.json, is refused with the chmod fix", () => {
    const loose: FsProbe = { ...EMPTY_FS, exists: (p) => p === "/tmp/t", mode: () => 0o755 };
    refused(send(ME, "/tmp/t"), STAGING, /FAIL\s+--run\s+exists with mode 0755[\s\S]*fix: chmod 700 \/tmp\/t/, loose);
    const run = { runId: "r", token: "HGR-AAAAAAAAAA", secret: "s".repeat(64), to: ME, send: { id: "o", messageId: "<m@x>", status: "sent", at: "now" } };
    const leaky: FsProbe = { ...EMPTY_FS, exists: (p) => p === "/tmp/t" || p === "/tmp/t/run.json", mode: (p) => (p.endsWith("run.json") ? 0o644 : 0o700), read: () => JSON.stringify(run) };
    refused(["collect", "--run", "/tmp/t", TRIAL_FLAG], STAGING, /FAIL\s+run\.json\s+mode 0644[\s\S]*chmod 600/, leaky);
  });
  it("send refuses a directory that already holds a run; collect needs one, recorded for a still-allowlisted recipient", () => {
    const withRun = (run: object): FsProbe => ({ ...EMPTY_FS, exists: (p) => p === "/tmp/t" || p === "/tmp/t/run.json", mode: () => 0o700, read: () => JSON.stringify(run) });
    const run = { runId: "r", token: "HGR-AAAAAAAAAA", secret: "s".repeat(64), to: ME, send: { id: "o", messageId: "<m@x>", status: "sent", at: "now" } };
    refused(send(ME, "/tmp/t"), STAGING, /FAIL\s+run state\s+this directory already holds a run/, withRun(run));
    refused(["collect", "--run", "/tmp/t", TRIAL_FLAG], STAGING, /BLOCKED run state\s+no run\.json here/, { ...EMPTY_FS, exists: (p) => p === "/tmp/t", mode: () => 0o700 });
    refused(["collect", "--run", "/tmp/t", TRIAL_FLAG], { ...STAGING, HAGGLE_EMAIL_TRIAL_MAILBOXES: OTHER }, /FAIL\s+run state\s+the run's recipient t\*\*\*@gmail\.example is no longer/, withRun(run));
    expect(planTrial(["collect", "--run", "/tmp/t", TRIAL_FLAG], STAGING, REPO, { fs: withRun(run) })).toMatchObject({ ok: true });
    // A send that was started but not confirmed: collect may run (it recovers the send).
    expect(planTrial(["collect", "--run", "/tmp/t", TRIAL_FLAG], STAGING, REPO, { fs: withRun({ ...run, send: undefined, sendState: "pending" }) })).toMatchObject({ ok: true });
  });
});

describe("every network command refuses before any call when a prerequisite is missing", () => {
  const cases: [string, Record<string, string | undefined>, string][] = [
    ["HAGGLE_EMAIL_TRIAL", { HAGGLE_EMAIL_TRIAL: undefined }, "BLOCKED"],
    ["HAGGLE_ENV", { HAGGLE_ENV: undefined }, "BLOCKED"],
    ["INKBOX_API_KEY", { INKBOX_API_KEY: "  " }, "BLOCKED"],
    ["INKBOX_IDENTITY", { INKBOX_IDENTITY: undefined }, "BLOCKED"],
    ["HAGGLE_EMAIL_TRIAL_MAILBOXES", { HAGGLE_EMAIL_TRIAL_MAILBOXES: undefined }, "BLOCKED"],
  ];
  for (const [name, patch, status] of cases) {
    it(`${name} missing: ${status} with a fix naming what to set`, () => {
      const c = trialChecks("send", { runDir: "/tmp/t", to: ME }, { ...STAGING, ...patch }, send(), REPO, EMPTY_FS, "0.7.19").find((x) => x.check === name)!;
      expect(c).toMatchObject({ status, fix: expect.any(String) });
      if (name.startsWith("HAGGLE_") || name.startsWith("INKBOX_")) expect(c.fix).toContain(name);
      refused(send(ME, "/tmp/t"), { ...STAGING, ...patch }, new RegExp(`${status}\\s+${name}`));
    });
  }
  it("the SDK not installed, the ownership flag and the run directory missing are BLOCKED too", () => {
    const checks = trialChecks("send", { runDir: null, to: ME }, STAGING, [], REPO, EMPTY_FS, null);
    expect(problems(checks).map((c) => `${c.status} ${c.check}`)).toEqual(["BLOCKED @inkbox/sdk", `BLOCKED ${TRIAL_FLAG}`, "BLOCKED --run"]);
    expect(planTrial(send(), STAGING, REPO, { sdk: null })).toMatchObject({ ok: false, error: expect.stringMatching(/BLOCKED @inkbox\/sdk[\s\S]*fix: run npm install/) });
  });
  it("INKBOX_WEBHOOK_SECRET is reported (set or not, never its value) and refuses nothing", () => {
    const c = trialChecks("send", { runDir: "/tmp/t", to: ME }, { ...STAGING, INKBOX_WEBHOOK_SECRET: "whsec_SHOULD_NOT_APPEAR" }, send(), REPO, EMPTY_FS, "0.7.19");
    expect(c.find((x) => x.check === "INKBOX_WEBHOOK_SECRET")).toMatchObject({ status: "info", detail: expect.stringMatching(/^set \(value not shown\)/) });
    expect(JSON.stringify(c)).not.toContain("SHOULD_NOT_APPEAR");
    expect(JSON.stringify(c)).not.toContain(STAGING.INKBOX_API_KEY);
  });
  it("under plain node, send and collect with a production env print the refusal and create nothing", () => {
    const APP = join(import.meta.dirname, "..");
    const dir = join(mkdtempSync(join(tmpdir(), "haggle-trial-")), "run");
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...STAGING, HAGGLE_ENV: "production", INKBOX_IDENTITY: "haggle" };
    for (const args of [send(ME, dir), ["collect", "--run", dir, TRIAL_FLAG]]) {
      const r = spawnSync(process.execPath, ["scripts/email-trial.ts", ...args], { cwd: APP, env, encoding: "utf8", timeout: 60_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refused before any network call[\s\S]*FAIL\s+HAGGLE_ENV[\s\S]*FAIL\s+INKBOX_IDENTITY/);
      expect(r.stderr + r.stdout).not.toContain(STAGING.INKBOX_API_KEY);
    }
    expect(existsSync(dir)).toBe(false);
  }, 90_000);
});

describe("secrets never reach output", () => {
  it("scrubSecrets masks every secret value (short values ignored, so ordinary words aren't mangled)", () => {
    expect(scrubSecrets("401 for key ik_live_ABCDEFGH1234 and whsec_xyz98765432", ["ik_live_ABCDEFGH1234", "whsec_xyz98765432", "abc", undefined])).toBe("401 for key <redacted> and <redacted>");
  });
  it("validate under plain node never prints the API key", () => {
    const APP = join(import.meta.dirname, "..");
    const r = spawnSync(process.execPath, ["scripts/email-trial.ts", "validate", "--to", ME], { cwd: APP, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...STAGING }, encoding: "utf8", timeout: 60_000 });
    expect(r.stdout).toMatch(/INKBOX_API_KEY\s+set \(value not shown\)/);
    expect(r.stdout + r.stderr).not.toContain(STAGING.INKBOX_API_KEY);
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------
// The flows against an in-memory mailbox.
// ---------------------------------------------------------------------------------------------

type Listed = InkboxListedMessage & { isRead?: boolean };
class FakeMailbox implements TrialMailbox {
  buyerMailbox = BUYER;
  identityId = "id_staging";
  sends: { to: string[]; idempotencyKey: string }[] = [];
  gets: string[] = [];
  unread: string[] = [];
  failSend: Error | null = null;
  outbound: Listed[] = [];
  inbound: (Listed & { detail: InkboxMessageDetail })[] = [];
  async send(o: { to: string[]; subject: string; bodyText: string; idempotencyKey: string }) {
    this.sends.push(o);
    if (this.failSend) throw this.failSend;
    this.outbound.push({ id: "out_1", messageId: "<0100019a-send@email.amazonses.com>", direction: "outbound", subject: o.subject, status: "sent" });
    return { id: "out_1", messageId: "<0100019a-send@email.amazonses.com>", status: "sent", threadId: "thr_1" };
  }
  async *list(o: { direction: "inbound" | "outbound" }) {
    for (const m of o.direction === "outbound" ? this.outbound : this.inbound) yield m;
  }
  async get(id: string): Promise<InkboxMessageDetail> {
    this.gets.push(id);
    const m = this.inbound.find((x) => x.id === id);
    if (m) return m.detail;
    const out = this.outbound.find((x) => x.id === id)!;
    return { id, threadId: "thr_1", messageId: out.messageId, fromAddress: BUYER, toAddresses: [ME], subject: out.subject ?? null, bodyText: null, inReplyTo: null, references: null, attachmentMetadata: null, sesMessageId: "0100019a-send" } as InkboxMessageDetail;
  }
  async markUnread(id: string) { this.unread.push(id); }
  async listSubscriptions() { return [{ id: "sub_1", url: "https://staging.example/webhooks/inkbox", eventTypes: ["message.received"], agentIdentityId: "id_staging" }]; }
  reply(id: string, from: string, run: TrialRun, isRead?: boolean, o: Partial<InkboxMessageDetail> = {}) {
    const detail = { id, threadId: "thr_1", messageId: `<${id}@mail.gmail.com>`, fromAddress: from, toAddresses: [BUYER], subject: `Re: ${run.subject}`, bodyText: "We can do it: $1,150 total, $345 deposit.", inReplyTo: run.send!.messageId, references: [run.send!.messageId], attachmentMetadata: null, ...o } as InkboxMessageDetail;
    this.inbound.push({ id, messageId: detail.messageId, direction: "inbound", fromAddress: from, isRead, detail });
  }
}
const mode = (p: string) => statSync(p).mode & 0o777;

describe("send is one-shot", () => {
  it("records the run (0600, in a 0700 directory) and refuses a second send into the same directory without calling Inkbox", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "haggle-trial-")), "run");
    const ink = new FakeMailbox();
    const run = await sendOnce(ink, { to: ME, runDir: dir });
    expect(ink.sends).toHaveLength(1);
    expect(ink.sends[0]).toMatchObject({ to: [ME], idempotencyKey: `email-trial:${run.runId}` });
    expect(run).toMatchObject({ sendState: "sent", send: { id: "out_1", messageId: "<0100019a-send@email.amazonses.com>" } });
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "run.json"))).toBe(0o600);
    await expect(sendOnce(ink, { to: ME, runDir: dir })).rejects.toThrow(/already exists: this directory holds a run, so nothing was sent/);
    expect(ink.sends).toHaveLength(1);
  });
  it("a crash between claiming the directory and sending leaves a pending run that refuses a resend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haggle-trial-"));
    writeFileSync(join(dir, "run.json"), JSON.stringify({ sendState: "pending" }), { mode: 0o600 });
    const ink = new FakeMailbox();
    await expect(sendOnce(ink, { to: ME, runDir: dir })).rejects.toThrow(/already exists/);
    expect(ink.sends).toHaveLength(0);
  });
  it("a failed send is recorded (scrubbed), refuses a resend, and collect recovers the email if it did go out", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "haggle-trial-")), "run");
    const ink = new FakeMailbox();
    ink.failSend = new Error("timeout talking to api with key ik_staging_key_value_123");
    await expect(sendOnce(ink, { to: ME, runDir: dir, scrub: (s) => scrubSecrets(s, [STAGING.INKBOX_API_KEY]) })).rejects.toThrow(/may or may not have gone out[\s\S]*run collect/);
    const saved = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as TrialRun;
    expect(saved).toMatchObject({ sendState: "failed", sendError: expect.stringContaining("<redacted>") });
    expect(saved.sendError).not.toContain(STAGING.INKBOX_API_KEY);
    await expect(sendOnce(ink, { to: ME, runDir: dir })).rejects.toThrow(/already exists/);
    // It went out after all (the provider timed out after accepting it): collect finds it by subject.
    ink.outbound.push({ id: "out_9", messageId: "<stored-9@email.amazonses.com>", direction: "outbound", subject: saved.subject, status: "sent" });
    const r = await collectRun(ink, { runDir: dir, allowed: [ME], includeBounces: false });
    expect(r.warnings.join(" ")).toMatch(/found in the outbound mailbox/);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toMatchObject({ sendState: "sent", send: { id: "out_9", recovered: true } });
    expect(r.report.run.send_recovered).toBe(true);
  });
  it("refuses the buyer mailbox itself as the recipient", async () => {
    await expect(sendOnce(new FakeMailbox(), { to: BUYER, runDir: join(mkdtempSync(join(tmpdir(), "haggle-trial-")), "r") })).rejects.toThrow(/buyer mailbox itself/);
  });
});

describe("collect reads only allowlisted senders and restores unread state", () => {
  it("opens only mail from the allowlist (bounces only with --include-bounces), restores unread, writes private files with no secrets", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "haggle-trial-")), "run");
    const ink = new FakeMailbox();
    const run = await sendOnce(ink, { to: ME, runDir: dir });
    ink.reply("in_unread", ME, run, false);
    ink.reply("in_read", ME, run, true);
    ink.reply("in_unknown", ME.toUpperCase(), run, undefined);
    ink.reply("in_vendor", "real.vendor@business.example", run, false);
    ink.reply("in_plus", "tester+x@gmail.example", run, false);
    ink.reply("in_dsn", "mailer-daemon@googlemail.com", run, false, { subject: "Delivery Status Notification (Failure)", bodyText: "550 5.1.1" });
    const r = await collectRun(ink, { runDir: dir, allowed: [ME, OTHER], includeBounces: false });
    expect(ink.gets.filter((g) => g.startsWith("in_")).sort()).toEqual(["in_read", "in_unknown", "in_unread"]);
    expect(ink.unread.sort()).toEqual(["in_unknown", "in_unread"]); // a message that was already read stays read
    expect(r.skipped).toEqual({ not_allowlisted: 2, bounces: 1 });
    expect(r.report.replies.map((x) => x.webhook.read_before_collect).sort()).toEqual(["read", "unknown", "unread"]);
    for (const f of ["report.json", "report.md", "raw/in_unread.json"]) expect(mode(join(dir, f)), f).toBe(0o600);
    expect(mode(join(dir, "raw"))).toBe(0o700);
    const shared = readFileSync(join(dir, "report.md"), "utf8") + readFileSync(join(dir, "report.json"), "utf8");
    for (const secret of [run.token, run.secret, ME]) expect(shared).not.toContain(secret);
    const withBounces = await collectRun(ink, { runDir: dir, allowed: [ME, OTHER], includeBounces: true });
    expect(withBounces.skipped).toEqual({ not_allowlisted: 2, bounces: 0 });
    expect(ink.gets).toContain("in_dsn");
  });
  it("refuses a run whose recipient was removed from the allowlist, before opening anything", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "haggle-trial-")), "run");
    const ink = new FakeMailbox();
    const run = await sendOnce(ink, { to: ME, runDir: dir });
    ink.reply("in_1", ME, run, false);
    await expect(collectRun(ink, { runDir: dir, allowed: [OTHER], includeBounces: false })).rejects.toThrow(/no longer in HAGGLE_EMAIL_TRIAL_MAILBOXES/);
    expect(ink.gets).toEqual([]);
  });
});

it("mkdirSync-created run directories inside an existing loose parent are still 0700", async () => {
  const parent = mkdtempSync(join(tmpdir(), "haggle-trial-"));
  mkdirSync(join(parent, "loose"), { mode: 0o777 });
  const dir = join(parent, "loose", "run");
  await sendOnce(new FakeMailbox(), { to: ME, runDir: dir });
  expect(mode(dir)).toBe(0o700);
});
