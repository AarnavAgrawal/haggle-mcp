// Release identity for /health, /ready and the MCP serverInfo: the server version, the deployed
// commit (HAGGLE_BUILD_SHA) and when the build was made (HAGGLE_BUILD_TIME, else the build output's
// mtime). Both labels are set per deploy (docs/deployment.md §5, scripts staging-release.ts). Only a
// well-formed label is ever echoed: anything else (a pasted key, a URL, a sentence) reads "invalid",
// so a misconfigured variable can't leak through an unauthenticated endpoint.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The server's release version. apps/mcp/package.json still says 0.1.0 (it isn't Yash's file to
 * bump); this is the version clients have seen in serverInfo since v5 and the one /health reports.
 */
export const RELEASE_VERSION = "0.6.0";

type Env = Record<string, string | undefined>;

/** A commit id or short release label: letters, digits, . _ -; at most 40 characters. */
const LABEL = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;
/** Credential prefixes a label must never start with (a key pasted into the wrong variable). */
const CREDENTIAL = /^(?:sk|rk|pk|whsec|hgw|hgc|sb_secret|ghp|gho|ghs|github_pat|xox[abp]|ik)[-_]|^(?:AKIA|AIza)/i;

export type Label = string | "unknown" | "invalid";

/** HAGGLE_BUILD_SHA as shown: the label, "unknown" when unset, "invalid" when it isn't label-shaped. */
export function buildSha(env: Env = process.env): Label {
  const v = env.HAGGLE_BUILD_SHA?.trim();
  if (!v) return "unknown";
  return LABEL.test(v) && !CREDENTIAL.test(v) ? v : "invalid";
}

/**
 * HAGGLE_BUILD_TIME (ISO 8601) when set; otherwise the mtime of the build manifest `mcp-use build`
 * wrote next to the server (cwd apps/mcp on Manufact and locally); "unknown" without either.
 */
export function buildTime(env: Env = process.env, cwd: string = process.cwd()): Label {
  const v = env.HAGGLE_BUILD_TIME?.trim();
  if (v) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return "invalid";
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : "invalid";
  }
  try {
    const manifest = join(cwd, ".mcp-use", "build", "manifest.json");
    return existsSync(manifest) ? statSync(manifest).mtime.toISOString() : "unknown";
  } catch {
    return "unknown";
  }
}

export interface ReleaseInfo {
  version: string;
  build_sha: Label;
  build_time: Label;
  /** Kept for older smoke runners and dashboards: the sha, or null when unknown/invalid. */
  build: string | null;
}

export function releaseInfo(env: Env = process.env, cwd?: string): ReleaseInfo {
  const sha = buildSha(env);
  return { version: RELEASE_VERSION, build_sha: sha, build_time: buildTime(env, cwd), build: sha === "unknown" || sha === "invalid" ? null : sha };
}

/** serverInfo.version: 0.6.0, or 0.6.0+<sha> when the build label is valid. */
export function serverVersion(env: Env = process.env): string {
  const sha = buildSha(env);
  return sha === "unknown" || sha === "invalid" ? RELEASE_VERSION : `${RELEASE_VERSION}+${sha}`;
}
