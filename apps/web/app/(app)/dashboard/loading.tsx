// /dashboard's instant skeleton: the title, the totals line and the two columns.
import { Skeleton } from "@/components/ui/Skeleton";
import "@/components/admin/admin.css";

export default function Loading() {
  return (
    <main className="adm" aria-busy="true" aria-label="Loading overview">
      <header className="adm-head">
        <Skeleton w={180} h={36} />
        <Skeleton w={148} h={40} />
      </header>
      <div className="adm-totals">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="adm-figure">
            <Skeleton w="60%" h={12} />
            <Skeleton w="40%" h={32} />
          </div>
        ))}
      </div>
      <div className="adm-grid">
        <div className="adm-col">
          <Skeleton h={220} radius={8} />
          <Skeleton h={260} radius={8} />
        </div>
        <div className="adm-col">
          <Skeleton h={240} radius={8} />
          <Skeleton h={180} radius={8} />
        </div>
      </div>
    </main>
  );
}
