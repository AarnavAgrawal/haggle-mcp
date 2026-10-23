// "Find businesses": the MCP discover tool's results, reduced to what the vendors page shows. Every
// field is plain text from a public listing; a link survives only as an http(s) URL. Finding a business
// never authorizes contacting it: the user adds it as a vendor, with its consent, first.
import type { DiscoverResult, FoundBusiness } from "./types.ts";

/** An http(s) URL, or undefined (javascript:, data:, relative and malformed links are dropped). */
export function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 2000) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const text = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The discover tool's structuredContent → this page's results. */
export function toDiscoverResult(data: Record<string, unknown>): DiscoverResult {
  const pub = (data.public_discovery ?? {}) as { status?: unknown; message?: unknown };
  const found = (Array.isArray(data.found) ? data.found : []).flatMap((f: Record<string, unknown>): FoundBusiness[] => {
    const name = text(f.name, 120);
    if (!name) return [];
    const rating = num(f.rating);
    const website = safeHttpUrl(f.website);
    const maps = safeHttpUrl(f.maps_url);
    const address = text(f.address);
    return [{
      name, business_ref: text(f.business_ref, 200) ?? name,
      ...(address ? { address } : {}), ...(rating !== undefined ? { rating, review_count: num(f.review_count) ?? 0 } : {}),
      ...(website ? { website } : {}), ...(maps ? { maps_url: maps } : {}),
      phone_published: f.phone_published === true,
      contact_state: text(f.contact_state, 40) ?? "discovered", contact_summary: text(f.contact_summary, 300) ?? "",
    }];
  });
  return { ok: true, mode: data.mode === "live" ? "live" : "mock", status: text(pub.status, 40) ?? "unknown", message: text(pub.message, 400) ?? "", found };
}

/** May Haggle contact this found business yet: only once it is one of this workspace's vendors. */
export function contactWords(f: FoundBusiness, isVendor: boolean): { label: string; tone: "win" | "warn" | "plain" } {
  if (isVendor || f.contact_state === "authorized" || f.contact_state === "verified_responsive") return { label: "Haggle may contact it", tone: "win" };
  return { label: "Not a vendor yet: Haggle won't contact it", tone: "plain" };
}
