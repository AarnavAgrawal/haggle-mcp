import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { mayProvision } from "@/lib/waitlist/gate";
import { admission, sessionUser } from "@/lib/workspace";

/**
 * Someone not yet let in has nothing to set up, so they go to /waitlist. The check is here because
 * page.tsx is a client component; createWorkspace and onboard() enforce it on the server either way.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const user = await sessionUser();
  if (user && !mayProvision(await admission(user))) redirect("/waitlist");
  return children;
}
