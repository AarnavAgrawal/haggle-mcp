/**
 * Capture every Haggle view (light, dark, narrow) from a running server, for the slides, the
 * backup deck and the Definition of Done (CLAUDE.md §10: views need a screenshot).
 *
 *   npm run dev -w @haggle/mcp            # in another terminal
 *   npm run screenshots -w @haggle/bench  # HAGGLE_MCP_URL to target a deployed server
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP = process.env.HAGGLE_MCP_URL ?? "http://localhost:3000/mcp";
const OUT = fileURLToPath(new URL("../screenshots/", import.meta.url));
// Run the CLI from the MCP app, where @mcp-use/client (needed by `screenshot`) is installed.
const APP_DIR = fileURLToPath(new URL("../../mcp/", import.meta.url));
// mcp-use doesn't export its package.json; find the package root from its main entry instead.
const mcpUseEntry = createRequire(join(APP_DIR, "package.json")).resolve("mcp-use");
const MCP_USE_BIN = join(mcpUseEntry.slice(0, mcpUseEntry.lastIndexOf(join("node_modules", "mcp-use")) + join("node_modules", "mcp-use").length), "dist", "bin.js");

const SHOTS: { name: string; tool: string; args: string[]; theme?: "dark"; width?: number }[] = [
  { name: "deal-board", tool: "get_quotes", args: ["job_id=job_demo"] },
  { name: "deal-board-dark", tool: "get_quotes", args: ["job_id=job_demo"], theme: "dark" },
  { name: "deal-board-narrow", tool: "get_quotes", args: ["job_id=job_demo"], width: 400 },
  { name: "approval", tool: "approve", args: ["job_id=job_demo", "quote_id=q_bay_1"] },
  { name: "estimates", tool: "ask", args: ["what=Lunch catering", "quantity:=25", "area=San Francisco"] },
  { name: "business-profile", tool: "business_profile", args: ["business=Harbor Table"] },
  { name: "business-profile-dark", tool: "business_profile", args: ["business=Harbor Table"], theme: "dark" },
];

mkdirSync(OUT, { recursive: true });
for (const s of SHOTS) {
  const output = join(OUT, `${s.name}.png`);
  const cli = [
    MCP_USE_BIN, "screenshot", "--mcp", MCP, "--tool", s.tool, "--output", output, "--delay", "800", "--json",
    ...(s.theme ? ["--theme", s.theme] : []),
    ...(s.width ? ["--width", String(s.width)] : []),
    ...s.args,
  ];
  // node + the CLI's JS entry, no shell: paths with spaces stay one argument on every OS.
  execFileSync(process.execPath, cli, { cwd: APP_DIR, stdio: ["ignore", "ignore", "inherit"] });
  console.log(`saved ${output}`);
}
