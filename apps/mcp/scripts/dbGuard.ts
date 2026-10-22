// Side-effect guard for operator scripts that open SUPABASE_DB_URL (workspace-admin, workspace-create,
// job-ops, ...): `import "./dbGuard.ts";` as their first import. When the process was started as one
// of these scripts, it exits (code 2) before any connection if SUPABASE_DB_URL is a production
// database and HAGGLE_ENV isn't production (override: HAGGLE_ALLOW_PROD_DB=true). Importing it from
// a test or another module does nothing.
import { guardScriptDatabase } from "../src/config.ts";

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (/\/apps\/mcp\/scripts\/(?:[^/]+\/)*[^/]+\.ts$/.test(entry)) guardScriptDatabase(entry.split("/").pop()!);
