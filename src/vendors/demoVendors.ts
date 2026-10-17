// PURE: the demo restaurants public users may contact (DESIGN.md §16:
// simulated vendors only). Configured as DEMO_VENDORS="Name <email>; Name <email>".

export interface DemoVendor {
  name: string;
  email: string;
}

/** Parse DEMO_VENDORS. Entries that aren't "Name <email>" are skipped. */
export function parseDemoVendors(raw: string | undefined): DemoVendor[] {
  if (!raw) return [];
  const out: DemoVendor[] = [];
  for (const part of raw.split(";")) {
    const m = part.trim().match(/^(.+?)\s*<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>$/);
    if (m) out.push({ name: m[1]!.trim(), email: m[2]!.toLowerCase() });
  }
  return out;
}

/** Vendor emails that are not on the list (empty when all are allowed). */
export function notAllowed(emails: string[], allowed: DemoVendor[]): string[] {
  const ok = new Set(allowed.map((v) => v.email));
  return emails.filter((e) => !ok.has(e.trim().toLowerCase()));
}
