// Prints the environment manifest (src/envManifest.ts) as the Markdown table in docs/env-manifest.md.
// Reads no environment and no file: names, purposes and rules only, never a value.
//
//   npx tsx apps/mcp/scripts/env-manifest.ts > /tmp/table.md   (then paste between the markers)
//   apps/mcp/tests/envManifest.test.ts fails when the doc's table differs from this output.
import { ENV_MANIFEST, type EnvVarSpec, type Need } from "../src/envManifest.ts";

const esc = (s: string) => s.replace(/\|/g, "\\|");

function rule(s: EnvVarSpec): string {
  const r = s.rule;
  const base = r.kind === "enum" ? r.values.map((v) => `\`${v}\``).join(" \\| ")
    : r.kind === "bool" ? "`true` \\| `false`"
    : r.kind === "posInt" ? (r.allowZero ? "integer ≥ 0" : "integer > 0")
    : r.kind === "intRange" ? `integer ${r.min}–${r.max}`
    : r.kind === "posNumber" ? "number > 0"
    : r.kind === "httpsUrl" ? "`https://` URL"
    : r.kind === "url" ? "http(s) URL"
    : r.kind === "postgresUrl" ? "`postgres://` URL"
    : r.kind === "minLength" ? `≥ ${r.min} characters`
    : r.kind === "pattern" ? esc(r.describe)
    : r.kind === "json" ? "JSON"
    : r.kind === "timezone" ? "IANA time zone" : "free text";
  return `${base}${s.conditional ? " (conditional)" : ""}; ${s.invalid === "error" ? "**error**" : "warning"}`;
}

const NEED: Record<Need, string> = { required: "**required**", recommended: "recommended", optional: "optional", refused: "**refused**", refused_true: "**refused if true**", unused: "–" };

export function manifestTable(): string {
  return [
    "| Variable | Purpose | Secret | Read by | mock | dev live | staging | production | Rule; when invalid | Default |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...ENV_MANIFEST.map((s) => `| \`${s.name}\` | ${esc(s.purpose)} | ${s.secret ? "yes" : s.pii ? "PII" : ""} | ${s.readBy.join(", ")} | ${NEED[s.need.mock]} | ${NEED[s.need.dev]} | ${NEED[s.need.staging]} | ${NEED[s.need.production]} | ${rule(s)} | ${s.default ? `\`${s.default}\`` : ""} |`),
  ].join("\n");
}

/** The table between the doc's markers, or null when the markers are missing. */
export function docTable(doc: string): string | null {
  return doc.split("<!-- manifest:start -->\n")[1]?.split("\n<!-- manifest:end -->")[0] ?? null;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/env-manifest.ts")) {
  // --check <doc>: exit 1 when the doc's table is stale (CI), else print the table.
  const i = process.argv.indexOf("--check");
  if (i < 0) console.log(manifestTable());
  else {
    const { readFileSync } = await import("node:fs");
    const fresh = docTable(readFileSync(process.argv[i + 1] ?? "docs/env-manifest.md", "utf8")) === manifestTable();
    console.log(fresh ? "env manifest doc: current" : "env manifest doc: STALE (regenerate: node apps/mcp/scripts/env-manifest.ts, paste between the markers)");
    process.exit(fresh ? 0 : 1);
  }
}
