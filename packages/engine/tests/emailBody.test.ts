// cleanEmailBody: client quote layouts are cut, a vendor's own text never is.
import { describe, expect, it } from "vitest";
import { cleanEmailBody } from "../src/inbound/emailBody.ts";

const RFQ = "Hi Real Caterer,\n- Budget: up to $2000.00 total\nReference: HGR-AAAAAAAAAA";
const OWN = "Yes: $1,150 total, delivered.\nMaria";

describe("cleanEmailBody cuts quoted history", () => {
  const cases: Record<string, string> = {
    "Outlook header block, no separator": `${OWN}\n\nFrom: Haggle <haggle@inkboxmail.test>\nSent: Thursday, October 22, 2026 10:15 AM\nTo: orders@x.example\nSubject: Quote request\n\n${RFQ}`,
    "Outlook header block with Cc, display names only": `${OWN}\n\nFrom: Haggle\nSent: Thursday, October 22, 2026 10:15 AM\nTo: Maria Lopez\nCc: Ops\nSubject: Quote request\n\n${RFQ}`,
    "Outlook bold headers (plain-text rendering)": `${OWN}\n\n*From:* Haggle <haggle@inkboxmail.test>\n*Sent:* Thursday, October 22, 2026 10:15 AM\n*To:* orders@x.example\n*Subject:* Quote request\n\n${RFQ}`,
    "Outlook French headers": `${OWN}\n\nDe : Haggle <haggle@inkboxmail.test>\nEnvoyé : jeudi 22 octobre 2026 10:15\nÀ : orders@x.example\nObjet : Quote request\n\n${RFQ}`,
    "Outlook German headers": `${OWN}\n\nVon: Haggle <haggle@inkboxmail.test>\nGesendet: Donnerstag, 22. Oktober 2026 10:15\nAn: orders@x.example\nBetreff: Quote request\n\n${RFQ}`,
    "bare forwarded block From/Date/Subject/To": `${OWN}\n\nFrom: Haggle <haggle@inkboxmail.test>\nDate: Thu, Oct 22, 2026 at 10:15 AM\nSubject: Quote request\nTo: <orders@x.example>\n\n${RFQ}`,
    "Gmail forwarded-message separator": `${OWN}\n\n---------- Forwarded message ---------\nFrom: Haggle <haggle@inkboxmail.test>\n\n${RFQ}`,
    "Gmail attribution wrapped over two lines": `${OWN}\n\nOn Thu, Oct 22, 2026 at 10:15 AM Haggle AI Buyer Assistant <\nhaggle@inkboxmail.test> wrote:\n\n${RFQ}`,
    "Gmail attribution wrapped over three lines": `${OWN}\n\nOn Thu, Oct 22, 2026 at 10:15 AM Haggle AI Buyer Assistant for\nthe customer <haggle@inkboxmail.test>\nwrote:\n\n${RFQ}`,
    "Gmail attribution on one line": `${OWN}\n\nOn Thu, Oct 22, 2026 at 10:15 AM Haggle <haggle@inkboxmail.test> wrote:\n\n${RFQ}`,
    "Outlook ____ separator": `${OWN}\n\n________________________________\nFrom: Haggle\n\n${RFQ}`,
    "Inkbox footer": `${OWN}\n\n--\nSent via Inkbox\n${RFQ}`,
  };
  for (const [name, body] of Object.entries(cases)) {
    it(name, () => {
      const c = cleanEmailBody(body);
      expect(c).toContain("$1,150 total");
      expect(c).not.toMatch(/\$2000|HGR-/);
    });
  }
  it("bottom-posted reply: attribution and '>' quote first, the business's words below", () => {
    const body = `On Thu, Oct 22, 2026 at 10:15 AM Haggle <haggle@inkboxmail.test> wrote:\n> ${RFQ.split("\n").join("\n> ")}\n> Could you quote the following?\n\n${OWN}\n`;
    expect(cleanEmailBody(body)).toBe(OWN);
    const wrapped = `On Thu, Oct 22, 2026 at 10:15 AM Haggle AI Buyer <\nhaggle@inkboxmail.test> wrote:\n> ${RFQ.split("\n").join("\n> ")}\n\n${OWN}\n\n--\nSent via Inkbox`;
    expect(cleanEmailBody(wrapped)).toBe(OWN);
  });
  it("'>' quoted lines are dropped wherever they are", () => {
    expect(cleanEmailBody(`${OWN}\n> ${RFQ.replace(/\n/g, "\n> ")}`)).toBe(OWN);
  });
});

describe("cleanEmailBody never cuts a vendor's own words", () => {
  const keep: Record<string, string> = {
    "'From:' in prose": "From: our kitchen to your door in 30 minutes.\nTo: confirm, just reply yes.\n$1,150 total.",
    "a vendor's labelled quote (dates, no clock time, no address)": "Here is our quote.\n\nFrom: Maria's Kitchen\nDate: Saturday Oct 24, 2026\nTo: Haggle\nSubject: Lunch for 40\nTotal: $1,150 total",
    "'On …' sentence followed by 'we wrote:' without an address": "On Saturday we can deliver at 11.\nAs we wrote:\n$1,150 total.",
    "'On …' sentence that wraps but never says wrote": "On Friday the 23rd we are closed,\nbut Saturday works.\n$1,150 total.",
    "a Q&A style reply": "Q: Can you do vegetarian?\nA: Yes, 12 meals.\nFrom: 11am\nTo: 1pm\n$1,150 total.",
  };
  for (const [name, body] of Object.entries(keep)) {
    it(name, () => expect(cleanEmailBody(body)).toBe(body));
  }
  it("a reply with nothing above the quote keeps its raw body (never empty)", () => {
    const body = `From: Haggle <haggle@inkboxmail.test>\nSent: Thursday, October 22, 2026 10:15 AM\nTo: x@y.example\nSubject: s\n\n${RFQ}`;
    expect(cleanEmailBody(body)).toBe(body);
  });
});
