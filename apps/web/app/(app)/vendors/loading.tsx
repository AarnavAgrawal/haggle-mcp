// /vendors while the list loads: the header, the search bar and the vendors table, as placeholders.
import { Skeleton } from "@/components/ui/Skeleton";
import "@/components/vendors/vendors.css";

export default function Loading() {
  return (
    <main className="shell vend-page" aria-busy="true" aria-label="Loading vendors">
      <div className="vend-head">
        <h1>Vendors</h1>
        <Skeleton w={150} h={40} />
      </div>
      <div className="vend-find">
        <div className="vend-bar vend-bar-skel" aria-hidden="true">
          <div className="vend-bar-field vend-bar-what">
            <Skeleton w={96} h={12} />
            <Skeleton w="60%" h={18} />
          </div>
          <div className="vend-bar-field vend-bar-where">
            <Skeleton w={40} h={12} />
            <Skeleton w="70%" h={18} />
          </div>
          <Skeleton w={92} h={44} className="vend-bar-go" />
        </div>
      </div>
      <section className="vend-section">
        <div className="vend-section-head">
          <Skeleton w={160} h={24} />
        </div>
        <div className="ui-sheet ui-sheet-pad-none" aria-hidden="true">
          <div className="vend-skel-head">
            <Skeleton w={64} h={12} />
          </div>
          {[200, 150, 180].map((w, i) => (
            <div key={i} className="vend-skel-row">
              <Skeleton w={w} h={16} />
              <Skeleton w={72} h={14} className="vt-wide" />
              <Skeleton w={190} h={14} className="vt-wide" />
              <Skeleton w={150} h={14} className="vt-mid" />
              <Skeleton w={64} h={14} />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
