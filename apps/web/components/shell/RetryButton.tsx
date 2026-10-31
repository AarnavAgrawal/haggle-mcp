"use client";
// Re-renders the current route on the server (router.refresh in a transition), pending until the fresh
// data has arrived. Used where a streamed section failed to load.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/Button";

export function RetryButton({ children = "Try again", className }: { children?: string; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="quiet" size="s" className={className} pending={pending} onClick={() => start(() => router.refresh())}>
      {children}
    </Button>
  );
}
