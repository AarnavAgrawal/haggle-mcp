// Live page renderer (S2): vendor text is escaped, approval codes and the
// approver's address never reach the page, and the best quote is flagged.
// Also covers the shared secret check the page uses.
import { describe, expect, it } from "vitest";
import { esc, redact, renderJobFragment, renderPage, type JobSnapshot } from "../src/live/render.js";
import { secretMatches } from "../src/auth.js";
import type { ApprovalRow, JobRow, MessageRow, QuoteRow, VendorRow } from "../src/db/queries.js";

const T = "2026-10-17T20:00:00.000Z";

const job: JobRow = {
  id: "11111111-1111-1111-1111-111111111111",
  short_code: "7F3K",
  status: "awaiting_approval",
  version: 9,
  event: { date: "2026-10-24", time: "18:30", headcount: 40, location: "SF", dietary: [{ need: "vegetarian", count: 6 }] },
  budget_per_head_cents: 2500,
  max_rounds: 1,
  round: 1,
  collect_until: T,
  client_request_id: null,
  owner_id: null,
  created_at: T,
  updated_at: T,
};

const vendor = (id: string, name: string): VendorRow => ({
  id, job_id: job.id, name, email: `${id}@v.test`, channel: "email", status: "replied",
  outbound_email_id: null, outbound_message_id: null, thread_id: null, last_message_at: T,
});

const quote = (vendorId: string, perHead: number, over: Partial<QuoteRow> = {}): QuoteRow => ({
  id: `q-${vendorId}`, job_id: job.id, vendor_id: vendorId, source_message_id: `m-${vendorId}`, round: 0, is_current: true, created_at: T,
  available: true, price_per_head_cents: perHead, headcount: 40, subtotal_cents: perHead * 40, delivery_fee_cents: 0, tax_cents: 0,
  total_cents: perHead * 40, deposit_cents: 10000, menu_items: [], dietary_coverage: { vegetarian: true }, valid_until: null,
  missing_fields: [], confidence: 0.9, ...over,
});

const message = (over: Partial<MessageRow>): MessageRow => ({
  id: `m-${Math.random()}`, job_id: job.id, vendor_id: null, approval_id: null, direction: "in", kind: "reply", round: null,
  provider_email_id: null, rfc_message_id: null, thread_id: null, from_address: null, subject: null, body_text: null,
  attachments: [], attachments_download_url: null, sender_authenticated: true, parse_status: "done", created_at: T, ...over,
});

const approval: ApprovalRow = {
  id: "ap-1", job_id: job.id, quote_id: "q-bb", vendor_id: "bb", amount_cents: 10000, code: "4821", status: "pending",
  approver_email: "aarnav@example.com", outbound_email_id: null, outbound_message_id: null, thread_id: null,
  decision_message_id: null, requested_at: T, decided_at: null, expires_at: T,
};

function snapshot(over: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    job,
    vendors: [vendor("bb", "Budget Bites"), vendor("ts", "Taqueria Sol")],
    quotes: [quote("bb", 1800), quote("ts", 2200)],
    messages: [],
    approvals: [approval],
    payments: [],
    ...over,
  };
}

describe("esc", () => {
  it("escapes every HTML-significant character", () => {
    expect(esc(`<script>alert("x")</script>&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });
});

describe("redact", () => {
  it("removes the approval code and masks the approver address", () => {
    const text = "To approve, reply APPROVE 4821. Sent to Aarnav@Example.com";
    const out = redact(text, [approval]);
    expect(out).not.toContain("4821");
    expect(out.toLowerCase()).not.toContain("aarnav@example.com");
    expect(out).toContain("a***@example.com");
  });
});

describe("renderJobFragment", () => {
  it("escapes hostile vendor content instead of rendering it", () => {
    const html = renderJobFragment(
      snapshot({
        vendors: [vendor("bb", `<img src=x onerror=alert(1)>`)],
        messages: [message({ vendor_id: "bb", subject: `<b>hi</b>`, body_text: `</pre><script>steal()</script>` })],
      }),
    );
    expect(html).not.toContain("<script>steal()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;steal()");
  });

  it("never shows the approval code, even in our own approval email", () => {
    const html = renderJobFragment(
      snapshot({
        messages: [
          message({ direction: "out", kind: "approval_request", subject: "Approve $100 [QB-7F3K]", body_text: "Reply with: APPROVE 4821" }),
          message({ kind: "approval_reply", from_address: "aarnav@example.com", body_text: "APPROVE 4821" }),
        ],
      }),
    );
    expect(html).not.toContain("4821");
    expect(html).not.toContain("aarnav@example.com");
  });

  it("flags the cheapest eligible quote as best", () => {
    const html = renderJobFragment(snapshot());
    const bestRow = html.split("<tr").find((r) => r.includes('class="best"'))!;
    expect(bestRow).toContain("Budget Bites");
    expect(bestRow).toContain("$720.00");
  });

  it("does not flag a quote that misses a dietary need", () => {
    const html = renderJobFragment(snapshot({ quotes: [quote("bb", 1800, { dietary_coverage: { vegetarian: false } }), quote("ts", 2200)] }));
    const bestRow = html.split("<tr").find((r) => r.includes('class="best"'))!;
    expect(bestRow).toContain("Taqueria Sol");
  });

  it("shows the payment once charged", () => {
    const html = renderJobFragment(
      snapshot({
        job: { ...job, status: "paid" },
        approvals: [{ ...approval, status: "used" }],
        payments: [{ id: "p1", job_id: job.id, approval_id: "ap-1", amount_cents: 10000, stripe_payment_intent_id: "pi_123", status: "succeeded", idempotency_key: "k", created_at: T }],
      }),
    );
    expect(html).toContain("Charged");
    expect(html).toContain("pi_123");
  });
});

describe("renderPage", () => {
  it("puts the nonce on the inline script and escapes the refresh URL", () => {
    const html = renderPage({ title: "t", body: "", nonce: "abc123", refreshUrl: "/live/x?token=</script>" });
    expect(html).toContain('<script nonce="abc123">');
    expect(html).not.toContain("token=</script>");
  });
});

describe("secretMatches", () => {
  it("matches raw and Bearer forms, rejects others, and is closed when unset", () => {
    expect(secretMatches("s3cret-value-long", "s3cret-value-long")).toBe(true);
    expect(secretMatches("Bearer s3cret-value-long", "s3cret-value-long")).toBe(true);
    expect(secretMatches("wrong", "s3cret-value-long")).toBe(false);
    expect(secretMatches(undefined, "s3cret-value-long")).toBe(false);
    expect(secretMatches("", undefined)).toBe(false);
  });
});
