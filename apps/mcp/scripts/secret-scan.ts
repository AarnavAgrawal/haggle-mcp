// Scans committed docs and generated reports for things that look like real credentials: provider
// keys, webhook secrets, workspace credentials, JWTs, private keys and connection strings with a
// real-looking password. Placeholders (<password>, [YOUR-PASSWORD], sk_test_..., ${VAR}) don't match.
// Prints file:line and the pattern name only, never the match.
//
//   npx tsx apps/mcp/scripts/secret-scan.ts [path ...]     default: docs/, the root *.md, apps/*/README.md
//   exit 0 = clean, 1 = findings. apps/mcp/tests/secretsHygiene.test.ts runs it on every CI run.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_PATTERNS: [string, RegExp][] = [
  ["stripe key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["anthropic key", /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/],
  ["webhook secret", /\bwhsec_[A-Za-z0-9+/=_-]{20,}/],
  ["workspace credential", /\b(?:hgw|hgc)_[A-Za-z0-9_-]{20,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/],
  ["supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack webhook", /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ["github token", /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  // user:password@ with a password that looks real: 12+ characters, no placeholder punctuation.
  ["connection string with password", /\bpostgres(?:ql)?:\/\/[^\s:/@]+:(?![^@\s]*(?:password|PASSWORD|postgres@))[^\s@<>[\]{}$*.]{12,}@/],
];

export interface Finding { file: string; line: number; pattern: string }

export function scanText(text: string, file = "<text>"): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (const [name, re] of SECRET_PATTERNS) if (re.test(l)) out.push({ file, line: i + 1, pattern: name });
  });
  return out;
}

const TEXT = /\.(md|txt|json|html|csv|log)$/i;
function walk(p: string): string[] {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [p];
  return readdirSync(p, { withFileTypes: true }).flatMap((d) => (d.name === "node_modules" || d.name.startsWith(".") ? [] : d.isDirectory() ? walk(join(p, d.name)) : TEXT.test(d.name) ? [join(p, d.name)] : []));
}

/** The default scope: docs/ (reports included), the root Markdown files, app READMEs. */
export function defaultTargets(root: string): string[] {
  const rootMd = readdirSync(root).filter((f) => f.endsWith(".md")).map((f) => join(root, f));
  const readmes = readdirSync(join(root, "apps")).map((a) => join(root, "apps", a, "README.md")).filter(existsSync);
  return [join(root, "docs"), ...rootMd, ...readmes];
}

export function scanPaths(paths: string[], root: string): Finding[] {
  return paths.flatMap(walk).flatMap((f) => scanText(readFileSync(f, "utf8"), relative(root, f)));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/secret-scan.ts")) {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const args = process.argv.slice(2);
  const findings = scanPaths(args.length ? args : defaultTargets(root), root);
  for (const f of findings) console.log(`${f.file}:${f.line}: looks like a ${f.pattern}`);
  console.log(findings.length ? `secret scan: ${findings.length} finding(s)` : "secret scan: clean");
  process.exit(findings.length ? 1 : 0);
}
