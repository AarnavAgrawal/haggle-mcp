import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CSV_HEADER,
  armConfig,
  buildClaudeArgs,
  csvEscape,
  judgePassed,
  parseClaudeOutput,
  parseFrontMatter,
  parseTask,
  redactConfig,
  resultToRow,
  rowToCsv,
  type Task,
} from "../scripts/run-eval.ts";
import { parseRuns } from "../scripts/summarize.ts";

const catering: Task = { name: "catering", expectedBest: "Bay Catering", meta: {}, prompt: "p" };

describe("task front matter", () => {
  it("parses keys, skips comments, keeps colons in values and tolerates CRLF", () => {
    const raw = "---\r\n# a comment\r\nexpected_best: Bay Catering\r\ncontacts: A (url: https://x.dev/card); B <b@x.dev>\r\nquoted: \"hi there\"\r\n---\r\nBody {{contacts}}\r\n";
    const { meta, body } = parseFrontMatter(raw);
    expect(meta).toEqual({ expected_best: "Bay Catering", contacts: "A (url: https://x.dev/card); B <b@x.dev>", quoted: "hi there" });
    expect(body).toBe("Body {{contacts}}\n");
  });

  it("returns the whole text as the body when there is no front matter", () => {
    expect(parseFrontMatter("just a prompt")).toEqual({ meta: {}, body: "just a prompt" });
  });

  it("substitutes {{contacts}} with a bulleted list", () => {
    const t = parseTask("x", "---\nexpected_best: B\ncontacts: A; B\n---\nAsk:\n{{contacts}}\nDone.\n");
    expect(t).toMatchObject({ name: "x", expectedBest: "B", prompt: "Ask:\n- A\n- B\nDone." });
  });

  it("loads the shipped tasks", () => {
    const cat = parseTask("catering", readFileSync(new URL("../tasks/catering.md", import.meta.url), "utf8"));
    expect(cat.expectedBest).toBe("Bay Catering");
    expect(cat.prompt).toContain("- QuickQuote Deli");
    expect(cat.prompt).not.toContain("{{contacts}}");
    const plumb = parseTask("plumbing", readFileSync(new URL("../tasks/plumbing.md", import.meta.url), "utf8"));
    expect(judgePassed("Plumber A is cheapest", plumb.expectedBest)).toBeUndefined();
  });
});

describe("arms and claude args", () => {
  it("haggle arm: default URL, bearer header only when a token is set", () => {
    const noToken = armConfig("haggle", {});
    expect(noToken).toMatchObject({ allowedTools: "mcp__haggle", mcp: { mcpServers: { haggle: { type: "http", url: "http://localhost:3000/mcp" } } } });
    expect("mcp" in noToken && noToken.mcp.mcpServers.haggle!.headers).toBeUndefined();

    const withToken = armConfig("haggle", { HAGGLE_EVAL_URL: "https://h.example/mcp", HAGGLE_EVAL_TOKEN: "hgw_secret" });
    expect(withToken).toMatchObject({ url: "https://h.example/mcp", mcp: { mcpServers: { haggle: { headers: { Authorization: "Bearer hgw_secret" } } } } });
    expect("mcp" in withToken && JSON.stringify(redactConfig(withToken.mcp))).not.toContain("hgw_secret");
  });

  it("baseline arm: default URL, skipped when set to empty", () => {
    expect(armConfig("baseline", {})).toMatchObject({ allowedTools: "mcp__baseline", url: "http://localhost:3100/mcp", mcp: { mcpServers: { baseline: { url: "http://localhost:3100/mcp" } } } });
    expect(armConfig("baseline", { BASELINE_EVAL_URL: "" })).toEqual({ arm: "baseline", skip: "BASELINE_EVAL_URL is set to empty" });
  });

  it("builds the headless claude command", () => {
    expect(buildClaudeArgs({ prompt: "do it", mcpConfigPath: "/tmp/m.json", allowedTools: "mcp__haggle", model: "claude-x" })).toEqual([
      "-p", "do it", "--output-format", "json", "--verbose", "--strict-mcp-config", "--mcp-config", "/tmp/m.json", "--allowedTools", "mcp__haggle", "--model", "claude-x",
    ]);
    const stdin = buildClaudeArgs({ mcpConfigPath: "m.json", allowedTools: "mcp__baseline" });
    expect(stdin.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(stdin).not.toContain("--model");
  });
});

describe("claude result -> runs.csv row", () => {
  const result = {
    type: "result", subtype: "success", is_error: false, num_turns: 9, duration_ms: 84_250, total_cost_usd: 0.123456,
    result: "I recommend Bay Catering: $995 total, $24.88 per person, $5 deposit.",
    usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 450 },
    modelUsage: { "claude-sonnet-x": {} },
  };

  it("fills every known field and passes when the answer names expected_best", () => {
    const row = resultToRow({ arm: "haggle", task: catering, run: 2, output: result, model: "fallback" });
    expect(row).toEqual({
      arm: "haggle", client: "claude-code", model: "claude-sonnet-x", run: "2", passed: "true", score: "",
      tokens_in: "2400", tokens_out: "450", cost_usd: "0.1235", duration_s: "84.3", tool_calls: "", tool_errors: "",
      notes: "task=catering; turns=9",
    });
  });

  it("fails when the answer names another business", () => {
    const row = resultToRow({ arm: "baseline", task: catering, run: 1, output: { ...result, result: "Go with Mission Eats." } });
    expect(row.passed).toBe("false");
    expect(row.notes).toContain("answer did not name Bay Catering");
  });

  it("leaves missing fields empty and falls back to wall time and --model", () => {
    const row = resultToRow({ arm: "haggle", task: catering, run: 1, output: { result: "Bay Catering" }, wallMs: 5_000, model: "m-flag" });
    expect(row).toMatchObject({ model: "m-flag", passed: "true", tokens_in: "", tokens_out: "", cost_usd: "", duration_s: "5", tool_calls: "", tool_errors: "" });
  });

  it("no JSON output: unjudged fields empty, failure noted", () => {
    const row = resultToRow({ arm: "haggle", task: catering, run: 1, output: null, extraNotes: ["stderr: boom"] });
    expect(row).toMatchObject({ passed: "false", model: "", tokens_in: "", duration_s: "" });
    expect(row.notes).toBe("task=catering; no JSON output; answer did not name Bay Catering; stderr: boom");
  });

  it("a claude error is never a pass, even if the text names the winner", () => {
    expect(resultToRow({ arm: "haggle", task: catering, run: 1, output: { ...result, is_error: true } }).passed).toBe("false");
  });

  it("dry-run preview row: nothing judged, only the dry-run note", () => {
    const row = resultToRow({ arm: "baseline", task: catering, run: 1, output: null, model: "m", dryRun: true });
    expect(row).toMatchObject({ arm: "baseline", model: "m", passed: "", tokens_in: "", notes: "task=catering; dry-run" });
  });

  it("placeholder expected_best: passed left empty", () => {
    const row = resultToRow({ arm: "haggle", task: { ...catering, name: "plumbing", expectedBest: "<fill in>" }, run: 1, output: result });
    expect(row.passed).toBe("");
    expect(row.notes).toContain("expected_best not set");
  });

  it("counts tool calls and errors from a --verbose transcript array", () => {
    const transcript = [
      { type: "system", subtype: "init", model: "claude-init-model" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "mcp__haggle__deal" }] } },
      { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__haggle__deal" }, { type: "tool_use", name: "mcp__haggle__wait_for_update" }] } },
      { type: "user", message: { content: [{ type: "tool_result" }, { type: "tool_result", is_error: false }] } },
      { ...result, modelUsage: undefined },
    ];
    const p = parseClaudeOutput(transcript);
    expect(p).toMatchObject({ toolCalls: 3, toolErrors: 1, model: "claude-init-model", turns: 9 });
    expect(resultToRow({ arm: "haggle", task: catering, run: 1, output: transcript })).toMatchObject({ tool_calls: "3", tool_errors: "1", passed: "true" });
  });
});

describe("CSV", () => {
  it("escapes commas, quotes and newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("cr\r")).toBe('"cr\r"');
  });

  it("writes rows in the runs.csv header order that summarize can read back", () => {
    const row = resultToRow({ arm: "haggle", task: catering, run: 1, output: { result: "Bay Catering", total_cost_usd: 0.5, duration_ms: 60_000 }, extraNotes: ['odd, "note"'] });
    const line = rowToCsv(row);
    expect(line.startsWith("haggle,claude-code,,1,true,,,,0.5,60,,,")).toBe(true);
    expect(line.endsWith('"task=catering; odd, ""note"""')).toBe(true);
    const [parsed] = parseRuns(`${CSV_HEADER}\n${line}`);
    expect(parsed).toMatchObject({ arm: "haggle", client: "claude-code", passed: true, cost_usd: 0.5, duration_s: 60 });
  });
});
