/**
 * "Name <email>; Name <email>" -> demo fleet entries for discover (quote-broker DEMO_VENDORS format).
 * A bare address ("golden-grill-sf@inkboxmail.com") is accepted too, named after its local part,
 * so a fleet entry is never silently dropped from the recipient allowlist. ',' also separates.
 */
export function parseFleet(spec: string | undefined): { name: string; email: string }[] {
  if (!spec) return [];
  return spec.split(/[;,]/).map((s) => s.trim()).filter(Boolean).flatMap((s) => {
    const m = s.match(/^(.+?)\s*<([^>]+@[^>]+)>$/);
    if (m) return [{ name: m[1]!.trim(), email: m[2]!.trim().toLowerCase() }];
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) {
      const local = s.split("@")[0]!;
      return [{ name: local.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), email: s.toLowerCase() }];
    }
    return [];
  });
}
