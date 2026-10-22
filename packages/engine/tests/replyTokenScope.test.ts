// Reply tokens are scoped to one conversation (job + business): a token from deal X / vendor V can't
// verify a reply on deal Y or for vendor W, and a token never leaves Haggle in mail to anyone but that
// business's own address. Real engine, fake ports, no network.
import { describe, expect, it } from "vitest";
import { replyToken } from "../src/inbound/senderAuth.ts";
import { dealWith, liveEngine, TOKEN_SECRET, vendorReply, type LiveEnv } from "./helpers/liveEngine.ts";

const V = { name: "Valley Catering", email: "orders@valley.example" };
const W = { name: "Westside Kitchen", email: "hello@westside.example" };
const TOKEN = /HGR-[A-HJ-NP-Z2-9]{10}/gi;

/** Every token in every email sent so far, checked against the recipient's own token for its deal. */
async function assertTokensScoped(env: LiveEnv) {
  const owners = new Map<string, string>(); // token -> lowercased address it belongs to
  for (const job of await env.repo.listOpenJobs()) {
    for (const b of await env.repo.getBusinesses(job.id)) owners.set(replyToken(TOKEN_SECRET, job.id, b.business_id), b.email!.toLowerCase());
  }
  for (const closed of await env.repo.listRecentJobs(50)) for (const b of await env.repo.getBusinesses(closed.id)) owners.set(replyToken(TOKEN_SECRET, closed.id, b.business_id), b.email!.toLowerCase());
  let seen = 0;
  for (const e of env.emails) {
    for (const t of `${e.subject}\n${e.bodyText}`.match(TOKEN) ?? []) {
      seen++;
      expect(owners.get(t.toUpperCase()), `${t} in mail to ${e.to}`).toBe(e.to.toLowerCase());
    }
  }
  return seen;
}

describe("a reply token verifies only its own conversation", () => {
  it("deal X's token can't verify the same vendor's reply on deal Y", async () => {
    const env = liveEngine();
    const x = await dealWith(env, [V]);
    const y = await dealWith(env, [V]);
    const [bx, by] = [x.businesses[0]!, y.businesses[0]!];
    expect(bx.business_id).toBe(by.business_id); // the same vendor on both deals
    expect(x.token(bx.business_id)).not.toBe(y.token(by.business_id));
    // In deal Y's thread, quoting deal X's token: not verified.
    expect((await vendorReply(env, by, x.token(bx.business_id))).outcome).toBe("quarantined:identity_unverified");
    const q = (await env.repo.listMessages(y.jobId)).find((m) => m.direction === "in")!;
    expect(q).toMatchObject({ kind: "quarantine", quarantine_reason: "identity_unverified:token_missing", sender_trusted: false });
    // With its own token it is.
    expect((await vendorReply(env, by, y.token(by.business_id))).outcome).toBe("stored");
  });

  it("vendor V's token can't verify a reply for vendor W on the same deal, from either address", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [V, W]);
    const [bv, bw] = [d.businesses.find((b) => b.email === V.email)!, d.businesses.find((b) => b.email === W.email)!];
    // W's address, W's thread, V's token.
    expect((await vendorReply(env, bw, d.token(bv.business_id))).outcome).toBe("quarantined:identity_unverified");
    // V's address and token, posted into W's thread: someone else writing in W's conversation.
    expect((await vendorReply(env, { ...bw, email: V.email }, d.token(bv.business_id))).outcome).toBe("quarantined:sender_mismatch");
    const held = (await env.repo.listMessages(d.jobId)).filter((m) => m.direction === "in");
    expect(held.map((m) => m.quarantine_reason)).toEqual(["identity_unverified:token_missing", "sender_mismatch"]);
    expect(held.every((m) => m.sender_trusted === false)).toBe(true);
  });

  it("a token reused after the deal it belongs to is cancelled doesn't verify a reply on a new deal", async () => {
    const env = liveEngine();
    const x = await dealWith(env, [V]);
    await env.engine.cancel(x.jobId);
    const y = await dealWith(env, [V]);
    expect((await vendorReply(env, y.businesses[0]!, x.token(x.businesses[0]!.business_id))).outcome).toBe("quarantined:identity_unverified");
  });
});

describe("a reply token never appears in mail to anyone else", () => {
  it("RFQs, follow-ups and messages to two vendors on two deals each carry only the recipient's own token", async () => {
    const env = liveEngine();
    const a = await dealWith(env, [V, W]);
    const b = await dealWith(env, [W]);
    const bv = a.businesses.find((x) => x.email === V.email)!;
    // V replies (quoting its own token), and is asked something back.
    await vendorReply(env, bv, a.token(bv.business_id), { bodyText: "Yes we can. What time do you need it?" });
    await env.engine.advanceJob(a.jobId);
    await env.engine.advanceJob(b.jobId);
    expect(await assertTokensScoped(env)).toBeGreaterThanOrEqual(6); // 3 RFQs, subject + body each
  });

  it("text naming another business's token (e.g. pasted from its reply) is masked before it reaches a different vendor", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [V, W]);
    const [bv, bw] = [d.businesses.find((b) => b.email === V.email)!, d.businesses.find((b) => b.email === W.email)!];
    await vendorReply(env, bw, d.token(bw.business_id), { bodyText: "We can do it: $1,200 total." });
    await env.engine.advanceJob(d.jobId);
    const vToken = d.token(bv.business_id);
    const r = await env.engine.sendMessage(d.jobId, bw.business_id, { text: `Could you confirm the menu? Our reference with the other caterer was ${vToken}.` });
    expect(r.ok).toBe(true);
    const toW = env.emails.filter((e) => e.to === W.email).at(-1)!;
    expect(`${toW.subject}\n${toW.bodyText}`).not.toContain(vToken);
    expect(toW.bodyText).toContain("HGR-…");
    expect(toW.subject).toContain(d.token(bw.business_id)); // W's own token stays
    await assertTokensScoped(env);
  });
});
