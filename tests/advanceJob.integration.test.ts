// Orchestration test: advanceJob + state machine + effects against an
// in-memory stand-in for the database, email, and parser. Walks one job from
// collecting through a negotiation round to ready, and checks approval
// self-healing.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = {
  jobs: new Map<string, Row>(),
  vendors: [] as Row[],
  messages: [] as Row[],
  quotes: [] as Row[],
  approvals: [] as Row[],
  events: [] as Row[],
  replies: [] as { parent: string; text: string; key: string }[],
  parsePrices: new Map<string, number>(), // message id -> per-head dollars
};
let nextId = 1;
const id = (p: string) => `${p}-${nextId++}`;

vi.mock("../src/config.js", () => ({
  getConfig: () => ({ negotiationWindowSeconds: 45, PRIMITIVE_FROM_ADDRESS: "quotes@qb.test" }),
  ConfigError: class extends Error {},
}));

vi.mock("../src/channels/email.js", () => ({
  emailChannel: {
    replyTo: async (parent: string, text: string, key: string) => {
      store.replies.push({ parent, text, key });
      return { providerId: id("sent") };
    },
  },
  downloadAttachmentsArchive: async () => Buffer.alloc(0),
}));

vi.mock("../src/parser/parseReply.js", () => ({
  parseReply: async ({ bodyText }: { bodyText: string }) => {
    const perHead = Number(bodyText);
    return {
      available: true,
      price_per_head_usd: perHead,
      headcount: 40,
      subtotal_usd: perHead * 40,
      delivery_fee_usd: 0,
      tax_usd: null,
      total_usd: perHead * 40,
      deposit_usd: 100,
      menu_items: [],
      dietary_coverage: [{ need: "vegetarian", covered: true }],
      valid_until: null,
      missing_fields: [],
      confidence: 0.9,
    };
  },
}));

vi.mock("../src/db/queries.js", () => {
  const job = (jobId: string) => store.jobs.get(jobId) ?? null;
  return {
    getJob: async (jobId: string) => (job(jobId) ? { ...job(jobId) } : null),
    casJob: async (jobId: string, version: number, patch: Row) => {
      const j = job(jobId);
      if (!j || j.version !== version) return null;
      Object.assign(j, patch, { version: version + 1 });
      return { ...j };
    },
    updateJobVersioned: async (jobId: string, patch: Row = {}) => {
      const j = job(jobId)!;
      Object.assign(j, patch, { version: j.version + 1 });
      return { ...j };
    },
    insertJobEvent: async (jobId: string, type: string, data: Row = {}) => {
      store.events.push({ job_id: jobId, type, data });
    },
    hasRoundEvent: async (jobId: string, type: string, round: number) =>
      store.events.some((e) => e.job_id === jobId && e.type === type && e.data.round === round),
    getVendors: async (jobId: string) => store.vendors.filter((v) => v.job_id === jobId).map((v) => ({ ...v })),
    updateVendor: async (vendorId: string, patch: Row) => Object.assign(store.vendors.find((v) => v.id === vendorId)!, patch),
    markSilentVendors: async (jobId: string) => {
      for (const v of store.vendors) if (v.job_id === jobId && v.status === "contacted") v.status = "no_reply";
    },
    getPendingMessages: async (jobId: string) => store.messages.filter((m) => m.job_id === jobId && m.parse_status === "pending"),
    setParseStatus: async (msgId: string, s: string) => {
      store.messages.find((m) => m.id === msgId)!.parse_status = s;
    },
    insertMessage: async (row: Row) => {
      const m = { id: id("msg"), created_at: new Date(Date.now() + nextId).toISOString(), ...row };
      store.messages.push(m);
      return m;
    },
    getLatestInboundFromVendor: async (vendorId: string) =>
      store.messages.filter((m) => m.vendor_id === vendorId && m.direction === "in").at(-1) ?? null,
    getCounteredVendorIds: async (jobId: string, round: number) =>
      store.messages.filter((m) => m.job_id === jobId && m.kind === "counter" && m.round === round).map((m) => m.vendor_id),
    insertCurrentQuote: async (row: Row) => {
      if (store.quotes.some((q) => q.source_message_id === row.source_message_id)) return null;
      for (const q of store.quotes) if (q.vendor_id === row.vendor_id) q.is_current = false;
      const q = { id: id("q"), is_current: true, ...row };
      store.quotes.push(q);
      return q;
    },
    getCurrentQuotes: async (jobId: string) => store.quotes.filter((q) => q.job_id === jobId && q.is_current),
    getLatestApproval: async (jobId: string) => store.approvals.filter((a) => a.job_id === jobId).at(-1) ?? null,
    getPendingApproval: async (jobId: string) => store.approvals.find((a) => a.job_id === jobId && a.status === "pending") ?? null,
    transitionApproval: async (apId: string, from: string, patch: Row) => {
      const a = store.approvals.find((x) => x.id === apId);
      if (!a || a.status !== from) return false;
      Object.assign(a, patch);
      return true;
    },
  };
});

const { advanceJob } = await import("../src/jobs/advanceJob.js");

const JOB = "job-1";
function seed() {
  Object.assign(store, { vendors: [], messages: [], quotes: [], approvals: [], events: [], replies: [] });
  store.jobs.clear();
  store.jobs.set(JOB, {
    id: JOB,
    short_code: "7F3K",
    status: "collecting",
    version: 1,
    round: 0,
    max_rounds: 1,
    collect_until: new Date(Date.now() + 60_000).toISOString(),
    event: { date: "2026-10-24", time: "18:30", headcount: 40, location: "x", dietary: [{ need: "vegetarian", count: 6 }] },
  });
  for (const [vid, name] of [["v-bb", "Budget Bites"], ["v-sol", "Taqueria Sol"], ["v-wok", "Golden Wok"]]) {
    store.vendors.push({ id: vid, job_id: JOB, name, email: `${vid}@x.test`, status: "contacted" });
  }
}
const vendorReply = (vendorId: string, perHead: number) =>
  store.messages.push({
    id: id("in"),
    job_id: JOB,
    vendor_id: vendorId,
    direction: "in",
    kind: "reply",
    provider_email_id: id("prim"),
    thread_id: `thr-${vendorId}`,
    subject: "Re: [QB-7F3K] quote",
    body_text: String(perHead),
    attachments: [],
    attachments_download_url: null,
    parse_status: "pending",
    created_at: new Date().toISOString(),
  });
const status = () => store.jobs.get(JOB)!.status;

describe("advanceJob lifecycle", () => {
  beforeEach(seed);

  it("collects, negotiates one round, then becomes ready", async () => {
    vendorReply("v-bb", 17.5);
    vendorReply("v-sol", 23.5);
    await advanceJob(JOB);
    expect(status()).toBe("collecting"); // Golden Wok hasn't replied and the window is open
    expect(store.quotes.filter((q) => q.is_current)).toHaveLength(2);

    // Window closes: 2 quotes and a round left -> negotiate.
    store.jobs.get(JOB)!.collect_until = new Date(Date.now() - 1000).toISOString();
    await advanceJob(JOB);
    expect(status()).toBe("negotiating");
    expect(store.vendors.find((v) => v.id === "v-wok")!.status).toBe("no_reply");
    // Only the more expensive vendor is countered, in its own thread, citing the real best price.
    expect(store.replies).toHaveLength(1);
    expect(store.replies[0]!.key).toBe("counter:v-sol:1");
    expect(store.replies[0]!.text).toContain("$17.50/person");
    expect(store.replies[0]!.text).not.toContain("Budget Bites");

    // Re-running does not send a second counteroffer.
    await advanceJob(JOB);
    expect(store.replies).toHaveLength(1);
    expect(status()).toBe("negotiating");

    // Taqueria Sol drops its price; every countered vendor answered -> ready.
    vendorReply("v-sol", 21);
    await advanceJob(JOB);
    expect(status()).toBe("ready");
    const sol = store.quotes.filter((q) => q.vendor_id === "v-sol");
    expect(sol.find((q) => q.is_current)!.price_per_head_cents).toBe(2100);
    expect(sol.find((q) => q.is_current)!.round).toBe(1);
  });

  it("expires with no quotes when the window closes", async () => {
    store.jobs.get(JOB)!.collect_until = new Date(Date.now() - 1000).toISOString();
    await advanceJob(JOB);
    expect(status()).toBe("expired");
  });

  it("goes straight to ready when everyone replied and only one quote is usable", async () => {
    vendorReply("v-bb", 18);
    store.vendors.find((v) => v.id === "v-sol")!.status = "bounced";
    store.vendors.find((v) => v.id === "v-wok")!.status = "declined";
    await advanceJob(JOB);
    expect(status()).toBe("ready");
    expect(store.replies).toHaveLength(0);
  });

  it("self-heals an approval decision the job missed", async () => {
    Object.assign(store.jobs.get(JOB)!, { status: "awaiting_approval" });
    store.approvals.push({ id: "ap-1", job_id: JOB, status: "approved", expires_at: new Date(Date.now() + 60_000).toISOString() });
    await advanceJob(JOB);
    expect(status()).toBe("approved");
  });

  it("expires an overdue approval and returns the job to ready", async () => {
    Object.assign(store.jobs.get(JOB)!, { status: "awaiting_approval" });
    store.approvals.push({ id: "ap-2", job_id: JOB, status: "pending", expires_at: new Date(Date.now() - 1000).toISOString() });
    await advanceJob(JOB);
    expect(status()).toBe("ready");
    expect(store.approvals[0]!.status).toBe("expired");
  });
});
