// Thread continuity is scoped to one conversation (job + business): a reply naming Haggle's
// Message-ID to vendor V on deal X counts only for (X, V), only from V's pinned address. No reference
// code or reply token ever goes out to a business (2026-10-30); an old token pasted into a message is
// masked. Real engine, fake ports, no network.
import { describe, expect, it } from "vitest";
import { dealWith, liveEngine, vendorReply } from "./helpers/liveEngine.ts";

const V = { name: "Valley Catering", email: "orders@valley.example" };
const W = { name: "Westside Kitchen", email: "hello@westside.example" };
const CODES = /HGR-[A-HJ-NP-Z2-9]{10}|\bHG-[A-Z0-9]{4,8}\b/i;

describe("a reply in Haggle's thread verifies only its own conversation", () => {
  it("a reply naming deal X's RFQ goes to deal X, never to deal Y with the same vendor", async () => {
    const env = liveEngine();
    const x = await dealWith(env, [V]);
    const y = await dealWith(env, [V]);
    const [bx, by] = [x.businesses[0]!, y.businesses[0]!];
    expect(bx.business_id).toBe(by.business_id); // the same vendor on both deals
    expect((await vendorReply(env, bx, "")).outcome).toBe("stored");
    expect((await env.repo.listMessages(x.jobId)).filter((m) => m.direction === "in")).toHaveLength(1);
    expect((await env.repo.listMessages(y.jobId)).filter((m) => m.direction === "in")).toHaveLength(0);
    expect((await vendorReply(env, by, "")).outcome).toBe("stored");
    expect((await env.repo.listMessages(y.jobId)).find((m) => m.direction === "in")).toMatchObject({ sender_trusted: true, trust_reason: "external-thread-reply", matched_via: "message_id" });
  });

  it("vendor V's address posting into vendor W's thread is a sender mismatch, never W's quote", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [V, W]);
    const bw = d.businesses.find((b) => b.email === W.email)!;
    expect((await vendorReply(env, { ...bw, email: V.email }, "")).outcome).toBe("quarantined:sender_mismatch");
    const held = (await env.repo.listMessages(d.jobId)).filter((m) => m.direction === "in");
    expect(held.map((m) => m.quarantine_reason)).toEqual(["sender_mismatch"]);
    expect(held.every((m) => m.sender_trusted === false)).toBe(true);
  });

  it("a reply to a cancelled deal's RFQ isn't read into the vendor's new deal", async () => {
    const env = liveEngine();
    const x = await dealWith(env, [V]);
    await env.engine.cancel(x.jobId);
    const y = await dealWith(env, [V]);
    await vendorReply(env, x.businesses[0]!, "");
    expect((await env.repo.listMessages(y.jobId)).filter((m) => m.direction === "in")).toHaveLength(0);
  });
});

describe("no code or token goes out to a business", () => {
  it("RFQs, follow-ups and messages to two vendors on two deals carry no reference code", async () => {
    const env = liveEngine();
    const a = await dealWith(env, [V, W]);
    const b = await dealWith(env, [W]);
    const bv = a.businesses.find((x) => x.email === V.email)!;
    await vendorReply(env, bv, "", { bodyText: "Yes we can. What time do you need it?" });
    await env.engine.advanceJob(a.jobId);
    await env.engine.advanceJob(b.jobId);
    expect(env.emails.length).toBeGreaterThanOrEqual(3);
    for (const e of env.emails) expect(`${e.subject}\n${e.bodyText}`, `mail to ${e.to}`).not.toMatch(CODES);
    // Every email to a vendor on a deal shares the RFQ's plain subject, so the vendor's mail app threads it.
    for (const e of env.emails) expect(e.subject.replace(/^Re: /, "")).toMatch(/^Quote request: /);
  });

  it("an old reply token pasted into a message (from an earlier thread) is masked before it reaches a vendor", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [V, W]);
    const bw = d.businesses.find((b) => b.email === W.email)!;
    await vendorReply(env, bw, "", { bodyText: "We can do it: $1,200 total." });
    await env.engine.advanceJob(d.jobId);
    const r = await env.engine.sendMessage(d.jobId, bw.business_id, { text: "Could you confirm the menu? Our reference with the other caterer was HGR-7KQ2M9XA4T." });
    expect(r.ok).toBe(true);
    const toW = env.emails.filter((e) => e.to === W.email).at(-1)!;
    expect(`${toW.subject}\n${toW.bodyText}`).not.toContain("HGR-7KQ2M9XA4T");
    expect(toW.bodyText).toContain("HGR-…");
  });
});
