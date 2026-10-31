// /account while it loads: the profile sheet and the delete area as placeholders.
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import "../settings/settings.css";
import "./account.css";

export default function Loading() {
  return (
    <main className="shell set-page" aria-busy="true" aria-label="Loading your account">
      <header className="set-head">
        <h1>Account</h1>
      </header>
      <div className="ui-sheet set-sheet" aria-hidden="true">
        <div className="set-group">
          <Skeleton w={40} h={16} />
          <div className="set-dl">
            <div>
              <Skeleton w={96} h={14} style={{ marginBlock: 4 }} />
              <Skeleton w={200} h={14} style={{ marginBlock: 4 }} />
            </div>
            <div>
              <Skeleton w={80} h={14} style={{ marginBlock: 4 }} />
              <Skeleton w={150} h={14} style={{ marginBlock: 4 }} />
            </div>
          </div>
        </div>
        <div className="set-group">
          <Skeleton w={80} h={16} />
          <div className="acct-row">
            <SkeletonText lines={2} lineHeight={14} className="acct-text" />
            <Skeleton w={160} h={40} />
          </div>
        </div>
      </div>
      <div className="acct-danger acct-danger-skel" aria-hidden="true">
        <Skeleton w={160} h={20} />
        <SkeletonText lines={3} lineHeight={14} className="acct-text" />
        <Skeleton w={260} h={40} />
      </div>
    </main>
  );
}
