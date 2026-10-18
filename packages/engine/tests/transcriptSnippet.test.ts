// The deal board's excerpt shows what the business said, never Haggle's own lines, and no links.
import { describe, expect, it } from "vitest";
import { messageSnippet, transcriptSnippet } from "../src/workflow/transcriptSnippet.ts";

describe("transcriptSnippet", () => {
  it("picks the business's priced line, not Haggle's opening", () => {
    const t = "Haggle (AI assistant): Hi, I'm an AI assistant calling for a quote for 40.\nMission Eats: Sure, what date?\nMission Eats: $1,070 total, 14 vegetarian, $50 deposit.\nHaggle (AI assistant): Thanks, goodbye.";
    expect(transcriptSnippet(t, "Mission Eats")).toBe("Mission Eats: $1,070 total, 14 vegetarian, $50 deposit.");
  });
  it("names the callee instead of Inkbox's 'remote' and clips at a word", () => {
    const t = `haggle (AI assistant): Hello.\nremote: ${"We can do a lovely spread ".repeat(12)}`;
    const s = transcriptSnippet(t, "Yash's Kitchen");
    expect(s.startsWith("Yash's Kitchen: We can do")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith("…")).toBe(true);
  });
  it("falls back to the first business line, then the first line; empty stays empty", () => {
    expect(transcriptSnippet("haggle (AI assistant): Hi\nremote: Who is this?", "Bay")).toBe("Bay: Who is this?");
    expect(transcriptSnippet("haggle (AI assistant): Hi, no answer", "Bay")).toBe("haggle (AI assistant): Hi, no answer");
    expect(transcriptSnippet("", "Bay")).toBe("");
  });
});

describe("transcriptSnippet on a live Inkbox transcript (regression, 2026-10-18)", () => {
  const live = [
    "remote: If you record your name and reason for calling",
    "local: Hi, this is Haggle, an AI assistant calling for a customer to ask for a catering quote. Please call or email us back.",
    "remote: Hello",
    "remote: Yes I do",
    "local: Great, thank you! We're looking for catering for 200 people on Saturday, October 24th, 2026.",
    "remote: Yes, for two hundred total meals. Including forty vegetarian it'll cost about six thousand dollars",
    "remote: And then about two hundred dollars in delivery and setup",
  ].join("\n");
  it("skips call screening and Haggle's own 'local' turns; finds a price said in words", () => {
    expect(transcriptSnippet(live, "Mission Eats (demo)")).toBe("Mission Eats (demo): Yes, for two hundred total meals. Including forty vegetarian it'll cost about six thousand dollars");
  });
  it("a screened call with no answer never shows the screening prompt as the business's words", () => {
    expect(transcriptSnippet("remote: If you record your name and reason for calling\nlocal: Please call us back.", "Bay")).toBe("local: Please call us back.");
  });
});

describe("messageSnippet", () => {
  it("prefers the priced line, strips links and quoted history", () => {
    expect(messageSnippet("Hi!\nTotal $1,150 incl. delivery, pay at https://evil.example/pay\n> earlier: $9")).toBe("Total $1,150 incl. delivery, pay at [link removed]");
  });
  it("pricedOnly returns nothing without a price; otherwise the first line", () => {
    expect(messageSnippet("Quote attached (PDF).", { pricedOnly: true })).toBe("");
    expect(messageSnippet("Do you need plates?")).toBe("Do you need plates?");
    expect(messageSnippet(null)).toBe("");
  });
});
