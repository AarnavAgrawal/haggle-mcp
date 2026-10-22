// Log redaction for payment details, message bodies and personal details (sprint 4, workstream F;
// live/log.ts). A business's payment instructions or a human's text can carry card, IBAN, account
// and routing numbers; message bodies, transcripts and attachments are dropped by field name (only
// their size is logged). Operator-review errors use the same patterns (deadLetter.redactError).
import { describe, expect, it } from "vitest";
import { createLogger, redact, redactError, redactText } from "../src/index.ts";

describe("payment details in free text", () => {
  it("masks Luhn-valid card numbers (spaced, dashed, plain) and leaves other long numbers", () => {
    const s = redactText("card 4242 4242 4242 4242, also 4000-0566-5566-5556 or 378282246310005; order 1234567890123 ref");
    expect(s).toBe("card [card], also [card] or [card]; order 1234567890123 ref");
  });

  it("masks IBANs and account / routing / sort-code numbers after their label", () => {
    const s = redactText("Wire to IBAN GB82 WEST 1234 5698 7654 32 or DE89370400440532013000. ACH: routing number 021000021, account # 000123456789; sort code 12-34-56, acct: 9876 5432");
    for (const leak of ["GB82", "WEST 1234", "DE8937", "021000021", "000123456789", "12-34-56", "9876 5432"]) expect(s).not.toContain(leak);
    expect(s).toMatch(/routing number \[redacted\]/);
    expect(s).toMatch(/account # \[redacted\]/);
  });

  it("keeps ordinary words after 'account', dates, amounts, ids and short codes", () => {
    expect(redactText("your account is under review; HG-7KQ2 $1,150.00 on 2026-10-22T10:00:00.000Z, job_abc123")).toBe("your account is under review; HG-7KQ2 $1,150.00 on 2026-10-22T10:00:00.000Z, job_abc123");
  });

  it("masks US social security numbers", () => {
    expect(redactText("SSN 123-45-6789")).toBe("SSN [ssn]");
  });
});

describe("fields dropped by name", () => {
  it("message bodies, texts, transcripts, payment instructions and attachments: only their size is logged", () => {
    const r = redact({
      job_id: "job_1", body_text: "Hi, pay to account 12345678, my home is 12 Elm St", bodyText: "x", html: "<p>x</p>", text: "YES 4821 call me", transcript: "Haggle: hi\nVendor: $1,150",
      instructions_text: "Zelle to me", attachments: [{ filename: "invoice.pdf" }], content_base64: "JVBERi0x", summary: "RFQ sent to Harbor Table",
    }) as Record<string, unknown>;
    expect(r).toEqual({
      job_id: "job_1", body_text: "[omitted: 49 chars]", bodyText: "[omitted: 1 chars]", html: "[omitted: 8 chars]", text: "[omitted: 16 chars]", transcript: "[omitted: 25 chars]",
      instructions_text: "[omitted: 11 chars]", attachments: "[omitted: 1 items]", content_base64: "[omitted: 8 chars]", summary: "RFQ sent to Harbor Table",
    });
  });

  it("payment-credential and personal fields by name, nested too", () => {
    const r = redact({ payment: { card_number: "4242424242424242", cvc: "123", iban: "GB82WEST12345698765432", account_number: "1", routing_number: "2" }, address: "12 Elm St", full_name: "Jane Doe" }) as Record<string, Record<string, unknown>>;
    expect(r.payment).toEqual({ card_number: "[redacted]", cvc: "[redacted]", iban: "[redacted]", account_number: "[redacted]", routing_number: "[redacted]" });
    expect(JSON.stringify(r)).not.toMatch(/Elm|Jane/);
  });

  it("end to end through the logger: a logged payment-instructions event leaks nothing", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (_l, line) => lines.push(line) });
    log.engine("payment_instructions_received", { job_id: "job_1", instructions_text: "IBAN GB82 WEST 1234 5698 7654 32", from: "billing@vendor.example", note: "card 4242424242424242 exp 12/30" });
    const out = lines.join("\n");
    for (const leak of ["GB82", "billing@vendor", "4242424242424242"]) expect(out).not.toContain(leak);
    expect(JSON.parse(lines[0]!)).toMatchObject({ job_id: "job_1", instructions_text: "[omitted: 32 chars]", from: "[email]" });
  });

  it("operator-review errors (redactError) mask payment details too", () => {
    const e = redactError(new Error("vendor said: pay 4242 4242 4242 4242 or routing 021000021 account 000123456789"));
    for (const leak of ["4242 4242", "021000021", "000123456789"]) expect(e).not.toContain(leak);
  });
});
