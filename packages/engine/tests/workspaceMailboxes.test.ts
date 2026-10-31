// A mailbox per workspace (HAGGLE_MAILBOX_PER_WORKSPACE; live/workspaceMailboxes.ts, migration 126):
// lazy, idempotent and concurrency-safe provisioning against a fake Inkbox admin API; deals send from
// their workspace's mailbox (the approver's mail from the shared one); replies are matched only to the
// receiving mailbox's deals; the shared mailbox is the fallback whenever provisioning fails. No network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, inkboxEmail, StubBrain, type InkboxAdminApi } from "../src/index.ts";
import { WorkspaceMailboxes, workspaceHandle, WORKSPACE_MAIL_EVENTS } from "../src/live/workspaceMailboxes.ts";
import { InboundReconciler, ReconcilerGroup } from "../src/live/reconcile.ts";
import type { TrustVerdict } from "../src/inbound/types.ts";
import { BUYER, FakeInkbox } from "./helpers/fakeInkbox.ts";

const BASE = "https://haggle.example";
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });
const { budget_usd, ...request } = GOLDEN_REQUEST;

/** In-memory Inkbox admin: identities by handle (some "taken" by another org), subscriptions, keys. */
class FakeAdmin implements InkboxAdminApi {
  identities = new Map<string, { id: string; emailAddress: string }>();
  takenElsewhere = new Set<string>();
  subs: { identityId: string; url: string; eventTypes: string[] }[] = [];
  creates = 0;
  failSubscribe = false;
  keyOnSubscribe = true;
  delayMs = 0;
  async createIdentity(handle: string) {
    this.creates++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.takenElsewhere.has(handle) || this.identities.has(handle)) throw Object.assign(new Error("handle unavailable"), { statusCode: 409 });
    const i = { id: `aid_${handle}`, emailAddress: `${handle}@inkboxmail.test` };
    this.identities.set(handle, i);
    return i;
  }
  async getIdentity(handle: string) {
    return this.identities.get(handle) ?? null;
  }
  async subscribe(o: { identityId: string; url: string; eventTypes: string[] }) {
    if (this.failSubscribe) throw new Error("subscription failed: whsec_THIS_MUST_NOT_BE_STORED_ANYWHERE_123456");
    const first = !this.subs.some((s) => s.identityId === o.identityId);
    this.subs.push(o);
    return { signingKey: first && this.keyOnSubscribe ? `whsec_key_for_${o.identityId}` : null };
  }
  async rotateSigningKey(handle: string) {
    return `whsec_rotated_for_${handle}`;
  }
}

async function setup(o: { admin?: FakeAdmin; repo?: InMemoryRepository } = {}) {
  const repo = o.repo ?? new InMemoryRepository();
  const admin = o.admin ?? new FakeAdmin();
  const api = new FakeInkbox();
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const mailboxes = new WorkspaceMailboxes({ repo, admin, webhookBaseUrl: BASE, sharedMailbox: BUYER, log: (event, data) => logs.push({ event, data }) });
  for (const id of ["ws_alpha", "ws_beta"]) if (!(await repo.getWorkspace(id))) await repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" } as never);
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(api, BUYER, { isWorkspaceMailbox: (a) => mailboxes.isOurs(a) }), mailboxes,
    extractor: { async extract(i) { const m = i.bodyText.match(/\$([\d,]+) total/); const total = m ? Number(m[1]!.replace(/,/g, "")) : null; return { available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: total, deposit_usd: null, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false, sources: total ? [{ field: "total", source: "email body", excerpt: `$${total} total` }] : [], missing_fields: total ? [] : ["total"], confidence: 0.9 } as never; } },
    attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, externalSenders: "reply_token" },
  });
  return { repo, admin, api, mailboxes, engine, logs };
}

describe("provisioning a workspace's mailbox", () => {
  it("creates the identity, subscribes its mail webhook to /webhooks/inkbox/<handle>, stores the signing key; idempotent after", async () => {
    const { repo, admin, mailboxes } = await setup();
    const box = await mailboxes.inboxFor("ws_alpha");
    const handle = workspaceHandle("ws_alpha");
    expect(handle).toMatch(/^hg-alpha-[0-9a-f]{6}$/);
    expect(box).toBe(`${handle}@inkboxmail.test`);
    expect(admin.subs).toEqual([{ identityId: `aid_${handle}`, url: `${BASE}/webhooks/inkbox/${handle}`, eventTypes: [...WORKSPACE_MAIL_EVENTS] }]);
    expect(await repo.getWorkspaceIdentity("ws_alpha")).toMatchObject({ status: "active", handle, identity_id: `aid_${handle}`, mailbox: box, webhook_secret: `whsec_key_for_aid_${handle}`, error: null });
    expect(await mailboxes.inboxFor("ws_alpha")).toBe(box);
    expect(admin.creates).toBe(1);
    expect(await mailboxes.byHandle(handle)).toMatchObject({ workspace_id: "ws_alpha", mailbox: box });
    expect(await mailboxes.isOurs(box!)).toBe(true);
    expect(await mailboxes.isOurs(BUYER)).toBe(true);
    expect(await mailboxes.isOurs("someone@else.example")).toBe(false);
    // Workspaces get different handles and mailboxes.
    expect(await mailboxes.inboxFor("ws_beta")).not.toBe(box);
  });

  it("concurrent first deals provision once, in one process and across two (the claim row)", async () => {
    const { admin, mailboxes, repo } = await setup();
    admin.delayMs = 20;
    const same = await Promise.all(Array.from({ length: 5 }, () => mailboxes.inboxFor("ws_alpha")));
    expect(new Set(same).size).toBe(1);
    expect(admin.creates).toBe(1);
    // A second process on the same database: it doesn't hold the claim, so its deal falls back to the shared mailbox.
    const other = new WorkspaceMailboxes({ repo, admin, webhookBaseUrl: BASE, sharedMailbox: BUYER });
    const p1 = new WorkspaceMailboxes({ repo, admin, webhookBaseUrl: BASE, sharedMailbox: BUYER });
    const [a, b] = await Promise.all([p1.inboxFor("ws_beta"), other.inboxFor("ws_beta")]);
    expect(admin.creates).toBe(2);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
    expect(await other.inboxFor("ws_beta")).toBe((await repo.getWorkspaceIdentity("ws_beta"))!.mailbox);
  });

  it("a handle taken by another org: the next handle; one this org already has (an earlier crashed attempt): adopted", async () => {
    const { admin, mailboxes, repo } = await setup();
    admin.takenElsewhere.add(workspaceHandle("ws_alpha"));
    expect(await mailboxes.inboxFor("ws_alpha")).toBe(`${workspaceHandle("ws_alpha", 1)}@inkboxmail.test`);
    expect((await repo.getWorkspaceIdentity("ws_alpha"))!.handle).toBe(workspaceHandle("ws_alpha", 1));
    admin.identities.set(workspaceHandle("ws_beta"), { id: "aid_existing", emailAddress: "existing@inkboxmail.test" });
    expect(await mailboxes.inboxFor("ws_beta")).toBe("existing@inkboxmail.test");
  });

  it("no key on the subscription (not the identity's first): a fresh key is minted", async () => {
    const { admin, mailboxes, repo } = await setup();
    admin.keyOnSubscribe = false;
    await mailboxes.inboxFor("ws_alpha");
    expect((await repo.getWorkspaceIdentity("ws_alpha"))!.webhook_secret).toBe(`whsec_rotated_for_${workspaceHandle("ws_alpha")}`);
  });

  it("a failure falls back to the shared mailbox, is recorded without secrets, and is retried later", async () => {
    let now = new Date("2026-10-30T12:00:00Z");
    const repo = new InMemoryRepository({ now: () => now });
    const admin = new FakeAdmin();
    admin.failSubscribe = true;
    const mailboxes = new WorkspaceMailboxes({ repo, admin, webhookBaseUrl: BASE, sharedMailbox: BUYER, now: () => now, retryFailedAfterMs: 60_000 });
    await repo.insertWorkspace({ id: "ws_alpha", name: "a", token_hash: null, connector_secret_hash: null, timezone: "UTC" } as never);
    expect(await mailboxes.inboxFor("ws_alpha")).toBeNull();
    const row = (await repo.getWorkspaceIdentity("ws_alpha"))!;
    expect(row).toMatchObject({ status: "failed", webhook_secret: null });
    expect(row.error).not.toMatch(/THIS_MUST_NOT_BE_STORED/);
    expect(await mailboxes.inboxFor("ws_alpha")).toBeNull(); // too soon to retry
    admin.failSubscribe = false;
    now = new Date(now.getTime() + 2 * 60_000);
    // The identity from the failed attempt exists already: adopted, then subscribed.
    expect(await mailboxes.inboxFor("ws_alpha")).toBe(`${workspaceHandle("ws_alpha")}@inkboxmail.test`);
    expect(await repo.getWorkspaceIdentity("ws_alpha")).toMatchObject({ status: "active" });
  });
});

describe("deals and replies on a workspace mailbox", () => {
  it("the RFQ goes from the workspace's mailbox, the approver's mail from the shared one; the email port refuses any other From", async () => {
    const { engine, api, repo } = await setup();
    await engine.updateSettings({ approver_email: "boss@alpha.example" }, "ws_alpha", "operator");
    const d = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Valley Catering", email: "orders@valley.example" }] });
    const job = (await repo.getJob(d.job_id))!;
    expect(job.inbox).toBe(`${workspaceHandle("ws_alpha")}@inkboxmail.test`);
    expect(api.sent[0]).toMatchObject({ mailbox: job.inbox, o: { to: ["orders@valley.example"], subject: expect.stringMatching(/^Quote request: /) } });
    // The vendor answers in the workspace mailbox; the approval request to the human goes from the shared one.
    const rfq = (await repo.getBusinesses(d.job_id))[0]!.rfq_message_id!;
    expect((await engine.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_q", threadId: null, messageId: "<q@valley.example>", inReplyTo: [rfq], references: [rfq], from: "orders@valley.example", to: [job.inbox], subject: "Re: Quote request", bodyText: "$1,150 total", attachments: [], attachmentsDownloadUrl: null }, external, { mailbox: job.inbox })).outcome).toBe("stored");
    await engine.advanceJob(d.job_id);
    const q = (await engine.getQuotes(d.job_id)).quotes[0]!;
    await engine.requestApproval(d.job_id, q.quote_id, "email");
    expect(api.sent.find((s) => s.o.to[0] === "boss@alpha.example")).toMatchObject({ mailbox: BUYER });
    const port = inkboxEmail(api, BUYER, { isWorkspaceMailbox: async () => false });
    await expect(port.send({ from: "evil@inkboxmail.test", to: "x@y.example", subject: "s", bodyText: "b", idempotencyKey: "k" })).rejects.toThrow(/buyer identity mailbox or a workspace mailbox/);
  });

  it("without a working provisioner (or in mock mode) the shared mailbox is used", async () => {
    const admin = new FakeAdmin();
    admin.failSubscribe = true;
    const { engine, repo } = await setup({ admin });
    const d = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Valley Catering", email: "orders@valley.example" }] });
    expect((await repo.getJob(d.job_id))!.inbox).toBe(BUYER);
  });

  it("a reply is matched only to the receiving mailbox's deals: a new email to workspace A's mailbox never lands on workspace B's deal", async () => {
    const { engine, api, repo } = await setup();
    const a = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Valley Catering", email: "orders@valley.example" }] });
    const b = await engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [{ name: "Valley Catering", email: "orders@valley.example" }] });
    const [ja, jb] = [(await repo.getJob(a.job_id))!, (await repo.getJob(b.job_id))!];
    expect(ja.inbox).not.toBe(jb.inbox);
    // A new email (not a reply) to B's mailbox: the vendor has exactly one open deal there (B's), whatever A has.
    const fresh = { providerEventId: "ev1", eventType: "message.received", providerEmailId: "in_fresh", threadId: null, messageId: "<f1@valley.example>", inReplyTo: [], references: [], from: "orders@valley.example", to: [jb.inbox], subject: "our quote", bodyText: "$1,100 total", attachments: [], attachmentsDownloadUrl: null };
    expect(await engine.ingest(fresh, external, { mailbox: jb.inbox })).toMatchObject({ jobId: b.job_id, outcome: "stored" });
    // A reply naming A's RFQ, but delivered to B's mailbox (webhook scoped to B): not read into A.
    const rfqA = (await repo.getBusinesses(a.job_id))[0]!.rfq_message_id!;
    const cross = { ...fresh, providerEmailId: "in_cross", messageId: "<f2@valley.example>", inReplyTo: [rfqA], references: [rfqA] };
    const r = await engine.ingest(cross, external, { mailbox: jb.inbox });
    expect(r.jobId).not.toBe(a.job_id);
    expect((await repo.listMessages(a.job_id)).filter((m) => m.direction === "in")).toHaveLength(0);
    // The same reply to A's own mailbox is A's.
    expect(await engine.ingest({ ...cross, providerEmailId: "in_a" }, external, { mailbox: ja.inbox })).toMatchObject({ jobId: a.job_id, outcome: "stored" });
    void api;
  });

  it("the reconciler sweeps every workspace mailbox and matches its mail to that mailbox's deals", async () => {
    const { engine, api, repo, mailboxes } = await setup();
    const a = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Valley Catering", email: "orders@valley.example" }] });
    const ja = (await repo.getJob(a.job_id))!;
    const rfq = (await repo.getBusinesses(a.job_id))[0]!.rfq_message_id!;
    api.reply("orders@valley.example", rfq, "We can do it: $1,150 total.", [], { to: ja.inbox, recordOutbound: false });
    const make = (box: string) => new InboundReconciler({ engine, repo, catchUp: false, cursorScope: box, ingestMailbox: box, sources: { mail: { api, buyerMailbox: box, senderTrust: { policy: "outbound-verified" }, identityAddresses: async () => [] } } });
    const group = new ReconcilerGroup(make(BUYER), { mailboxes: async () => (await mailboxes.mailboxes()).map((r) => r.mailbox!), jobInbox: async (id) => (await repo.getJob(id))?.inbox ?? null, make });
    const r = await group.sweepAll();
    expect(r.recovered).toMatchObject([{ channel: "email", jobId: a.job_id, outcome: "stored" }]);
    expect(await group.sweepJob(a.job_id)).toBe(0); // already ingested
  });
});
