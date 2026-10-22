// The email trial's per-reply diagnostics and overall verdict, on replies shaped like the real
// clients': Gmail (keeps In-Reply-To and References, "On … wrote:" with '>' quotes), Outlook
// ("RE:" subject, In-Reply-To but often no References, a "____" separator and an unquoted
// From/Sent/To/Subject block), iOS Mail ("Sent from my iPhone", "> On …, at …, X wrote:").
// Offline only: the engine's pure functions and the in-memory pipeline replay.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InkboxMessageDetail } from "@haggle/engine";
import {
  buildReport, compareMessageIds, diagnoseWebhook, evaluateReply, KEYWORD_READER, newRun, overallVerdict, renderMarkdown, trialEmail, withPipeline, type TrialRun,
} from "../scripts/email-trial-lib.ts";
import { replayCaptures } from "../scripts/email-trial-replay.ts";

const GMAIL = "tester@gmail.example";
const OUTLOOK = "tester2@outlook.example";
const BUYER = "haggle-staging@inkboxmail.test";
const SEND_ID = "<0100019a2b3c4d5e-11112222-3333-4444-5555-666677778888-000000@email.amazonses.com>";

let byte = 0;
function sentRun(to = GMAIL, messageId = SEND_ID): TrialRun {
  const run = newRun({ to, buyerMailbox: BUYER, now: new Date("2026-10-23T09:00:00Z"), random: (n) => Buffer.alloc(n, ++byte) });
  run.send = { id: "msg_out_1", messageId, status: "sent", at: "2026-10-23T09:00:01Z", threadId: "thr_1" };
  return run;
}
const quoted = (run: TrialRun, prefix = "> ") => trialEmail(run).bodyText.split("\n").map((l) => `${prefix}${l}`.trimEnd()).join("\n");
let n = 0;
const base = (run: TrialRun, from: string, o: Partial<InkboxMessageDetail>): InkboxMessageDetail => ({
  id: `in_${++n}`, threadId: "thr_1", messageId: `<m${n}@client.example>`, fromAddress: from, toAddresses: [BUYER], subject: `Re: ${run.subject}`, bodyText: "", inReplyTo: null, references: null, attachmentMetadata: null, createdAt: "2026-10-23T09:05:00Z", ...o,
});

/** Gmail web/app: In-Reply-To + References, "On … wrote:" then '>' quotes. */
const gmail = (run: TrialRun, o: Partial<InkboxMessageDetail> = {}) => base(run, GMAIL, {
  messageId: `<CAH8x+${n}q=abc@mail.gmail.com>`, inReplyTo: run.send!.messageId, references: [run.send!.messageId],
  bodyText: `We can do it: $1,150 total, delivered. $345 deposit.\n\nOn Fri, Oct 23, 2026 at 9:00 AM <${BUYER}> wrote:\n\n${quoted(run)}\n`, ...o,
});
/** Outlook (web/desktop): "RE:", In-Reply-To only (References dropped), unquoted header block after a "____" separator. */
const outlook = (run: TrialRun, o: Partial<InkboxMessageDetail> = {}) => base(run, OUTLOOK, {
  messageId: `<PH7PR11MB${n}ABCD@PH7PR11MB1234.namprd11.prod.outlook.com>`, subject: `RE: ${run.subject}`, inReplyTo: run.send!.messageId, references: null,
  bodyText: `Sure: $1,150 total and a $345 deposit.\n\n________________________________\nFrom: Haggle <${BUYER}>\nSent: Friday, October 23, 2026 9:00 AM\nTo: ${OUTLOOK}\nSubject: ${run.subject}\n\n${trialEmail(run).bodyText}\n`, ...o,
});
/** iOS Mail: signature line, then "> On …, at …, X wrote:" and '>' quotes. */
const ios = (run: TrialRun, o: Partial<InkboxMessageDetail> = {}) => base(run, GMAIL, {
  messageId: `<9F1C${n}E2A-1B2C-4D5E-8F90-ABCDEF012345@gmail.example>`, inReplyTo: run.send!.messageId, references: [run.send!.messageId],
  bodyText: `$1,150 total, $345 deposit\n\nSent from my iPhone\n\n> On Oct 23, 2026, at 9:00 AM, Haggle <${BUYER}> wrote:\n> \n${quoted(run)}\n`, ...o,
});
const idsOf = (run: TrialRun, stored: string | null = run.send!.messageId, ses: string | null = null) => ({ sendTime: run.send!.messageId, stored, ses });

describe("(a) Message-ID chain", () => {
  it("Gmail names the send-time id in In-Reply-To and References; Outlook only in In-Reply-To; both say the recorded id works", () => {
    const run = sentRun();
    const g = evaluateReply(gmail(run), run, idsOf(run, run.send!.messageId, "0100019a2b3c4d5e-11112222-3333-4444-5555-666677778888-000000"));
    expect(g.message_id_chain).toMatchObject({ send_time: { in_reply_to: true, references: true }, ses: { in_reply_to: true, references: true }, record: "send_time", verdict: expect.stringMatching(/send-time id is referenced \(In-Reply-To \+ References\)/) });
    const runO = sentRun(OUTLOOK);
    const o = evaluateReply(outlook(runO), runO, idsOf(runO));
    expect(o.message_id_chain).toMatchObject({ references: [], send_time: { in_reply_to: true, references: false }, record: "send_time", verdict: expect.stringMatching(/\(In-Reply-To\)/) });
  });
  it("a reply naming only the stored or only the SES id says which one the engine must record", () => {
    const run = sentRun(GMAIL, "<a1b2c3@inkboxmail.test>"); // what send() returned
    const stored = "<0100019aStored-0000@email.amazonses.com>";
    const viaStored = evaluateReply(gmail(run, { inReplyTo: stored, references: [stored] }), run, idsOf(run, stored, "0100019aStored-0000"));
    expect(viaStored.message_id_chain).toMatchObject({ send_time: { in_reply_to: false, references: false }, record: "stored", verdict: expect.stringMatching(/engine must record the stored id/) });
    expect(viaStored.verdict).toBe("identity_unverified:not_in_our_thread");
    expect(viaStored.verdict_any_known_id).toBe("ok:external-reply-token");
    // The mailbox stores what send() returned, but SES rewrote the header recipients saw (region domain differs too).
    const ses = "<0100019aSesOnly-0000@us-west-2.amazonses.com>";
    const viaSes = evaluateReply(gmail(run, { inReplyTo: ses, references: [ses] }), run, idsOf(run, run.send!.messageId, "0100019aSesOnly-0000"));
    expect(viaSes.message_id_chain).toMatchObject({ record: "ses", verdict: expect.stringMatching(/must record the SES Message-ID/) });
    expect(viaSes.verdict_any_known_id).toBe("ok:external-reply-token");
  });
  it("no headers at all, or only foreign ids, is said plainly", () => {
    const run = sentRun();
    expect(evaluateReply(gmail(run, { inReplyTo: null, references: null }), run, idsOf(run)).message_id_chain).toMatchObject({ record: "none", verdict: expect.stringMatching(/no In-Reply-To and no References/) });
    expect(evaluateReply(gmail(run, { inReplyTo: "<x@y.example>", references: ["<x@y.example>"] }), run, idsOf(run)).message_id_chain.verdict).toMatch(/name 2 id\(s\), none of them Haggle's/);
  });
});

describe("(b) reply-token survival and how the engine would match", () => {
  it("Gmail, Outlook and iOS keep it in the subject and the quoted text; each matches by header + token", () => {
    const run = sentRun();
    const runO = sentRun(OUTLOOK);
    for (const [e, client] of [[evaluateReply(gmail(run), run, idsOf(run)), "gmail"], [evaluateReply(outlook(runO), runO, idsOf(runO)), "outlook"], [evaluateReply(ios(run), run, idsOf(run)), "ios"]] as const) {
      expect(e.token, client).toEqual({ where: ["subject", "quoted text"], summary: "subject + quoted text", engine_sees_it: true });
      expect(e.engine.match_by, client).toBe("header+token");
      expect(e.verdict, client).toBe("ok:external-reply-token");
      expect(e.quoted_history_cut, client).toBe(true);
      expect(e.own_words_preview, client).not.toMatch(/THIS IS A TEST/);
    }
  });
  it("quote deleted, subject kept: subject only; edited subject, quote kept: quoted text only; both removed: header only (token_missing)", () => {
    const run = sentRun();
    expect(evaluateReply(gmail(run, { bodyText: "$1,150 total." }), run, idsOf(run)).token.summary).toBe("subject");
    const edited = evaluateReply(gmail(run, { subject: "pricing for the 23rd" }), run, idsOf(run));
    expect(edited.token.summary).toBe("quoted text");
    expect(edited.notes).toContain("token only in quoted text");
    expect(edited.engine.match_by).toBe("header+token"); // the engine searches the whole body
    const stripped = evaluateReply(gmail(run, { subject: "pricing", bodyText: "$1,150 total." }), run, idsOf(run));
    expect(stripped).toMatchObject({ token: { summary: "not found", engine_sees_it: false }, engine: { match_by: "header" }, verdict: "identity_unverified:token_missing" });
    expect(stripped.quarantine).toMatchObject({ reason: "identity_unverified:token_missing", explanation: expect.stringMatching(/without Haggle's reference code/), next_step: expect.stringMatching(/scenario 2\/3/) });
  });
  it("a token pasted into the reporter's own words is seen there; a forward from another address is a sender mismatch", () => {
    const run = sentRun();
    const pasted = evaluateReply(gmail(run, { subject: "quote", bodyText: `Quote: $1,150. Ref ${run.token}` }), run, idsOf(run));
    expect(pasted.token.where).toEqual(["own words"]);
    const fwd = evaluateReply(gmail(run, { fromAddress: OUTLOOK }), run, idsOf(run));
    expect(fwd.engine.match_by).toBe("sender_mismatch");
    expect(fwd.quarantine?.next_step).toMatch(/forward scenario/);
  });
});

describe("(c) webhook delivery, read-only", () => {
  it("says only what the subscription and the read flag show, and 'unknown' when nothing does", () => {
    expect(diagnoseWebhook({ subscriptionHasReceived: false, isRead: true }).live_server_saw_it).toMatch(/^no: .*no message\.received/);
    expect(diagnoseWebhook({ subscriptionHasReceived: true, isRead: true, id: "in_1" })).toMatchObject({ read_before_collect: "read", live_server_saw_it: expect.stringMatching(/^probably: .*Not proof: look for mail:in_1/) });
    expect(diagnoseWebhook({ subscriptionHasReceived: true, isRead: false }).live_server_saw_it).toMatch(/^no sign of it: it was still unread/);
    expect(diagnoseWebhook({ subscriptionHasReceived: null, isRead: undefined })).toMatchObject({ subscription_has_message_received: null, read_before_collect: "unknown", live_server_saw_it: expect.stringMatching(/^unknown: /) });
    const run = sentRun();
    expect(evaluateReply(gmail(run), run, idsOf(run)).webhook.live_server_saw_it).toMatch(/not determinable offline/);
  });
});

describe("(d) quarantine reason and (e) keyword extraction, through the pipeline replay", () => {
  it("an accepted reply carries the keyword reading (total, deposit, flags, approvable) labelled as not Claude; held ones carry the reason", async () => {
    const run = sentRun();
    const caps = [gmail(run), gmail(run, { subject: "pricing", bodyText: "$1,150 total." }), gmail(run, { threadId: "thr_new", inReplyTo: null, references: null, subject: "new note", bodyText: `$1,150 total. ${run.token}` })];
    const replays = await replayCaptures(run, caps);
    const evals = withPipeline(caps.map((c) => evaluateReply(c, run, idsOf(run))), replays);
    expect(evals[0]!.extraction).toMatchObject({ reader: KEYWORD_READER, total_usd: 1150, deposit_usd: 345, approvable: false, why_not_approvable: expect.any(String) });
    expect(evals[0]!.quarantine).toBeNull();
    expect(KEYWORD_READER).toMatch(/not Claude/);
    expect(evals[1]).toMatchObject({ extraction: null, quarantine: { reason: "identity_unverified:token_missing" } });
    expect(evals[2]!.quarantine).toMatchObject({ reason: "no_signal", explanation: expect.stringMatching(/couldn't be matched to any deal/) });
  });
  it("an ID mismatch is explained as an engine fix, not a tester problem", async () => {
    const run = sentRun(GMAIL, "<a1b2c3@inkboxmail.test>");
    const ses = "<0100019aSes-0000@email.amazonses.com>";
    const cap = gmail(run, { inReplyTo: ses, references: [ses], threadId: "thr_ses" });
    const [e] = withPipeline([evaluateReply(cap, run, idsOf(run, ses, "0100019aSes-0000"))], await replayCaptures(run, [cap]));
    expect(e!.pipeline).toMatchObject({ outcome: "quarantined:identity_unverified" });
    expect(e!.quarantine).toMatchObject({ reason: "identity_unverified:not_in_our_thread", next_step: expect.stringMatching(/^Engine fix, not a tester problem: this reply names the stored Message-ID/) });
  });
});

describe("overall verdict", () => {
  it("READY when replies name the send-time id (held scenarios counted, not failing it)", () => {
    const run = sentRun();
    const evals = [gmail(run), ios(run), gmail(run, { subject: "pricing", bodyText: "$1,150 total." }), gmail(run, { fromAddress: OUTLOOK })].map((c) => evaluateReply(c, run, idsOf(run)));
    const v = overallVerdict(run, evals);
    expect(v.label).toBe("READY");
    expect(v.line).toMatch(/^READY: replies match by Message-ID \(3\/3 replies name the send-time id; 2\/3 verified with the token\); 1 held/);
  });
  it("READY for Outlook too, though it drops References", () => {
    const run = sentRun(OUTLOOK);
    expect(overallVerdict(run, [evaluateReply(outlook(run), run, idsOf(run))]).label).toBe("READY");
  });
  it("ID MISMATCH when replies name only the stored / SES id", () => {
    const run = sentRun(GMAIL, "<a1b2c3@inkboxmail.test>");
    const ses = "<0100019aSes-0000@email.amazonses.com>";
    const evals = [gmail(run, { inReplyTo: ses, references: [ses] }), ios(run, { inReplyTo: ses, references: [ses] })].map((c) => evaluateReply(c, run, idsOf(run, run.send!.messageId, "0100019aSes-0000")));
    expect(overallVerdict(run, evals).line).toMatch(/^ID MISMATCH: 2\/2 replies name the SES Message-ID, none the send-time id/);
  });
  it("TOKEN ONLY when no Haggle id survives but the token does (an Outlook reply without thread headers)", () => {
    const run = sentRun(OUTLOOK);
    const e = evaluateReply(outlook(run, { inReplyTo: null, references: null }), run, idsOf(run));
    expect(e.engine.match_by).toBe("token");
    expect(e.quarantine?.reason).toBe("identity_unverified:not_in_our_thread");
    expect(overallVerdict(run, [e]).label).toBe("TOKEN ONLY");
  });
  it("NOT MATCHED when neither survives; NO REPLIES when nothing came from the recipient itself", () => {
    const run = sentRun();
    expect(overallVerdict(run, [evaluateReply(gmail(run, { subject: "hi", bodyText: "$1,150", inReplyTo: null, references: null }), run, idsOf(run))]).label).toBe("NOT MATCHED");
    expect(overallVerdict(run, [evaluateReply(gmail(run, { fromAddress: OUTLOOK }), run, idsOf(run))]).label).toBe("NO REPLIES");
    expect(overallVerdict(run, []).line).toMatch(/^NO REPLIES/);
  });
  it("the report puts the verdict first, counts which id replies named, and stays redacted", async () => {
    const run = sentRun();
    const caps = [gmail(run), ios(run)];
    const evals = withPipeline(caps.map((c) => evaluateReply(c, run, idsOf(run), diagnoseWebhook({ subscriptionHasReceived: true, isRead: true, id: c.id }))), await replayCaptures(run, caps));
    const report = buildReport(run, compareMessageIds(run.send!.messageId, run.send!.messageId, null), evals, new Date("2026-10-23T10:00:00Z"), { subscription: "has message.received" });
    expect(report.message_ids).toMatchObject({ observed_in_replies: { send_time: 2, stored: 0, ses: 0, none: 0 }, engine_should_record: expect.stringMatching(/^send_time/) });
    const md = renderMarkdown(report);
    expect(md.split("\n")[2]).toMatch(/^\*\*READY: /);
    expect(md).toMatch(/Extraction \(keyword reading \(offline heuristic, not Claude\)\): total \$1150, deposit \$345/);
    expect(md).toMatch(/Webhook: probably: /);
    for (const s of [run.token, run.secret, GMAIL]) expect(md + JSON.stringify(report)).not.toContain(s);
  });
});

it("dry-run under plain node prints the diagnostics and verdict from the captures and collect's recorded ids, offline", () => {
  const APP = join(import.meta.dirname, "..");
  const dir = mkdtempSync(join(tmpdir(), "haggle-trial-"));
  const run = sentRun(GMAIL, "<a1b2c3@inkboxmail.test>");
  const ses = "<0100019aSes-0000@email.amazonses.com>";
  writeFileSync(join(dir, "run.json"), JSON.stringify(run), { mode: 0o600 });
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "raw", "in_1.json"), JSON.stringify(gmail(run, { id: "in_1", inReplyTo: ses, references: [ses] })));
  writeFileSync(join(dir, "report.json"), JSON.stringify({ message_ids: { stored: ses, ses_message_id: "0100019aSes-0000" }, replies: [], webhook: { subscription: "has message.received" } }));
  const d = spawnSync(process.execPath, ["scripts/email-trial.ts", "dry-run", "--to", GMAIL, "--run", dir], { cwd: APP, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8", timeout: 60_000 });
  expect(d.status).toBe(0);
  expect(d.stdout).toMatch(/\*\*ID MISMATCH: 1\/1 replies name the stored Message-ID/);
  expect(d.stdout).toMatch(/Engine fix, not a tester problem/);
  expect(d.stdout).not.toContain(run.token);
  expect(d.stdout).not.toContain(run.secret);
}, 90_000);
