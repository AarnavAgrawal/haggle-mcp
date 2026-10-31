// §4 "You can change your settings": the signed-in workspace owner (web app) may change what the
// operator can, within the server ceiling; an agent still can't change the approver or raise the cap;
// a new approver takes effect only after verification. Real engine, in-memory store, fake ports and clock.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig } from "../src/index.ts";
import { approverCodeText, auditRows, profilePatch } from "../src/workflow/ownerSettings.ts";

const WS = "ws_owner";
const OLD_PHONE = "+14155550101";
const NEW_PHONE = "+14155550177";
const OWNER = "priya@acme.test (u_1)";

function setup(config: Partial<EngineConfig> = {}, opts: { imessage?: boolean; failText?: boolean } = {}) {
  let t = Date.parse("2026-10-31T17:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: { extract: async () => { throw new Error("unused"); } } as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    ...(opts.imessage === false ? {} : { imessage: { async send(r: { to: string; text: string }) { if (opts.failText) throw new Error('HTTP 404 {"error":"not_found"}'); texts.push(r); return { messageId: `im_${texts.length}` }; } } }),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 1_000_000, maxRounds: 2, spendingCapCeilingCents: 1_000_000, ...config,
    },
  });
  return { engine, repo, clock, emails, texts };
}

async function workspace(env: ReturnType<typeof setup>) {
  await env.repo.insertWorkspace({ id: WS, name: "Acme Labs", token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
  await env.engine.updateSettings({ approver_phone: OLD_PHONE, approver_email: "priya@acme.test", spending_cap_cents: 150_000 }, WS, "operator", "Yash");
}

/** The code in the last text to this number. */
const codeIn = (texts: { to: string; text: string }[], to: string) => /\b(\d{6})\b/.exec(texts.filter((x) => x.to === to).at(-1)!.text)![1]!;

describe("owner settings: limits", () => {
  it("an owner can raise the default deal limit up to the server ceiling, not past it", async () => {
    const env = setup();
    await workspace(env);
    const r = await env.engine.ownerUpdateSettings(WS, OWNER, { spending_cap_cents: 900_000 });
    expect(r.settings.default_deal_limit_usd).toBe(9000);
    expect(r.changed).toEqual(["spending_cap_cents"]);
    expect((await env.engine.getSettings(WS)).spending_cap_cents).toBe(900_000);
    await expect(env.engine.ownerUpdateSettings(WS, OWNER, { spending_cap_cents: 1_000_001 })).rejects.toMatchObject({ code: "cap_above_ceiling" });
    expect((await env.engine.getSettings(WS)).spending_cap_cents).toBe(900_000);
  });

  it("an agent still can't raise the limit or change the approver", async () => {
    const env = setup();
    await workspace(env);
    const agent = env.engine.forWorkspace(WS);
    await expect(agent.updateSettings({ spending_cap_cents: 150_001 })).rejects.toMatchObject({ code: "cap_increase_requires_operator" });
    await expect(agent.updateSettings({ approver_phone: NEW_PHONE })).rejects.toMatchObject({ code: "approver_change_requires_operator" });
    await expect(agent.updateSettings({ approver_email: null })).rejects.toMatchObject({ code: "approver_change_requires_operator" });
    await agent.updateSettings({ spending_cap_cents: 100_000 });
    expect((await env.engine.getSettings(WS)).spending_cap_cents).toBe(100_000);
  });

  it("an owner can't set a new approver through updateSettings directly (only through verification)", async () => {
    const env = setup();
    await workspace(env);
    await expect(env.engine.updateSettings({ approver_phone: NEW_PHONE }, WS, "owner", OWNER)).rejects.toMatchObject({ code: "approver_verification_required" });
    expect((await env.engine.getSettings(WS)).approver_phone).toBe(OLD_PHONE);
  });

  it("every change is audited: who, which field, old and new, phones and emails masked", async () => {
    const env = setup();
    await workspace(env);
    await env.engine.ownerUpdateSettings(WS, OWNER, { spending_cap_cents: 200_000, default_area: "Oakland, CA", name: "Acme Labs SF", sender_name: "Priya at Acme Labs", timezone: "America/New_York" });
    const audit = await env.repo.listSettingsAudit(WS);
    const owner = audit.filter((a) => a.by === "owner");
    expect(owner.map((a) => a.field).sort()).toEqual(["default_area", "name", "sender_name", "spending_cap_cents", "timezone"]);
    expect(owner.find((a) => a.field === "spending_cap_cents")).toMatchObject({ actor: OWNER, old_value: "150000", new_value: "200000" });
    const op = audit.filter((a) => a.by === "operator");
    expect(op.find((a) => a.field === "approver_phone")!.new_value).not.toContain("5550101");
    expect(op.find((a) => a.field === "approver_email")!.new_value).toBe("p•••@acme.test");
    const ws = await env.engine.workspaceSettings(WS);
    expect(ws).toMatchObject({ name: "Acme Labs SF", timezone: "America/New_York", sender_name: "Priya at Acme Labs", default_area: "Oakland, CA", default_deal_limit_usd: 2000, ceiling_usd: 10000 });
  });

  it("refuses bad input before saving anything", async () => {
    const env = setup();
    await workspace(env);
    await expect(env.engine.ownerUpdateSettings(WS, OWNER, { spending_cap_cents: 200_000, timezone: "Mars/Olympus" })).rejects.toMatchObject({ code: "bad_timezone" });
    await expect(env.engine.ownerUpdateSettings(WS, OWNER, { spending_cap_cents: 200_000, approver_phone: "415-555" })).rejects.toMatchObject({ code: "bad_phone" });
    expect((await env.engine.getSettings(WS)).spending_cap_cents).toBe(150_000);
    expect((await env.repo.listSettingsAudit(WS)).every((a) => a.by === "operator")).toBe(true); // nothing from the owner
  });

  it("a store without migration 129 refuses owner changes and names the migration", async () => {
    const env = setup();
    await workspace(env);
    (env.repo as unknown as Record<string, unknown>).appendSettingsAudit = undefined;
    await expect(env.engine.ownerUpdateSettings(WS, OWNER, { spending_cap_cents: 200_000 })).rejects.toMatchObject({ code: "settings_store_outdated" });
  });
});

describe("owner settings: approver changes wait for verification", () => {
  it("a new phone gets a 6-digit code by iMessage; the old approver stays until it is typed back", async () => {
    const env = setup();
    await workspace(env);
    const r = await env.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE });
    expect(r.changed).toEqual(["approver_phone_pending"]);
    expect(r.demo_codes).toBeUndefined(); // live: the code is never returned
    expect(r.settings.pending).toEqual([expect.objectContaining({ kind: "phone", attempts_left: 5 })]);
    expect(r.settings.pending[0]!.to).not.toContain("5550177");
    expect(env.texts).toHaveLength(1);
    expect(env.texts[0]!.text.length).toBeLessThanOrEqual(159);
    expect(env.texts[0]!.text).not.toMatch(/https?:|\+\d/);
    expect((await env.engine.getSettings(WS)).approver_phone).toBe(OLD_PHONE);
    // The current approver is told by email that a change was asked for.
    expect(env.emails.find((e) => e.to === "priya@acme.test")?.subject).toMatch(/approver is being changed/);
    // Only the hash is stored.
    const [pending] = await env.repo.pendingApproverChanges(WS);
    expect(pending!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(pending)).not.toContain(codeIn(env.texts, NEW_PHONE));

    const ok = await env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: codeIn(env.texts, NEW_PHONE) });
    expect(ok.confirmed).toBe("phone");
    expect(ok.settings.pending).toEqual([]);
    expect((await env.engine.getSettings(WS)).approver_phone).toBe(NEW_PHONE);
    const audit = await env.repo.listSettingsAudit(WS);
    expect(audit[0]).toMatchObject({ by: "owner", actor: OWNER, field: "approver_phone" });
    expect(audit[0]!.new_value).not.toContain("5550177");
  });

  it("a wrong code is refused and counted; five end the change", async () => {
    const env = setup();
    await workspace(env);
    await env.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE });
    const right = codeIn(env.texts, NEW_PHONE);
    const wrong = right === "000000" ? "111111" : "000000";
    await expect(env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: wrong })).rejects.toMatchObject({ code: "wrong_code", message: expect.stringContaining("4 tries left") });
    for (let i = 0; i < 3; i++) await expect(env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: wrong })).rejects.toMatchObject({ code: "wrong_code" });
    await expect(env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: wrong })).rejects.toMatchObject({ code: "too_many_attempts" });
    await expect(env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: right })).rejects.toMatchObject({ code: "no_pending_change" });
    expect((await env.engine.getSettings(WS)).approver_phone).toBe(OLD_PHONE);
  });

  it("an expired code is refused and the old approver stays", async () => {
    const env = setup();
    await workspace(env);
    await env.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE });
    env.clock.advance(15 * 60_000 + 1);
    expect((await env.engine.workspaceSettings(WS)).pending).toEqual([]);
    await expect(env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: codeIn(env.texts, NEW_PHONE) })).rejects.toMatchObject({ code: "verification_expired" });
    expect((await env.engine.getSettings(WS)).approver_phone).toBe(OLD_PHONE);
  });

  it("a newer request supersedes the older code", async () => {
    const env = setup();
    await workspace(env);
    await env.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE });
    const first = codeIn(env.texts, NEW_PHONE);
    await env.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: "+14155550188" });
    const second = codeIn(env.texts, "+14155550188");
    if (first !== second) await expect(env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: first })).rejects.toMatchObject({ code: "wrong_code" });
    await env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: second });
    expect((await env.engine.getSettings(WS)).approver_phone).toBe("+14155550188");
  });

  it("a new email gets a confirm link (token) and a code; the link works only for its own workspace", async () => {
    const env = setup();
    await workspace(env);
    await env.repo.insertWorkspace({ id: "ws_other", name: "Other", token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await env.engine.ownerUpdateSettings(WS, OWNER, { approver_email: "Ops@Acme.test" }, { confirmUrl: "https://app.haggle.test/settings" });
    const mail = env.emails.find((e) => e.to === "ops@acme.test")!;
    const token = decodeURIComponent(/confirm=([^\s]+)/.exec(mail.bodyText)![1]!);
    expect(mail.bodyText).toContain("https://app.haggle.test/settings?confirm=");
    expect((await env.engine.getSettings(WS)).approver_email).toBe("priya@acme.test");
    await expect(env.engine.confirmApproverChange("ws_other", "someone", { token })).rejects.toMatchObject({ code: "no_pending_change" });
    const ok = await env.engine.confirmApproverChange(WS, OWNER, { token });
    expect(ok.confirmed).toBe("email");
    expect((await env.engine.getSettings(WS)).approver_email).toBe("ops@acme.test");
    await expect(env.engine.confirmApproverChange(WS, OWNER, { token })).rejects.toMatchObject({ code: "no_pending_change" });
  });

  it("the owner may clear an approver directly, and cancel a pending change", async () => {
    const env = setup();
    await workspace(env);
    await env.engine.ownerUpdateSettings(WS, OWNER, { approver_email: null });
    expect((await env.engine.getSettings(WS)).approver_email).toBeNull();
    await env.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE });
    const c = await env.engine.cancelApproverChange(WS, OWNER, "phone");
    expect(c.cancelled).toBe(true);
    expect(c.settings.pending).toEqual([]);
    await expect(env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: codeIn(env.texts, NEW_PHONE) })).rejects.toMatchObject({ code: "no_pending_change" });
  });

  it("without iMessage a new phone is refused (nothing saved); a failed send cancels the change", async () => {
    const off = setup({}, { imessage: false });
    await workspace(off);
    await expect(off.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE, spending_cap_cents: 200_000 })).rejects.toMatchObject({ code: "imessage_off" });
    expect((await off.engine.getSettings(WS)).spending_cap_cents).toBe(150_000);
    const failing = setup({}, { failText: true });
    await workspace(failing);
    await expect(failing.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE })).rejects.toMatchObject({ code: "verification_not_sent" });
    expect(await failing.repo.pendingApproverChanges(WS)).toEqual([]);
  });

  it("mock mode sends nothing and returns the code, for the demo", async () => {
    const env = setup({ mode: "mock" }, { imessage: false });
    await workspace(env);
    const r = await env.engine.ownerUpdateSettings(WS, OWNER, { approver_phone: NEW_PHONE });
    expect(env.texts).toHaveLength(0);
    expect(r.demo_codes).toEqual([{ kind: "phone", code: expect.stringMatching(/^\d{6}$/) }]);
    await env.engine.confirmApproverChange(WS, OWNER, { kind: "phone", code: r.demo_codes![0]!.code });
    expect((await env.engine.getSettings(WS)).approver_phone).toBe(NEW_PHONE);
  });
});

describe("ownerSettings helpers", () => {
  it("checks the profile fields", () => {
    expect(profilePatch({ name: "  Acme\u0007 Labs " })).toEqual({ patch: { name: "Acme Labs" } });
    expect(profilePatch({ sender_name: "" })).toEqual({ patch: { sender_name: null } });
    expect(profilePatch({ name: "" })).toMatchObject({ problem: { code: "bad_name" } });
    expect(profilePatch({ sender_name: "x".repeat(81) })).toMatchObject({ problem: { code: "bad_sender_name" } });
  });
  it("audits only changed fields", () => {
    const rows = auditRows("w", "owner", "a", { a: 1, approver_phone: "+14155550101" }, { a: 1, approver_phone: "+14155550199" }, (h) => `masked:${h.slice(-4)}`);
    expect(rows).toEqual([{ workspace_id: "w", by: "owner", actor: "a", field: "approver_phone", old_value: "masked:0101", new_value: "masked:0199" }]);
  });
  it("the code text fits iMessage's first-message rules", () => {
    const t = approverCodeText("123456");
    expect(t.length).toBeLessThanOrEqual(159);
    expect(t).not.toMatch(/https?:|www\.|\+?\d{7,}/);
  });
});
