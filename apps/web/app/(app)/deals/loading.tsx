// /deals' instant skeleton: the title, the toolbar and rows shaped like the table.
import { Skeleton } from "@/components/ui/Skeleton";
import "@/components/admin/admin.css";

export default function Loading() {
  return (
    <main className="adm" aria-busy="true" aria-label="Loading deals">
      <header className="adm-head">
        <Skeleton w={120} h={36} />
        <Skeleton w={148} h={40} />
      </header>
      <div className="adm-toolbar">
        <Skeleton w={300} h={24} />
        <Skeleton w={460} h={40} />
      </div>
      <Skeleton h={420} radius={8} />
    </main>
  );
}
