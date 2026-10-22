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
    : r.kind === "json" ? "JSON" : "free text";
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

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/env-manifest.ts")) console.log(manifestTable());
