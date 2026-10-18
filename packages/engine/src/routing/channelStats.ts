// PURE: what Haggle has observed about reaching one business, per channel, across all its jobs, and
// which authorized channel to use next.
//
// Evidence, strongest first: a preference the business stated in its own words ("text me instead"),
// then observed performance (did it reply, how fast, did a quote come back). Small samples don't count:
// a channel needs at least MIN_SAMPLE contacts before its record can override the default order, and
// a "listed" channel is never treated as a "preferred" one. Only channels the caller says are
// available (authorized + enabled) can be chosen.
import type { Channel } from "../store/types.ts";
import type { MessageRow, QuoteRow } from "../store/types.ts";

export const MIN_SAMPLE = 2;

export interface ChannelRecord {
  contacted_jobs: number;
  replied_jobs: number;
  quotes: number;
  response_rate: number; // replied / contacted
  median_reply_minutes?: number;
  /** 0..1: how much this record can be trusted (sample size). */
  confidence: number;
}

export interface ContactLearning {
  channels: Partial<Record<Channel, ChannelRecord>>;
  stated_preference?: { channel: Channel; excerpt: string; at: string };
}

const OUT_KINDS = new Set(["rfq", "call", "followup", "counter", "answer"]);

export function learnContact(messages: MessageRow[], quotes: QuoteRow[]): ContactLearning {
  const byChannel = new Map<Channel, { jobs: Set<string>; replied: Set<string>; minutes: number[]; quotes: number }>();
  const get = (c: Channel) => byChannel.get(c) ?? (byChannel.set(c, { jobs: new Set(), replied: new Set(), minutes: [], quotes: 0 }), byChannel.get(c)!);
  const firstOut = new Map<string, number>(); // job:channel -> first outbound time
  for (const m of [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!m.job_id || !m.channel) continue;
    const ch = m.channel as Channel;
    const key = `${m.job_id}:${ch}`;
    if (m.direction === "out" && OUT_KINDS.has(m.kind)) {
      get(ch).jobs.add(m.job_id);
      if (!firstOut.has(key)) firstOut.set(key, Date.parse(m.created_at));
    } else if (m.direction === "in" && m.kind === "reply" && m.sender_trusted) {
      const r = get(ch);
      if (!r.replied.has(m.job_id) && firstOut.has(key)) r.minutes.push((Date.parse(m.created_at) - firstOut.get(key)!) / 60_000);
      r.replied.add(m.job_id);
    }
  }
  const msgChannel = new Map(messages.map((m) => [m.id, m.channel as Channel]));
  for (const q of quotes) if (q.total_cents !== null && q.sender_trusted) { const ch = msgChannel.get(q.message_id); if (ch) get(ch).quotes++; }
  const channels: ContactLearning["channels"] = {};
  for (const [ch, r] of byChannel) {
    if (r.jobs.size === 0) continue;
    const mins = [...r.minutes].sort((a, b) => a - b);
    channels[ch] = {
      contacted_jobs: r.jobs.size, replied_jobs: [...r.replied].filter((j) => r.jobs.has(j)).length, quotes: r.quotes,
      response_rate: Math.round(([...r.replied].filter((j) => r.jobs.has(j)).length / r.jobs.size) * 100) / 100,
      ...(mins.length ? { median_reply_minutes: Math.round(mins[Math.floor(mins.length / 2)]!) } : {}),
      confidence: Math.round((r.jobs.size / (r.jobs.size + 3)) * 100) / 100,
    };
  }
  const pref = [...quotes].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((q) => ({ p: q.record.preferred_contact, at: q.created_at })).find((x) => x.p);
  return { channels, ...(pref?.p ? { stated_preference: { channel: pref.p.channel, excerpt: pref.p.excerpt, at: pref.at } } : {}) };
}

/** The channel to use among those available, with the reason; `fallback` is the default routing choice. */
export function chooseChannel(available: Channel[], fallback: Channel, learning: ContactLearning | null): { channel: Channel; reason: string | null } {
  if (!learning || available.length < 2) return { channel: fallback, reason: null };
  const p = learning.stated_preference;
  if (p && available.includes(p.channel) && p.channel !== fallback) return { channel: p.channel, reason: `the business asked for ${label(p.channel)}: "${p.excerpt.slice(0, 80)}"` };
  const d = learning.channels[fallback];
  const better = available
    .filter((c) => c !== fallback)
    .map((c) => ({ c, r: learning.channels[c] }))
    .filter((x): x is { c: Channel; r: ChannelRecord } => !!x.r && x.r.contacted_jobs >= MIN_SAMPLE && x.r.response_rate >= 0.5)
    .sort((a, b) => b.r.response_rate - a.r.response_rate || (a.r.median_reply_minutes ?? 1e9) - (b.r.median_reply_minutes ?? 1e9))[0];
  if (better && d && d.contacted_jobs >= MIN_SAMPLE && d.response_rate + 0.3 <= better.r.response_rate) {
    return { channel: better.c, reason: `${label(better.c)} answered ${better.r.replied_jobs} of ${better.r.contacted_jobs} times vs ${label(fallback)} ${d.replied_jobs} of ${d.contacted_jobs}` };
  }
  return { channel: fallback, reason: null };
}

function label(c: Channel): string {
  return c === "imessage" ? "text" : c === "a2a" ? "A2A" : c;
}
