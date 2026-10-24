// Release identity (src/release.ts) on /health, /ready and serverInfo: version, build_sha, build_time.
// The labels come from deploy-time variables; anything not label-shaped is reported as "invalid",
// never echoed (both endpoints are unauthenticated). Served in-process (index.ts via server.fetch).
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSha, buildTime, RELEASE_VERSION, releaseInfo, serverVersion } from "../src/release.ts";

describe("release labels", () => {
  it("build_sha: a commit or short label is shown; unset is unknown; anything else is invalid", () => {
    expect(buildSha({ HAGGLE_BUILD_SHA: "ce4760e" })).toBe("ce4760e");
    expect(buildSha({ HAGGLE_BUILD_SHA: " rc2-ce4760e " })).toBe("rc2-ce4760e");
    expect(buildSha({ HAGGLE_BUILD_SHA: "a".repeat(40) })).toBe("a".repeat(40));
    expect(buildSha({})).toBe("unknown");
    expect(buildSha({ HAGGLE_BUILD_SHA: "  " })).toBe("unknown");
    for (const bad of ["a".repeat(41), "sk_live_abcdef0123456789", "whsec_abc123", "hgw_tokenvalue", "ik_live_key", "postgres://u:p@h/db", "https://x.example", "two words", "AKIAABCDEFGHIJKLMNOP"]) {
      expect(buildSha({ HAGGLE_BUILD_SHA: bad }), bad).toBe("invalid");
    }
  });

  it("build_time: HAGGLE_BUILD_TIME (ISO) wins, else the build manifest's mtime, else unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "haggle-release-"));
    expect(buildTime({}, dir)).toBe("unknown");
    mkdirSync(join(dir, ".mcp-use", "build"), { recursive: true });
    writeFileSync(join(dir, ".mcp-use", "build", "manifest.json"), "{}");
    const at = new Date("2026-10-22T08:00:00.000Z");
    utimesSync(join(dir, ".mcp-use", "build", "manifest.json"), at, at);
    expect(buildTime({}, dir)).toBe("2026-10-22T08:00:00.000Z");
    expect(buildTime({ HAGGLE_BUILD_TIME: "2026-10-22T09:30:00Z" }, dir)).toBe("2026-10-22T09:30:00.000Z");
    expect(buildTime({ HAGGLE_BUILD_TIME: "yesterday" }, dir)).toBe("invalid");
    expect(buildTime({ HAGGLE_BUILD_TIME: "2026-13-45T99:99:99Z" }, dir)).toBe("invalid");
  });

  it("serverInfo version carries only a valid label", () => {
    expect(serverVersion({ HAGGLE_BUILD_SHA: "ce4760e" })).toBe(`${RELEASE_VERSION}+ce4760e`);
    expect(serverVersion({})).toBe(RELEASE_VERSION);
    expect(serverVersion({ HAGGLE_BUILD_SHA: "sk_live_abcdef0123456789" })).toBe(RELEASE_VERSION);
    expect(releaseInfo({ HAGGLE_BUILD_SHA: "whsec_abc" }, "/nonexistent")).toEqual({ version: RELEASE_VERSION, build_sha: "invalid", build_time: "unknown", build: null });
  });
});

describe("/health and /ready report the release (mock server, in-process)", () => {
  const ENV = { HAGGLE_MODE: "mock", HAGGLE_BUILD_SHA: "sk_live_SECRETVALUE0123456789", HAGGLE_BUILD_TIME: "2026-10-22T10:00:00Z" };
  const saved: Record<string, string | undefined> = {};
  let server: { fetch: (r: Request) => Promise<Response> };
  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    (await import("../src/runtime.ts")).resetRuntime();
    server = (await import("../index.ts")).default as never;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    (await import("../src/runtime.ts")).resetRuntime();
  });
  const get = async (path: string) => { const r = await server.fetch(new Request(`http://haggle.test${path}`)); return { status: r.status, text: await r.text() }; };

  it("a credential pasted into HAGGLE_BUILD_SHA is reported as invalid, never echoed", async () => {
    for (const path of ["/health", "/ready"]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(JSON.parse(r.text), path).toMatchObject({ version: RELEASE_VERSION, build_sha: "invalid", build_time: "2026-10-22T10:00:00.000Z", build: null });
      expect(r.text, path).not.toMatch(/SECRETVALUE/);
    }
  });

  it("a valid label is shown as build_sha (and build, for older smoke runners)", async () => {
    process.env.HAGGLE_BUILD_SHA = "ce4760e";
    try {
      const h = JSON.parse((await get("/health")).text);
      expect(h).toMatchObject({ ok: true, service: "haggle-mcp", version: RELEASE_VERSION, build_sha: "ce4760e", build: "ce4760e" });
      const r = JSON.parse((await get("/ready")).text);
      expect(r).toMatchObject({ version: RELEASE_VERSION, build_sha: "ce4760e", build: "ce4760e", build_time: "2026-10-22T10:00:00.000Z" });
    } finally {
      process.env.HAGGLE_BUILD_SHA = ENV.HAGGLE_BUILD_SHA;
    }
  });
});
