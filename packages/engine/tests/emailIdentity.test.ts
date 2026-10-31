// Email carries no AI self-label, but never a false claim to be human (CLAUDE.md section 7): an
// identity question always gets the truthful answer, and agent-written or model-written text that
// claims to be a person never goes out. Pure checks; no network.
import { describe, expect, it } from "vitest";
import { ANSWER_SYSTEM, identityAnswer, isIdentityQuestion } from "../src/parsing/answerQuestion.ts";
import { splitQuestions } from "../src/parsing/extraction.ts";
import { checkMessage } from "../src/negotiation/messageGuard.ts";
import { unsafeAsk } from "../src/negotiation/strategist.ts";
import { alsoAsk, emailSignOff, replyByText } from "../src/outbound/rfq.ts";

describe("identity questions", () => {
  it("recognises 'are you a person or a bot' in its common forms", () => {
    for (const q of ["Is this a real person?", "Are you a bot?", "Am I talking to an AI?", "Is this automated?", "are you human or a robot", "Is this an AI assistant?", "Was this sent by a bot?"]) expect(isIdentityQuestion(q), q).toBe(true);
    for (const q of ["Do you need plates?", "What time should we deliver?", "Is this for 40 people?", "Are you the event organizer?"]) expect(isIdentityQuestion(q), q).toBe(false);
  });

  it("is never dropped as a courtesy question", () => {
    expect(splitQuestions([{ text: "Is this a real person?", needs_answer_to_quote: false }, { text: "Will you be using us?", needs_answer_to_quote: false }])).toEqual({ blocking: ["Is this a real person?"], courtesy: ["Will you be using us?"] });
  });

  it("the answer is truthful and names the customer", () => {
    expect(identityAnswer("Acme Labs")).toBe("You're writing with an AI assistant that collects quotes on behalf of Acme Labs. A person at Acme Labs makes the decisions and approves any order.");
    expect(identityAnswer(null)).toMatch(/AI assistant that collects quotes on behalf of the customer/);
    expect(checkMessage({ text: identityAnswer("Acme Labs"), limit: 2000, verifiedCents: [], otherBusinessNames: [] })).toEqual({ ok: true });
  });

  it("the reply-drafting prompt keeps the rule", () => {
    expect(ANSWER_SYSTEM).toMatch(/Never claim or imply to be a human/);
    expect(ANSWER_SYSTEM).toMatch(/say truthfully that it is an AI assistant/);
  });
});

describe("no claim to be human goes out", () => {
  it("the message guard refuses it (send_message, answer_business)", () => {
    for (const text of ["Hi, I'm a real person, not a bot.", "This isn't a bot, promise.", "I am human.", "We're not an AI.", "You're talking to a real person."]) {
      expect(checkMessage({ text, limit: 2000, verifiedCents: [], otherBusinessNames: [] }), text).toMatchObject({ ok: false, code: "CLAIMS_HUMAN" });
    }
    expect(checkMessage({ text: "Thanks! Could you also tell us your cancellation policy?", limit: 2000, verifiedCents: [], otherBusinessNames: [] })).toEqual({ ok: true });
  });

  it("the negotiation strategist's extra sentence is dropped when it claims to be human", () => {
    expect(unsafeAsk("As a real person, could you be flexible on setup time?", [])).toBe("claims to be human");
    expect(unsafeAsk("Could you be flexible on the setup time?", [])).toBeNull();
  });
});

describe("email text helpers", () => {
  it("signs with the customer's name, or a plain thanks; never an AI label or an invented person", () => {
    expect(emailSignOff("Priya at Acme Labs")).toBe("Thanks,\nPriya at Acme Labs");
    expect(emailSignOff("a customer")).toBe("Thanks!");
    expect(emailSignOff(undefined)).toBe("Thanks!");
  });

  it("the reply-by is a local day, never UTC", () => {
    const t = new Date("2026-11-11T01:00:00Z");
    expect(replyByText(t, "America/Los_Angeles")).toBe("by Tuesday, Nov 10");
    expect(replyByText(t, "Europe/London")).toBe("by Wednesday, Nov 11");
    expect(replyByText(t, "Not/AZone")).toBe("by Tuesday, Nov 10"); // an invalid zone falls back to the default
    expect(replyByText(t, "America/Los_Angeles")).not.toMatch(/UTC/);
  });

  it("the follow-up ask is one sentence", () => {
    expect(alsoAsk(["Your cancellation policy"])).toBe("Could you also tell us your cancellation policy?");
    expect(alsoAsk(["At least 12 vegetarian meals", "any deposit and when it's due"])).toBe("Could you also tell us: at least 12 vegetarian meals; any deposit and when it's due?");
  });
});
