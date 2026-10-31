import { defineConfig } from "vitest/config";

// Running vitest inside apps/web: unit tests only. The Playwright specs in e2e/ run with
// `npm run e2e`, and tests/approval.e2e.test.ts needs the built MCP server, so it runs from the
// repo root (vitest.config.ts there) after `npm run build`, as CI does.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["e2e/**", "tests/**/*.e2e.test.ts", "node_modules/**"],
    environment: "node",
  },
});
