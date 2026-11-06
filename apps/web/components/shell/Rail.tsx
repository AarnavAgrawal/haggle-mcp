// The left rail (DESIGN.md "App shell"): wordmark, New request, the workspace pages, the open deals
// (streamed), workspace links, and who is signed in with Sign out. Rendered by app/(app)/layout.tsx,
// inside AppShell (as the desktop rail and inside the mobile drawer).
import Link from "next/link";
import { Suspense } from "react";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { RailDeals, RailDealsSkeleton } from "./RailDeals";
import { RailLink } from "./RailLink";

export function Rail({ email, guest }: { email?: string; guest?: boolean }) {
  return (
    <div className="rail">
      <div className="rail-top">
        <Link className="brand rail-brand" href="/dashboard">
          Haggle
        </Link>
        <Link className={buttonClass("primary", { block: true })} href="/chat">
          <Icon name="plus" />
          New request
        </Link>
      </div>
      <nav className="rail-pages" aria-label="Pages">
        <RailLink href="/dashboard" label="Overview" />
        <RailLink href="/deals" match="prefix" label="Deals" />
        <RailLink href="/quotes" label="Quotes" />
        <RailLink href="/history" label="History" />
      </nav>
      <nav className="rail-deals" aria-label="Open deals">
        <Suspense fallback={<RailDealsSkeleton />}>
          <RailDeals />
        </Suspense>
      </nav>
      <nav className="rail-nav" aria-label="Workspace">
        <RailLink href="/vendors" match="prefix" label="Saved businesses" />
        <RailLink href="/settings" label="Settings" />
        <RailLink href="/account" label="Account" />
      </nav>
      <form className="rail-user" action="/auth/sign-out" method="post">
        <span className="rail-email" title={email}>
          {email ?? (guest ? "Guest" : "Signed in")}
        </span>
        <SubmitButton variant="quiet" size="s">
          Sign out
        </SubmitButton>
      </form>
    </div>
  );
}
