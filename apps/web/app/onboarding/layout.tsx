import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { mayProvision } from "@/lib/waitlist/gate";
import { admission, sessionUser } from "@/lib/workspace";

/**
 * Someone not yet let in has nothing to set up, so they go to /waitlist, which also explains a failed check.
 * The check is here because page.tsx is a client component; createWorkspace and onboard() enforce it either way.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const user = await sessionUser();
  if (user && !(await admission(user).then(mayProvision, () => false))) redirect("/waitlist");
  return children;
}
