"use client";
// Keeps a ledger page current: a Refresh button, and while deals are open a quiet re-read every 30 s
// when the tab is visible. Never navigates or shifts the layout; filters and selection stay as they are.
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { Button } from "@/components/ui/Button";

const EVERY_MS = 30_000;

export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") start(() => router.refresh());
    }, EVERY_MS);
    return () => clearInterval(t);
  }, [active, router]);

  return (
    <Button variant="quiet" pending={pending} onClick={() => start(() => router.refresh())}>
      Refresh
    </Button>
  );
}
