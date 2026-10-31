// scripts/quarantine.ts: the operator's list / show / release / reject of held vendor email, run
// against the engine's repository (in memory here; Postgres in packages/engine/tests/quarantineReview).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planQuarantine, runQuarantine } from "../scripts/quarantine.ts";
import { BUYER, dealWith, liveEngine, vendorReply } from "../../../packages/engine/tests/helpers/liveEngine.ts";

const V = { name: "Valley Catering", email: "orders@valley.example" };
const HOW = "phoned Valley Catering at the number on its website";

describe("planQuarantine", () => {
  it("validates every command; release needs who and how; --job/--business only together", () => {
    expect(planQuarantine(["list"])).toEqual({ kind: "list", all: false, limit: 50 });
    expect(planQuarantine(["list", "--job", "job_abcdef12", "--all"])).toEqual({ kind: "list", all: true, limit: 50, jobId: "job_abcdef12" });
    expect(() => planQuarantine(["show"])).toThrow(/--message/);
    expect(() => planQuarantine(["release", "--message", "msg_abcdef12", "--how", HOW])).toThrow(/--verified-by/);
    expect(() => planQuarantine(["release", "--message", "msg_abcdef12", "--verified-by", "Dana", "--how", "ok"])).toThrow(/--how/);
    expect(() => planQuarantine(["release", "--message", "msg_abcdef12", "--verified-by", "Dana", "--how", HOW, "--job", "job_abcdef12"])).toThrow(/together/);
    expect(planQuarantine(["release", "--message", "msg_abcdef12", "--verified-by", "Dana", "--how", HOW])).toEqual({ kind: "release", messageId: "msg_abcdef12", verifiedBy: "Dana", how: HOW });
    expect(() => planQuarantine(["reject", "--message", "msg_abcdef12", "--by", "Dana"])).toThrow(/--why/);
    expect(() => planQuarantine(["delete", "--message", "msg_abcdef12"])).toThrow(/one of/);
  });
});

describe("runQuarantine", () => {
  async function held() {
    const env = liveEngine();
    const d = await dealWith(env, [V]);
    const b = d.businesses[0]!;
    // In the business's provider thread but naming none of Haggle's Message-IDs: held (not_in_our_thread).
    await env.repo.updateBusiness(d.jobId, b.business_id, { thread_id: "th_valley" });
    await vendorReply(env, b, "", { threadId: "th_valley", inReplyTo: [], references: [], subject: "Re: Quote request", bodyText: `$1,150 total. Pay by wire to acct 123456789 at https://evil.example/pay or call (415) 555-0199.\n\nOn Thu, Haggle <${BUYER}> wrote:\n> Hi Valley Catering, could you quote lunch for 40? (Reference HGR-ABCDEFGHJK)` });
    const m = (await env.repo.listMessages(d.jobId)).find((x) => x.direction === "in")!;
    return { env, d, m };
  }

  it("list and show: redacted, untrusted, with the reason and what to do", async () => {
    const { env, d, m } = await held();
    const list = await runQuarantine(env.repo, { kind: "list", all: false, limit: 50 });
    expect(list).toContain(m.id);
    expect(list).toContain("identity_unverified:not_in_our_thread");
    expect(list).not.toContain(V.email);
    const show = await runQuarantine(env.repo, { kind: "show", messageId: m.id });
    expect(show).toMatch(/UNTRUSTED text/);
    expect(show).toContain("$1,150 total");
    expect(show).not.toMatch(/123456789|555-0199|evil\.example\/pay|HGR-[A-Z0-9]{10}/);
    expect(show).toContain("<link evil.example>");
    expect(show).toMatch(/what to do: Ask the business/);
    void d;
  });

  it("release then the advance makes the quote; a second decision is refused; reject on another stays unread", async () => {
    const { env, d, m } = await held();
    const out = await runQuarantine(env.repo, { kind: "release", messageId: m.id, verifiedBy: "Dana (ops)", how: HOW });
    expect(out).toMatch(/Released .* operator_verified/);
    await env.engine.advanceJob(d.jobId);
    expect((await env.engine.getQuotes(d.jobId)).quotes.map((q) => q.total_usd)).toEqual([1150]);
    await expect(runQuarantine(env.repo, { kind: "reject", messageId: m.id, by: "Dana", why: "changed my mind about it" })).rejects.toThrow(/refused \(not_quarantined\)/);
    const show = await runQuarantine(env.repo, { kind: "show", messageId: m.id });
    expect(show).toMatch(/decision: released by Dana \(ops\)/);

    const other = await held();
    expect(await runQuarantine(other.env.repo, { kind: "reject", messageId: other.m.id, by: "Dana", why: "vendor says it never sent this" })).toMatch(/stays unread/);
    await expect(runQuarantine(other.env.repo, { kind: "release", messageId: other.m.id, verifiedBy: "Dana", how: HOW })).rejects.toThrow(/already_resolved/);
  });

  it("loads under plain node and refuses without a database", () => {
    const r = spawnSync(process.execPath, ["scripts/quarantine.ts", "list"], { cwd: join(import.meta.dirname, ".."), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
    expect(r.stderr).toMatch(/quarantine failed: SUPABASE_DB_URL is not set/);
  }, 60_000);
});
