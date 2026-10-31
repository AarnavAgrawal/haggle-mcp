// The left rail (DESIGN.md "App shell"): wordmark, New request, the deals list (streamed), workspace
// links, and who is signed in with Sign out. Rendered by app/(app)/layout.tsx, inside AppShell (as the
// desktop rail and inside the mobile drawer).
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
        <Link className="brand rail-brand" href="/deals">
          Haggle
        </Link>
        <Link className={buttonClass("primary", { block: true })} href="/chat">
          <Icon name="plus" />
          New request
        </Link>
      </div>
      <nav className="rail-deals" aria-label="Deals">
        <RailLink href="/deals" className="rail-heading" label="Deals" />
        <Suspense fallback={<RailDealsSkeleton />}>
          <RailDeals />
        </Suspense>
      </nav>
      <nav className="rail-nav" aria-label="Workspace">
        <RailLink href="/vendors" match="prefix" label="Vendors" />
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
