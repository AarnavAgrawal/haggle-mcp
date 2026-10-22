// scripts/email-trial-lib.ts: the operator email trial's gate, test email, reply evaluation through
// the engine's real inbound functions, redaction and report. Fakes only; the script itself is never
// run here (it would send real mail).
import { describe, expect, it } from "vitest";
import type { InkboxMessageDetail } from "@haggle/engine";
import {
  buildReport, checkSubscriptions, compareMessageIds, evaluateReply, newRun, planTrial, redact, redactUrl, renderMarkdown, SCENARIOS, TRIAL_FLAG, trialEmail, type TrialRun,
} from "../scripts/email-trial-lib.ts";

const REPO = "/repo/haggle";
const ME = "tester@gmail.example";
const OTHER = "tester2@outlook.example";
const BUYER = "haggle@inkboxmail.test";
const env = { HAGGLE_EMAIL_TRIAL: "1", HAGGLE_EMAIL_TRIAL_MAILBOXES: `${ME}, ${OTHER.toUpperCase()}` };

describe("planTrial: disabled unless every gate is passed", () => {
  const send = ["send", "--to", ME, "--run", "/tmp/trials/t1", TRIAL_FLAG];
  it("needs HAGGLE_EMAIL_TRIAL=1 for anything, even the read-only subscription check", () => {
    expect(planTrial(send, { ...env, HAGGLE_EMAIL_TRIAL: undefined }, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(/disabled/) });
    expect(planTrial(["check-subscription"], {}, REPO)).toMatchObject({ ok: false });
    expect(planTrial(["check-subscription"], { HAGGLE_EMAIL_TRIAL: "1" }, REPO)).toEqual({ ok: true, cmd: { kind: "check-subscription" } });
  });
  it("send and collect need the ownership flag, a listed mailbox, and a run directory outside the repository", () => {
    expect(planTrial(send.filter((a) => a !== TRIAL_FLAG), env, REPO)).toMatchObject({ ok: false, error: expect.stringContaining(TRIAL_FLAG) });
    expect(planTrial(["send", "--to", "stranger@example.com", "--run", "/tmp/t", TRIAL_FLAG], env, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(/not in HAGGLE_EMAIL_TRIAL_MAILBOXES/) });
    expect(planTrial(send, { ...env, HAGGLE_EMAIL_TRIAL_MAILBOXES: "" }, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    expect(planTrial(["send", "--to", ME, "--run", `${REPO}/tmp/t1`, TRIAL_FLAG], env, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(/outside the repository/) });
    expect(planTrial(["collect", "--run", REPO, TRIAL_FLAG], env, REPO)).toMatchObject({ ok: false });
    expect(planTrial(["collect", TRIAL_FLAG], env, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(/--run/) });
    expect(planTrial(["delete-everything"], env, REPO)).toMatchObject({ ok: false, error: expect.stringMatching(/usage/) });
  });
  it("accepts a fully gated send and collect (addresses compared case-insensitively)", () => {
    expect(planTrial(send, env, REPO)).toEqual({ ok: true, cmd: { kind: "send", to: ME, runDir: "/tmp/trials/t1" } });
    expect(planTrial(["send", "--to", OTHER, "--run", "/tmp/t2", TRIAL_FLAG], env, REPO)).toMatchObject({ ok: true });
    expect(planTrial(["collect", "--run", "/tmp/trials/t1", TRIAL_FLAG], env, REPO)).toEqual({ ok: true, cmd: { kind: "collect", runDir: "/tmp/trials/t1" } });
  });
});

let byte = 0;
const fakeRandom = (n: number) => Buffer.alloc(n, ++byte);
function sentRun(): TrialRun {
  const run = newRun({ to: ME, buyerMailbox: BUYER.toUpperCase(), now: new Date("2026-10-23T09:00:00Z"), random: fakeRandom });
  run.send = { id: "msg_out_1", messageId: "<0100019AbCdEf-1234@email.amazonses.com>", status: "sent", at: "2026-10-23T09:00:01Z", threadId: "thr_1" };
  return run;
}
const reply = (run: TrialRun, o: Partial<InkboxMessageDetail> = {}): InkboxMessageDetail => ({
  id: `in_${Math.random().toString(36).slice(2, 8)}`, threadId: "thr_1", messageId: "<CA+abc@mail.gmail.com>", fromAddress: ME, toAddresses: [BUYER], subject: `Re: ${run.subject}`,
  bodyText: `We can do it: $1,150 total.\n\nOn Fri, Oct 23, 2026 at 9:00 AM Haggle <${BUYER}> wrote:\n> ${trialEmail(run).bodyText.split("\n").join("\n> ")}`,
  inReplyTo: run.send!.messageId, references: [run.send!.messageId], attachmentMetadata: null, createdAt: "2026-10-23T09:05:00Z", ...o,
});
const ids = (run: TrialRun, stored = run.send!.messageId) => ({ sendTime: run.send!.messageId, stored, ses: "0100019AbCdEf-1234" });

describe("the test email", () => {
  it("is labelled TEST, carries a token from a run-local secret, and lists every scenario", () => {
    const run = sentRun();
    const mail = trialEmail(run);
    expect(mail.subject).toMatch(/^\[HAGGLE TEST\]/);
    expect(mail.subject).toContain(run.token);
    expect(mail.bodyText).toMatch(/THIS IS A TEST/);
    expect(mail.bodyText).toContain(run.token);
    for (const s of SCENARIOS) expect(mail.bodyText).toContain(s);
    expect(run.buyerMailbox).toBe(BUYER);
    expect(run.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(newRun({ to: ME, buyerMailbox: BUYER, now: new Date() }).secret).not.toBe(newRun({ to: ME, buyerMailbox: BUYER, now: new Date() }).secret);
  });
});

describe("evaluateReply runs captured mail through the engine's inbound functions", () => {
  it("a normal Gmail reply verifies, its quoted history is cut, and the token is seen", () => {
    const run = sentRun();
    const e = evaluateReply(reply(run), run, ids(run));
    expect(e).toMatchObject({ verdict: "ok:external-reply-token", match: "business:thread", token_in_subject: true, token_in_body: true, token_in_own_words: false, in_reply_to_ours: true, quoted_history_cut: true, own_words_preview: "We can do it: $1,150 total.", body_source: "text", opt_out: false, bounce: false });
  });
  it("edited subject + quote deleted is token_missing; a fresh email is not_in_our_thread; a forward from another address is from_mismatch", () => {
    const run = sentRun();
    expect(evaluateReply(reply(run, { subject: "Quote", bodyText: "$1,150 total." }), run, ids(run)).verdict).toBe("identity_unverified:token_missing");
    expect(evaluateReply(reply(run, { inReplyTo: null, references: null, threadId: "thr_new", subject: `Quote ${run.token}` }), run, ids(run)).verdict).toBe("identity_unverified:not_in_our_thread");
    const fwd = evaluateReply(reply(run, { fromAddress: OTHER, subject: `Fwd: ${run.subject}` }), run, ids(run));
    expect(fwd.verdict).toBe("identity_unverified:from_mismatch");
    expect(fwd.match).toBe("quarantine:sender_mismatch");
  });
  it("a token only in quoted text is noted; an HTML-only reply is read from its HTML", () => {
    const run = sentRun();
    const quotedOnly = evaluateReply(reply(run, { subject: "Re: catering" }), run, ids(run));
    expect(quotedOnly.verdict).toBe("ok:external-reply-token");
    expect(quotedOnly.notes).toContain("token only in quoted text");
    const html = evaluateReply(reply(run, { bodyText: null, bodyHtml: `<div>$1,150 total</div><blockquote>${run.token}</blockquote>` }), run, ids(run));
    expect(html).toMatchObject({ body_source: "html", verdict: "ok:external-reply-token", own_words_preview: "$1,150 total" });
  });
  it("if the stored Message-ID differs from the send-time one, the report shows replies failing only because of it", () => {
    const run = sentRun();
    const stored = "<0100019AfinalSES@email.amazonses.com>";
    const e = evaluateReply(reply(run, { inReplyTo: stored, references: [stored] }), run, ids(run, stored));
    expect(e.verdict).toBe("identity_unverified:not_in_our_thread");
    expect(e.verdict_any_known_id).toBe("ok:external-reply-token");
    expect(compareMessageIds(run.send!.messageId, stored, null)).toMatchObject({ send_time_equals_stored: false, verdict: expect.stringMatching(/^MISMATCH/) });
    expect(compareMessageIds(run.send!.messageId, run.send!.messageId.toLowerCase(), null)).toMatchObject({ send_time_equals_stored: true, verdict: expect.stringMatching(/^OK/) });
  });
  it("recognises a DSN bounce and an opt-out", () => {
    const run = sentRun();
    expect(evaluateReply(reply(run, { fromAddress: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", bodyText: `550 5.1.1 user unknown ${run.send!.messageId}` }), run, ids(run)).bounce).toBe(true);
    expect(evaluateReply(reply(run, { bodyText: "Unsubscribe" }), run, ids(run)).opt_out).toBe(true);
  });
});

describe("report redaction", () => {
  it("masks addresses, phone numbers and the token; keeps the verdicts", () => {
    const run = sentRun();
    expect(redact(`From ${ME} call +1 (415) 555-0101 ref ${run.token} key ${run.secret}`, run)).toBe("From t***@gmail.example call <number> ref HGR-<token> key <secret>");
    const report = buildReport(run, compareMessageIds(run.send!.messageId, run.send!.messageId, null), [evaluateReply(reply(run), run, ids(run))], new Date("2026-10-23T10:00:00Z"));
    const json = JSON.stringify(report);
    expect(json).not.toContain(ME);
    expect(json).not.toContain(run.token);
    expect(json).not.toContain(run.secret);
    expect(report.summary).toMatchObject({ replies: 1, verified: 1 });
    const md = renderMarkdown(report);
    expect(md).toContain("ok:external-reply-token");
    expect(md).not.toContain(ME);
    expect(md).toContain("- [ ] Normal reply");
  });
});

describe("check-subscription (read-only)", () => {
  it("reports missing message.bounced / message.failed on the buyer's subscription", () => {
    const r = checkSubscriptions([
      { id: "sub_1", url: "https://haggle.example/webhooks/inkbox/s3cr3t", eventTypes: ["message.received", "call.ended", "imessage.received"], status: "active", agentIdentityId: "id_buyer" },
      { id: "sub_2", url: "https://other.example/hook", eventTypes: ["message.received", "message.bounced", "message.failed"], agentIdentityId: "id_seller" },
    ], "id_buyer");
    expect(r.ok).toBe(false);
    expect(r.subscriptions).toEqual([expect.objectContaining({ id: "sub_1", missing_required: ["message.bounced", "message.failed"], url: "https://haggle.example/webhooks/…" })]);
    expect(r.advice).toMatch(/message\.bounced, message\.failed/);
    expect(checkSubscriptions([{ id: "s", url: "https://x.example/a", eventTypes: ["message.received", "message.bounced", "message.failed"], agentIdentityId: "id_buyer" }], "id_buyer").ok).toBe(true);
    expect(redactUrl("not a url")).toBe("<invalid url>");
  });
});
