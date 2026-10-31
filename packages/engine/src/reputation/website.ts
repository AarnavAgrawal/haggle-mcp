// Evidence from a business's own website: what the business says about itself (vendor claims).
//
// - Read-only GET of the home page (and /contact when linked), honouring robots.txt, https/http only,
//   public hosts only (no IP literals, localhost or private ranges), 4 s timeout, 400 KB cap, ≤3 redirects.
// - Website text is untrusted data: only fixed patterns are extracted (emails, phones, price phrases,
//   title/description, schema.org opening hours); nothing in it is ever followed or obeyed.
// - A published price is an advertised claim ("from $25/person"), never a quote: nothing is binding
//   until the business confirms it to Haggle directly.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { websiteHours, type WeeklyHours } from "./hours.ts";

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
  /** Opening hours the site publishes as schema.org data (JSON-LD or microdata); no timezone of their own. */
  hours?: WeeklyHours;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

const MAX_BYTES = 400_000;
const UA = "HaggleBot/0.5 (+https://calm-spark-ck3qm.run.mcp-use.com/llms.txt; read-only business info)";

/** Loopback, private, CGNAT, link-local, benchmark (198.18/15), documentation, multicast and reserved (224/3). */
function privateV4(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

/** An IPv6 address as its 8 16-bit groups (a trailing dotted IPv4 folded into the last two). */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) { const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]; s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = s.includes("::") ? s.split("::") as [string, string] : [s, null];
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  return [...h, ...Array(tail === null ? 0 : 8 - h.length - t.length).fill("0"), ...t].map((x) => parseInt(x || "0", 16));
}

function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) { const [a, b, c] = ip.split(".").map(Number) as [number, number, number]; return privateV4(a, b, c); }
  if (v !== 6) return true; // not an address: never connect
  const g = v6Groups(ip);
  const embedded = (hi: number, lo: number) => privateV4(hi >> 8, hi & 0xff, lo >> 8);
  // ::/96 (incl. :: and ::1) and IPv4-mapped ::ffff:0:0/96: judged by the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return embedded(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  // ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, documentation 2001:db8::/32.
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0 || (g[0]! & 0xff00) === 0xff00 || (g[0] === 0x2001 && g[1] === 0xdb8);
}

const systemResolve = async (h: string) => (await lookup(h, { all: true })).map((x) => x.address);

/** True when the URL may be fetched: http(s), a public DNS name (resolved to public addresses). */
export async function publicUrl(u: string, resolve: (host: string) => Promise<string[]> = systemResolve): Promise<URL | null> {
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

/**
 * A connect-time DNS lookup that refuses private addresses. publicUrl's check alone is not enough: a
 * second resolution by fetch could return another address (DNS rebinding); with this lookup the
 * address checked is the address connected to, on every request and redirect hop.
 */
export function guardedLookup(resolve: (host: string) => Promise<string[]> = systemResolve): LookupFunction {
  return (host, options, cb) => {
    const done = cb as (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;
    resolve(host).then((addrs) => {
      const fam = (options as { family?: number | string }).family;
      const want = fam === 4 || fam === "IPv4" ? 4 : fam === 6 || fam === "IPv6" ? 6 : 0;
      if (!addrs.length || addrs.some(privateAddress)) return done(Object.assign(new Error(`blocked address for ${host}`), { code: "EHOSTBLOCKED" }));
      const all = addrs.map((address) => ({ address, family: isIP(address) })).filter((a) => !want || a.family === want);
      if (!all.length) return done(Object.assign(new Error(`no usable address for ${host}`), { code: "ENOTFOUND" }));
      if ((options as { all?: boolean }).all) done(null, all);
      else done(null, all[0]!.address, all[0]!.family);
    }, (e: Error) => done(e));
  };
}

/** The default Fetch: node:http(s) through guardedLookup, no redirects followed, body read up to MAX_BYTES. */
export function pinnedFetch(resolve?: (host: string) => Promise<string[]>): Fetch {
  const lookup = guardedLookup(resolve);
  return (u, init) => new Promise((ok, fail) => {
    const url = new URL(u);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: init.method, headers: { ...init.headers, "accept-encoding": "identity" }, lookup, agent: false, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { if (size < MAX_BYTES) { chunks.push(c); size += c.length; } else res.destroy(); });
      res.on("error", fail);
      res.on("close", () => {
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString("utf8");
        ok({ ok: status >= 200 && status < 300, status, headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v); } }, text: async () => body });
      });
    });
    req.on("error", fail);
    req.end();
  });
}

/** robots.txt: is `path` disallowed for us (or for "*")? Missing/unreadable robots = allowed. */
export function robotsDisallows(robots: string, path: string): boolean {
  let applies = false;
  let matched = false;
  let inAgents = false; // consecutive User-agent lines name one group: they OR together
  const rules: string[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [k, v] = [m[1]!.toLowerCase(), m[2]!.trim()];
    if (k === "user-agent") {
      if (!inAgents) { if (matched && rules.length) break; applies = false; }
      const hit = v === "*" || /hagglebot/i.test(v);
      applies ||= hit;
      matched ||= hit;
      inAgents = true;
    } else {
      inAgents = false;
      if (k === "disallow" && applies && v) rules.push(v);
    }
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
  const hours = websiteHours(html);
  return { ...(title ? { title } : {}), ...(description ? { description } : {}), emails, phones, price_claims, ...(hours ? { hours } : {}) };
}

/** Fetch and extract a business website. Never throws: failures are a status. */
export async function websiteEvidence(url: string, opts: { fetch?: Fetch; resolve?: (host: string) => Promise<string[]>; now?: () => Date } = {}): Promise<WebsiteEvidence> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const empty = (status: WebsiteEvidence["status"]): WebsiteEvidence => ({ url, fetched_at: now, status, emails: [], phones: [], price_claims: [] });
  // The default fetch re-checks every address at connect time (DNS rebinding), redirect hops included.
  const doFetch: Fetch = opts.fetch ?? pinnedFetch(opts.resolve);
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
