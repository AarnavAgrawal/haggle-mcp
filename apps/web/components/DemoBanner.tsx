import { DEMO } from "@/lib/demo";

/** Shown on every page of a demo site: nothing real is contacted or paid. */
export function DemoBanner() {
  if (!DEMO) return null;
  return (
    <div className="demo-banner" role="note">
      <strong>Demo</strong> · Simulated businesses reply by email, text and phone. No real business is contacted and no money moves.
    </div>
  );
}
