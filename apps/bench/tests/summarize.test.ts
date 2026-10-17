import { describe, expect, it } from "vitest";
import { parseRuns, summarize } from "../scripts/summarize.ts";

const CSV = `arm,client,model,run,passed,score,tokens_in,tokens_out,cost_usd,duration_s,tool_calls,tool_errors,notes
haggle,Claude Code,m,1,true,90,1000,200,0.10,60,8,0,
haggle,Claude Code,m,2,false,60,3000,400,0.30,120,12,1,
haggle,ChatGPT,m,1,pass,85,,,,200,,,browser: no tokens
baseline,Claude Code,m,1,false,40,9000,900,0.90,600,40,3,`;

describe("bench summary", () => {
  it("parses runs and keeps unknown cells unknown", () => {
    const runs = parseRuns(CSV);
    expect(runs).toHaveLength(4);
    expect(runs[2]).toMatchObject({ client: "ChatGPT", passed: true, tokens: undefined, cost_usd: undefined });
  });

  it("builds one row per arm and client with medians and pass rates", () => {
    const table = summarize(parseRuns(CSV));
    expect(table).toContain("| haggle | Claude Code | 2 | 1/2 | 75% | 2,300 | $0.20 | 90 s | 10 | 1 |");
    expect(table).toContain("| haggle | ChatGPT | 1 | 1/1 | 85% | — | — | 200 s | — | — |");
    expect(table).toContain("| baseline | Claude Code | 1 | 0/1 |");
  });
});
