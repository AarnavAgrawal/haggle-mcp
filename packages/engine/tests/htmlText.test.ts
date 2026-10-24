// HTML-only mail: htmlToText, and inkboxToInbound using it only when there is no text part.
import { describe, expect, it } from "vitest";
import { cleanEmailBody, decodeEntities, htmlToText, inkboxToInbound, type InkboxMessageDetail } from "../src/index.ts";

const detail = (o: Partial<InkboxMessageDetail>): InkboxMessageDetail => ({
  id: "in_1", threadId: "t", messageId: "<a@x>", fromAddress: "v@x.example", toAddresses: ["haggle@inkboxmail.test"], subject: "Re: q", bodyText: null, inReplyTo: null, references: null, attachmentMetadata: null, ...o,
});

describe("htmlToText", () => {
  it("drops scripts, styles, comments and head with their content; keeps text and line structure", () => {
    const t = htmlToText(`<html><head><title>T</title><style>p{color:red}</style></head><body><script>alert("$9 total")</script><!-- $8 total --><p>Hi,</p><p>We can do it: <b>$1,150&nbsp;total</b>.</p><div>Thanks<br>Maria</div></body></html>`);
    expect(t).toBe("Hi,\nWe can do it: $1,150 total.\nThanks\nMaria");
  });
  it("decodes entities (named, decimal, hex) and never turns escaped markup back into tags", () => {
    expect(decodeEntities("&lt;b&gt; &amp; &#36;5 &#x24;6 &rsquo; &bogus; &#0;")).toBe("<b> & $5 $6 ’ &bogus; ");
    expect(htmlToText("<p>&lt;script&gt;x&lt;/script&gt;</p>")).toBe("<script>x</script>");
  });
  it("turns blockquotes into '>' lines so quoted history is cut like plain text", () => {
    const html = `<div dir="ltr">Yes: $1,150 total.</div><br><div class="gmail_quote"><div class="gmail_attr">On Thu, Oct 22, 2026 at 10:15 AM Haggle &lt;haggle@inkboxmail.test&gt; wrote:<br></div><blockquote class="gmail_quote"><div>Budget: up to $2000.00 total</div><blockquote>older</blockquote></blockquote></div>`;
    const t = htmlToText(html);
    expect(t).toContain("> Budget: up to $2000.00 total");
    expect(t).toContain("> > older");
    expect(cleanEmailBody(t)).toBe("Yes: $1,150 total.");
  });
  it("Outlook HTML (header block in bold) is cut by the header-block rule", () => {
    const html = `<div>Yes: $1,150 total.</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>From:</b> Haggle &lt;haggle@inkboxmail.test&gt;<br><b>Sent:</b> Thursday, October 22, 2026 10:15 AM<br><b>To:</b> orders@x.example<br><b>Subject:</b> Quote request</div><div>Budget: up to $2000.00 total</div>`;
    expect(cleanEmailBody(htmlToText(html))).toBe("Yes: $1,150 total.");
  });
  it("keeps link targets visible (a payment link can't hide behind its label); lists and tables stay readable", () => {
    expect(htmlToText(`<p>Pay the deposit <a href="https://pay.example/x?a=1&amp;b=2">here</a>.</p>`)).toBe("Pay the deposit here (https://pay.example/x?a=1&b=2).");
    expect(htmlToText(`<ul><li>Lunch</li><li>Delivery</li></ul><table><tr><td>Total</td><td>$1,150</td></tr></table>`)).toBe("- Lunch\n- Delivery\nTotal $1,150");
  });
  it("is safe on hostile input: '<' as text, unterminated tags, huge input", () => {
    expect(htmlToText("a < b and 3<4")).toBe("a < b and 3<4");
    expect(htmlToText("ok <div unterminated")).toBe("ok");
    const started = Date.now();
    htmlToText("<".repeat(200_000) + "<a".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("inkboxToInbound body selection", () => {
  const p = { id: "evt", event_type: "message.received" };
  it("uses the text part when there is one", () => {
    expect(inkboxToInbound(p, detail({ bodyText: "plain $5 total", bodyHtml: "<p>html $6 total</p>" })).bodyText).toBe("plain $5 total");
  });
  it("derives text from HTML when the text part is null or blank", () => {
    expect(inkboxToInbound(p, detail({ bodyText: null, bodyHtml: "<p>html $6 total</p>" })).bodyText).toBe("html $6 total");
    expect(inkboxToInbound(p, detail({ bodyText: "  \n", bodyHtml: "<p>html $6 total</p>" })).bodyText).toBe("html $6 total");
  });
  it("leaves the body null when there is neither", () => {
    expect(inkboxToInbound(p, detail({ bodyText: null, bodyHtml: null })).bodyText).toBeNull();
  });
});
