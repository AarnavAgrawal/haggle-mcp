"use server";

import { redirect } from "next/navigation";
import { recordTermsAcceptance } from "@/lib/account/profile";
import { membership, onboard, sessionUser } from "@/lib/workspace";
import { HaggleError } from "@/lib/haggle";

export type OnboardState = { error: string | null };

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Create the signed-in user's workspace through the MCP server, then go to the deals. The Terms and
 * Acceptable Use checkbox is required: its acceptance (with the terms version) is stored first.
 */
export async function createWorkspace(_prev: OnboardState, form: FormData): Promise<OnboardState> {
  const user = await sessionUser();
  if (!user) redirect("/login");
  if (!(await membership(user.id))) {
    const name = String(form.get("name") ?? "").trim() || "My workspace";
    const phone = String(form.get("approver_phone") ?? "").replace(/[\s().-]/g, "");
    const cap = Number(String(form.get("cap_usd") ?? "").replace(/[$,]/g, ""));
    const area = String(form.get("area") ?? "").trim();
    if (form.get("accept_terms") !== "on") return { error: "Agree to the Terms and the Acceptable Use policy to continue." };
    if (phone && !E164.test(phone)) return { error: "Enter the approver's phone with its country code, e.g. +14155550123." };
    if (form.get("cap_usd") && !(cap > 0)) return { error: "The spending cap must be a positive amount." };
    try {
      await recordTermsAcceptance(user.id);
    } catch {
      return { error: "Couldn't record your acceptance of the Terms. Try again in a moment." };
    }
    try {
      await onboard(user, { name, ...(phone ? { approverPhone: phone } : {}), ...(cap > 0 ? { capUsd: cap } : {}), ...(area ? { area } : {}) });
    } catch (err) {
      return { error: err instanceof HaggleError ? `${err.message} ${err.fix}`.trim() : "Couldn't create your workspace. Try again in a moment." };
    }
  }
  redirect("/deals");
}
