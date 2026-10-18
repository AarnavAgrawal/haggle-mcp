// Evidence from a business's own website: what the business says about itself (vendor claims).
//
// - Read-only GET of the home page (and /contact when linked), honouring robots.txt, https/http only,
//   public hosts only (no IP literals, localhost or private ranges), 4 s timeout, 400 KB cap, ≤3 redirects.
// - Website text is untrusted data: only fixed patterns are extracted (emails, phones, price phrases,
//   title/description); nothing in it is ever followed or obeyed.
// - A published price is an advertised claim ("from $25/person"), never a quote: nothing is binding
//   until the business confirms it to Haggle directly.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface WebsiteEvidence {
  url: string;
  fetched_at: string;
  status: "ok" | "robots_disallowed" | "blocked_host" | "unreachable" | "not_html";
  title?: string;
  description?: string;
  /** Addresses published on the site (mailto: or plain text on the business's own domain). */
  emails: string[];
  /** Phone numbers published on the site (tel: links), as printed. */
  phones: string[];
  /** Advertised prices with the sentence they came from. Claims, not quotes. */
  price_claims: { text: string; amount_usd: number; excerpt: string }[];
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

const MAX_BYTES = 400_000;
const UA = "HaggleBot/0.5 (+https://calm-spark-ck3qm.run.mcp-use.com/llms.txt; read-only business info)";

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) return /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip) || ip === "::";
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
}

/** True when the URL may be fetched: http(s), a public DNS name (resolved to public addresses). */
export async function publicUrl(u: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((x) => x.address)): Promise<URL | null> {
  let url: URL;
  try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (isIP(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return null;
  try {
    const addrs = await resolve(host);
    if (!addrs.length || addrs.some(privateAddress)) return null;
  } catch { return null; }
  return url;
}

/** robots.txt: is `path` disallowed for us (or for "*")? Missing/unreadable robots = allowed. */
export function robotsDisallows(robots: string, path: string): boolean {
  let applies = false;
  let matched = false;
  const rules: string[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [k, v] = [m[1]!.toLowerCase(), m[2]!.trim()];
    if (k === "user-agent") { if (matched && rules.length) break; applies = v === "*" || /hagglebot/i.test(v); matched ||= applies; }
    else if (k === "disallow" && applies && v) rules.push(v);
  }
  return rules.some((r) => path.startsWith(r));
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Pure: facts in a page's HTML that are safe to extract. */
export function extractWebsite(html: string, pageUrl: string): Omit<WebsiteEvidence, "url" | "fetched_at" | "status"> {
  const site = new URL(pageUrl).hostname.replace(/^www\./, "");
  const title = decode(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "") || undefined;
  const description = decode(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{1,400})["']/i.exec(html)?.[1] ?? /<meta[^>]+content=["']([^"']{1,400})["'][^>]*name=["']description["']/i.exec(html)?.[1] ?? "") || undefined;
  const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const emails = [...new Set([...html.matchAll(/mailto:([^"'?\s>]+@[^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]!).toLowerCase())
    .concat([...text.matchAll(/\b[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})\b/gi)].filter((m) => m[1]!.toLowerCase().replace(/^www\./, "").endsWith(site)).map((m) => m[0].toLowerCase())))]
    .filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)).slice(0, 5);
  const phones = [...new Set([...html.matchAll(/href=["']tel:([+\d().\s-]{7,20})["']/gi)].map((m) => m[1]!.trim()))].slice(0, 5);
  const price_claims: WebsiteEvidence["price_claims"] = [];
  for (const m of text.matchAll(/([^.!?]{0,80}?\b(?:from|starting at|starts at|as low as|only)\s+\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)(?:\s*(?:\/|per)\s*([a-z]+))?[^.!?]{0,60})/gi)) {
    const amount = Number(m[2]!.replace(/,/g, ""));
    if (!amount || price_claims.length >= 5) continue;
    price_claims.push({ text: `advertised from $${m[2]}${m[3] ? ` per ${m[3]}` : ""}`, amount_usd: amount, excerpt: m[1]!.trim().slice(0, 160) });
  }
  return { ...(title ? { title } : {}), ...(description ? { description } : {}), emails, phones, price_claims };
}

/** Fetch and extract a business website. Never throws: failures are a status. */
export async function websiteEvidence(url: string, opts: { fetch?: Fetch; resolve?: (host: string) => Promise<string[]>; now?: () => Date } = {}): Promise<WebsiteEvidence> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const empty = (status: WebsiteEvidence["status"]): WebsiteEvidence => ({ url, fetched_at: now, status, emails: [], phones: [], price_claims: [] });
  const doFetch: Fetch = opts.fetch ?? ((u, i) => fetch(u, i) as never);
  let target = await publicUrl(url, opts.resolve);
  if (!target) return empty("blocked_host");
  const get = async (u: URL) => {
    let cur = u;
    for (let hop = 0; hop < 4; hop++) {
      const res = await doFetch(cur.href, { method: "GET", headers: { "user-agent": UA, accept: "text/html,text/plain" }, redirect: "manual", signal: AbortSignal.timeout(4000) });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!loc) return { res, url: cur };
      const next = await publicUrl(new URL(loc, cur).href, opts.resolve);
      if (!next) return null;
      cur = next;
    }
    return null;
  };
  try {
    const robots = await get(new URL("/robots.txt", target)).catch(() => null);
    if (robots?.res.ok && robotsDisallows((await robots.res.text()).slice(0, 50_000), target.pathname || "/")) return empty("robots_disallowed");
    const page = await get(target);
    if (!page || !page.res.ok) return empty("unreachable");
    if (!/text\/html|text\/plain/i.test(page.res.headers.get("content-type") ?? "text/html")) return empty("not_html");
    target = page.url;
    const html = (await page.res.text()).slice(0, MAX_BYTES);
    return { url: target.href, fetched_at: now, status: "ok", ...extractWebsite(html, target.href) };
  } catch {
    return empty("unreachable");
  }
}
