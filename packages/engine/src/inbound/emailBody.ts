// PURE: the part of an inbound email body the business actually wrote this time. Quoted reply
// text (our own RFQ, earlier rounds) and mail footers are dropped before parsing, so a figure we
// sent can't be read back as the business's quote. The raw body is still stored for audit.
//
// Ported from haggle-testing src/comms/emailBody.ts. Client layouts handled (simulated shapes in
// tests/realClientReplies.test.ts): Gmail "On … wrote:" (also wrapped over two or three lines),
// Outlook "-----Original Message-----" / "____" separator / a bare From:-Sent:-To:-Subject: header
// block (new Outlook, Outlook web), Gmail "Forwarded message" and bare From:-Date:-Subject:-To:
// blocks, Apple Mail "> On … wrote:" and the Inkbox footer.

const CUT_AT: RegExp[] = [
  /^on .+wrote:\s*$/i, // "On Tue, Oct 20, 2026 at 9:00 AM X wrote:"
  /^-{2,}\s*original message\s*-{2,}/i,
  /^-{2,}\s*forwarded message/i,
  /^_{5,}\s*$/, // Outlook separator
  /sent via inkbox/i,
];

// A quoted header line: "From: …", "*Sent:* …" (bold in some plain-text renderings), localized names.
const HEADER = /^\*{0,2}\s*(from|sent|date|to|cc|subject|de|von|envoyé|gesendet|enviado|datum|para|à|an|objet|betreff|asunto|oggetto|inviato|da|a)\s*:\s*\*{0,2}\s*(\S.*)?$/i;
const HEADER_NAME: Record<string, "from" | "date" | "to" | "subject" | "cc"> = {
  from: "from", de: "from", von: "from", da: "from",
  sent: "date", date: "date", envoyé: "date", gesendet: "date", enviado: "date", datum: "date", inviato: "date",
  to: "to", para: "to", à: "to", an: "to", a: "to",
  subject: "subject", objet: "subject", betreff: "subject", asunto: "subject", oggetto: "subject",
  cc: "cc",
};

const headerName = (line: string) => {
  const m = line.trim().match(HEADER);
  return m ? HEADER_NAME[m[1]!.toLowerCase()] ?? null : null;
};

/**
 * Does a quoted message's header block start at line i? A From: line followed directly (no other
 * lines between) by a date line (Sent:/Date:) and a To: or Subject: line, where the From: names an
 * address or the date line carries a clock time (clients always write both; "Date: Oct 24" in a
 * vendor's own labelled quote doesn't). Prose like "From: our kitchen to your door" has no date line.
 */
function headerBlockAt(lines: string[], i: number): boolean {
  if (headerName(lines[i]!) !== "from") return false;
  const seen = new Set<string>(["from"]);
  let timed = false;
  for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
    const name = headerName(lines[j]!);
    if (!name) break;
    seen.add(name);
    if (name === "date" && /\b\d{1,2}:\d{2}\b/.test(lines[j]!)) timed = true;
  }
  return seen.has("date") && (seen.has("to") || seen.has("subject")) && (timed || /@/.test(lines[i]!));
}

/**
 * Gmail wraps a long attribution in the plain-text part: "On Thu, … Haggle AI Buyer <\nhaggle@x> wrote:".
 * Joined with the next one or two lines, it must read "On … wrote:" and name an address.
 */
function wrappedAttributionAt(lines: string[], i: number): boolean {
  if (!/^on\s/i.test(lines[i]!.trim()) || /wrote:\s*$/i.test(lines[i]!)) return false;
  let joined = lines[i]!.trim();
  for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
    if (!lines[j]!.trim()) return false;
    joined += ` ${lines[j]!.trim()}`;
    if (/wrote:\s*$/i.test(joined)) return joined.length <= 300 && /@/.test(joined) && CUT_AT[0]!.test(joined);
  }
  return false;
}

/** The unquoted text after an attribution at line i and its '>' block, up to the next quote marker; "" if none. */
function bottomPosted(lines: string[], i: number): string {
  let j = i;
  while (j < lines.length && !/wrote:\s*$/i.test(lines[j]!)) j++; // the attribution may wrap
  const own: string[] = [];
  let sawQuote = false;
  for (j = j + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.trimStart().startsWith(">")) { sawQuote = true; continue; }
    if (/^--\s*$/.test(l.trim()) || CUT_AT.some((re) => re.test(l.trim())) || headerBlockAt(lines, j) || wrappedAttributionAt(lines, j)) break; // "--": the signature
    own.push(l);
  }
  return sawQuote ? own.join("\n").replace(/\n{3,}/g, "\n\n").trim() : "";
}

export function cleanEmailBody(body: string): string {
  const out: string[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cut = CUT_AT.some((re) => re.test(line.trim())) || headerBlockAt(lines, i) || wrappedAttributionAt(lines, i);
    if (cut && !out.some((l) => l.trim()) && (CUT_AT[0]!.test(line.trim()) || wrappedAttributionAt(lines, i))) {
      // Bottom-posted: "On … wrote:" first, the '>' quote, then the business's own words below it.
      const below = bottomPosted(lines, i);
      if (below) return below;
    }
    if (cut) break;
    if (line.trimStart().startsWith(">")) continue;
    out.push(line);
  }
  const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // A reply that starts with a quote marker (nothing written above it) keeps its raw body.
  return cleaned || body.trim();
}
