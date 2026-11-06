// /history's instant skeleton: the title, the filters and one day of events.
import { Skeleton } from "@/components/ui/Skeleton";
import "@/components/admin/admin.css";

export default function Loading() {
  return (
    <main className="adm" aria-busy="true" aria-label="Loading history">
      <header className="adm-head">
        <Skeleton w={140} h={36} />
      </header>
      <div className="adm-toolbar adm-toolbar-end">
        <Skeleton w={520} h={40} />
      </div>
      <Skeleton h={460} radius={8} />
    </main>
  );
}
