// /settings while get_identity answers: the title and the sheet's groups as placeholders.
import { Skeleton } from "@/components/ui/Skeleton";
import "./settings.css";

const GROUPS = [3, 4, 3, 3];
// Placeholder rows as tall as a line of text (15px type, 1.45 line height).
const ROW = { marginBlock: 4 };

export default function Loading() {
  return (
    <main className="shell set-page" aria-busy="true" aria-label="Loading settings">
      <header className="set-head">
        <h1>Settings</h1>
      </header>
      <div className="ui-sheet set-sheet" aria-hidden="true">
        {GROUPS.map((rows, g) => (
          <div key={g} className="set-group">
            <Skeleton w={g === 0 ? 150 : 110} h={16} />
            <div className="set-dl">
              {Array.from({ length: rows }, (_, i) => (
                <div key={i}>
                  <Skeleton w={96 + ((i * 17) % 30)} h={14} style={ROW} />
                  <Skeleton w={140 + ((i * 37 + g * 23) % 90)} h={14} style={ROW} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
