import { Badge } from "@/components/ui/Badge";
import { DEMO } from "@/lib/demo";

/** A slim bar on every page of a demo site: nothing real is contacted or paid. Styles: components/ui/ui.css. */
export function DemoBanner() {
  if (!DEMO) return null;
  return (
    <div className="demo-banner" role="note">
      <Badge>Demo</Badge>
      <span className="demo-banner-text">
        <span className="demo-banner-long">Simulated businesses reply by email, text and phone. </span>
        Nothing real is contacted or paid.
      </span>
    </div>
  );
}
