import Ajv2020 from "ajv/dist/2020.js"; 
const url = "https://calm-spark-ck3qm.run.mcp-use.com/mcp";
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let sid = null;
async function rpc(method, params, id = 1) {
  const r = await fetch(url, { method: "POST", headers: { ...H, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  sid = r.headers.get("mcp-session-id") ?? sid; const t = await r.text();
  return JSON.parse(t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? t);
}
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "schema-check", version: "1" } });
const tool = (await rpc("tools/list", {}, 2)).result.tools.find((t) => t.name === process.argv[3]);
const res = (await rpc("tools/call", { name: process.argv[3], arguments: { job_id: process.argv[2] } }, 3)).result;
const ajv = new (Ajv2020.default ?? Ajv2020)({ allErrors: true, strict: false });
const ok = ajv.validate(tool.outputSchema, res.structuredContent);
console.log(process.argv[3], "valid:", ok);
for (const e of ajv.errors ?? []) console.log(" ", e.instancePath, e.message, JSON.stringify(e.params));
