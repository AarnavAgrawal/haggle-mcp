// The deal board's one-line call excerpt: what the business said (its priced line if any), not
// Haggle's own opening. Live Inkbox transcripts label the callee "remote"; the board shows its name.
const MAX = 200;
/** A money figure, typed ("$1,070") or spoken ("six thousand dollars", "1200 bucks"). */
const PRICED = /\$\s?\d|\b\d[\d,.]*\s*(dollars|bucks)\b|\b(hundred|thousand|grand)\b[^.]*\b(dollars|bucks)\b|\b(\d+|hundred|thousand)\s+grand\b/i;

export function transcriptSnippet(transcript: string, businessName: string): string {
  const lines = transcript.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const parsed = lines.map((l) => {
    const m = l.match(/^([^:]{1,60}):\s*(.*)$/);
    return m ? { speaker: m[1]!.trim(), text: m[2]!.trim() } : { speaker: "", text: l };
  });
  // Inkbox labels Haggle's own Voice AI turns "local" in inline webhook transcripts.
  const isHaggle = (s: string) => /^(haggle\b|local$)/i.test(s);
  // Phone screening / voicemail prompts are the callee's line on paper but not what the business said.
  const screening = (t: string) => /record your name|reason for (your )?call|leave (a|your) message|after the (tone|beep)|is not available|voicemail/i.test(t);
  const theirs = parsed.filter((p) => p.speaker && !isHaggle(p.speaker) && p.text && !screening(p.text));
  const pick = theirs.find((p) => PRICED.test(p.text)) ?? theirs[0] ?? parsed.find((p) => !screening(p.text)) ?? parsed[0]!;
  const speaker = !pick.speaker ? "" : /^(remote|callee|caller)$/i.test(pick.speaker) ? businessName : pick.speaker;
  return clip(speaker ? `${speaker}: ${pick.text}` : pick.text);
}

function clip(s: string): string {
  if (s.length <= MAX) return s;
  const cut = s.slice(0, MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/**
 * One line of what a business wrote (email, iMessage, A2A): its first priced line, else (unless
 * `pricedOnly`) its first line. Links are removed: business text is untrusted data for display only.
 */
export function messageSnippet(text: string | null | undefined, opts: { pricedOnly?: boolean } = {}): string {
  const lines = (text ?? "").split("\n").map((l) => l.replace(/https?:\/\/\S+|www\.\S+/gi, "[link removed]").trim()).filter((l) => l && !/^>/.test(l));
  const pick = lines.find((l) => /\$\s?\d/.test(l)) ?? (opts.pricedOnly ? undefined : lines[0]);
  return pick ? clip(pick) : "";
}
