// PURE: the part of an inbound email body the business actually wrote this time. Quoted reply
// text (our own RFQ, earlier rounds) and mail footers are dropped before parsing, so a figure we
// sent can't be read back as the business's quote. The raw body is still stored for audit.
//
// Ported from haggle-testing src/comms/emailBody.ts.

const CUT_AT: RegExp[] = [
  /^on .+wrote:\s*$/i, // "On Tue, Oct 20, 2026 at 9:00 AM X wrote:"
  /^-{2,}\s*original message\s*-{2,}/i,
  /^-{2,}\s*forwarded message/i,
  /^_{5,}\s*$/, // Outlook separator
  /sent via inkbox/i,
];

export function cleanEmailBody(body: string): string {
  const out: string[] = [];
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (CUT_AT.some((re) => re.test(line.trim()))) break;
    if (line.trimStart().startsWith(">")) continue;
    out.push(line);
  }
  const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // A reply that starts with a quote marker (nothing written above it) keeps its raw body.
  return cleaned || body.trim();
}
