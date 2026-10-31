// Haggle's reply as readable text. Model text (which can quote business text) is never HTML: it is
// split into paragraphs and "-" / "1." lists and rendered as React text nodes. The only links are
// internal: a deal's page (/deals/job_…, or a bare job id) reads "the deal board" instead of the id,
// and /vendors reads "Vendors". A leading "DEMO:" becomes the Demo marker.
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";

type Block = { type: "p"; lines: string[] } | { type: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/** Paragraphs and lists from plain text (consecutive "-" or "1." lines form a list). */
export function blocksOf(text: string): Block[] {
  const out: Block[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    let para: string[] = [];
    let list: { type: "ul" | "ol"; items: string[] } | null = null;
    const endPara = () => {
      if (para.length) out.push({ type: "p", lines: para });
      para = [];
    };
    const endList = () => {
      if (list) out.push(list);
      list = null;
    };
    for (const raw of chunk.split("\n")) {
      const line = raw.replace(HEADING, "").trimEnd();
      if (!line.trim()) continue;
      const kind = BULLET.test(line) ? "ul" : NUMBER.test(line) ? "ol" : null;
      if (kind) {
        endPara();
        if (!list || list.type !== kind) {
          endList();
          list = { type: kind, items: [] };
        }
        list.items.push(line.replace(kind === "ul" ? BULLET : NUMBER, ""));
      } else if (list && /^\s{2,}\S/.test(raw)) {
        // An indented continuation of the last item.
        list.items[list.items.length - 1] += ` ${line.trim()}`;
      } else {
        endList();
        para.push(line);
      }
    }
    endPara();
    endList();
  }
  return out;
}

// **bold** | /deals/<job id> (with an optional origin) | "deal <job id>" | a bare job id | /vendors
const INLINE = /\*\*([^*\n]+)\*\*|(?:https?:\/\/[^\s/]+)?\/deals\/(job_[A-Za-z0-9_-]+)\/?|\b(?:([Tt]he|[Yy]our|[Tt]his) )?([Dd])eal (job_[A-Za-z0-9_-]+)|\b(job_[A-Za-z0-9_-]+)|(?:https?:\/\/[^\s/]+\/vendors|(?<![\w/])\/vendors)\b/g;

const dealHref = (id: string) => `/deals/${encodeURIComponent(id)}`;

/** One line with ids turned into named links. */
export function inline(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of line.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    const [whole, bold, pathId, article, d, namedId, bareId] = m;
    if (bold) out.push(<strong key={k++}>{bold}</strong>);
    else if (pathId) out.push(<Link key={k++} href={dealHref(pathId)}>the deal board</Link>);
    else if (namedId) {
      const words = article ? `${article} ${d}eal` : d === "D" ? "The deal" : "the deal";
      out.push(<Link key={k++} href={dealHref(namedId)}>{words}</Link>);
    } else if (bareId) out.push(<Link key={k++} href={dealHref(bareId)}>this deal</Link>);
    else if (whole) out.push(<Link key={k++} href="/vendors">Vendors</Link>);
    last = at + whole.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

const DEMO = /^\s*\**DEMO\**\s*[:\-–—]\s*/;

export function RichText({ text }: { text: string }) {
  const demo = DEMO.test(text);
  let body = demo ? text.replace(DEMO, "") : text;
  if (demo) body = body.charAt(0).toUpperCase() + body.slice(1);
  const blocks = blocksOf(body);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "p") {
          return (
            <p key={i}>
              {demo && i === 0 ? (
                <>
                  <Badge className="chat-demo" title="Simulated businesses: nothing real is sent or paid" />
                  <span className="sr-only">: </span>{" "}
                </>
              ) : null}
              {b.lines.map((l, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  {inline(l)}
                </Fragment>
              ))}
            </p>
          );
        }
        const List = b.type;
        return (
          <Fragment key={i}>
            {demo && i === 0 ? (
              <p>
                <Badge className="chat-demo" />
              </p>
            ) : null}
            <List>
              {b.items.map((it, j) => (
                <li key={j}>{inline(it)}</li>
              ))}
            </List>
          </Fragment>
        );
      })}
    </>
  );
}
