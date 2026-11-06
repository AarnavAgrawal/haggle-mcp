// A ledger page that couldn't load, with the server's own fix and a retry; and the note shown when the
// server held deals back, so nobody reads a partial total as the whole.
import { RetryButton } from "@/components/shell/RetryButton";

export function LedgerError({ error }: { error: { message: string; fix: string } }) {
  return (
    <div className="board-error" role="alert">
      <p>{error.message}</p>
      <p className="fix">{error.fix}</p>
      <RetryButton />
    </div>
  );
}

export function TruncatedNote({ shown }: { shown: number }) {
  return <p className="adm-note">Showing your {shown} most recent deals. Every figure here covers those deals only.</p>;
}
