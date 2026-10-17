/**
 * Estimates (ask): instant prices from businesses Haggle has learned, each with how sure it is
 * and how many real quotes it rests on. "Get real quotes" starts a deal with those businesses.
 */
import { ModelContext, useCallTool, useSendFollowUp, useToolContext } from "mcp-use/react";
import type { Estimates } from "@haggle/core";
import { ChannelBadge, ErrorNote, Meter, Shell, Skeleton, usd } from "../_shared/ui.tsx";
import "./view.css";

export default function EstimatesView() {
  const ctx = useToolContext<"ask">();
  if (ctx.status !== "ready") {
    return (
      <Shell>
        {ctx.status === "error" ? <ErrorNote title="Couldn't get estimates." detail={ctx.error.message} /> : <Skeleton rows={4} />}
      </Shell>
    );
  }
  return (
    <Shell>
      <EstimatesList data={ctx.toolOutput as Estimates} />
    </Shell>
  );
}

function EstimatesList({ data }: { data: Estimates }) {
  const deal = useCallTool("deal");
  const followUp = useSendFollowUp();
  const r = data.request;
  const title = capitalize(
    [r.quantity ? `${r.what}, ${r.quantity} people` : r.what, r.date && formatDate(r.date), r.area].filter(Boolean).join(", "),
  );
  const started = deal.data?.structuredContent as { job_id?: string } | undefined;

  const getRealQuotes = async () => {
    try {
      const res = await deal.callTool({
        request: { what: r.what, quantity: r.quantity, date: r.date, area: r.area, requirements: [] },
        businesses: data.estimates.map((e) => e.business_id),
      });
      const jobId = (res.structuredContent as { job_id?: string } | undefined)?.job_id;
      if (jobId) {
        await followUp({ prompt: `I started Haggle deal ${jobId} from the estimates. Keep an eye on it with wait_for_update and show me get_quotes when quotes land.` });
      }
    } catch {
      // deal.error renders below
    }
  };

  return (
    <div className="es">
      <ModelContext
        content={`Haggle estimates for ${title}: ${data.estimates.map((e) => `${e.business} ~${usd(e.total_usd)} (${e.n_quotes} quotes)`).join("; ") || "none"}.`}
      />
      <header className="es-head">
        <h1>{title}</h1>
        <p className="es-note">{data.note}</p>
      </header>

      {data.estimates.length === 0 ? (
        <p className="es-empty">Haggle hasn't learned any matching business yet. Start a deal to get real quotes; next time this answers instantly.</p>
      ) : (
        <ul className="es-list">
          {data.estimates.map((e) => (
            <li key={e.business_id} className="es-row">
              <div className="es-line">
                <span className="es-biz">{e.business}</span>
                <ChannelBadge channel={e.best_channel} />
                <span className="es-total">
                  <span className="es-approx" aria-hidden="true">
                    ~
                  </span>
                  {usd(e.total_usd)}
                </span>
              </div>
              <div className="es-conf">
                <Meter value={e.confidence} max={1} tone="win" label={`Confidence ${Math.round(e.confidence * 100)}%`} />
                <span className="es-conf-pct">{Math.round(e.confidence * 100)}% sure</span>
              </div>
              <p className="es-basis">{capitalize(e.basis)}.</p>
            </li>
          ))}
        </ul>
      )}

      <footer className="es-foot">
        {started?.job_id ? (
          <p className="es-started">Deal {started.job_id} started. Haggle is contacting {data.estimates.length} businesses.</p>
        ) : (
          data.estimates.length > 0 && (
            <button className="hg-btn hg-btn-primary" disabled={deal.isPending} onClick={() => void getRealQuotes()}>
              {deal.isPending ? "Starting…" : "Get real quotes"}
            </button>
          )
        )}
        {deal.error && <span className="es-err">{deal.error.message}</span>}
      </footer>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function formatDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
