// PURE: plain text from an HTML-only email (no text/plain part), for the same parsing path as any
// other reply. Dependency-free and linear: one scan over the markup, no regex backtracking over
// untrusted input. Scripts, styles, comments and <head> are dropped with their content; block tags
// become line breaks; <blockquote> content becomes "> " lines so cleanEmailBody's quoting rules
// still drop quoted history; link targets are kept in the text ("Pay here (https://…)") so a
// payment link can't hide behind its label. The output is data for the parser, never rendered.

const MAX_HTML = 1_000_000;
const DROP = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "object", "iframe"]);
const BLOCK = new Set(["p", "div", "br", "tr", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "section", "article", "header", "footer", "pre", "address", "center", "dl", "dt", "dd", "tbody", "thead"]);
const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  euro: "€", pound: "£", yen: "¥", cent: "¢", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", times: "×", divide: "÷", deg: "°", zwnj: "", zwj: "", shy: "",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};

export function htmlToText(html: string): string {
  const src = html.slice(0, MAX_HTML);
  const lower = src.toLowerCase();
  const out: string[] = [];
  let line = "";
  let depth = 0; // <blockquote> nesting
  let pre = 0;
  const links: string[] = []; // open <a> targets
  /** End the current line; block boundaries (not <br>) don't add blank lines. */
  const flush = (soft = true) => {
    if (soft && !line.trim()) { line = ""; return; }
    const t = pre ? line.replace(/\s+$/, "") : line.replace(/[ \t ]+/g, " ").trim();
    out.push(depth ? (t ? `${"> ".repeat(depth)}${t}` : ">".repeat(depth)) : t);
    line = "";
  };
  const text = (s: string) => {
    const d = decodeEntities(s);
    if (pre) {
      const parts = d.split("\n");
      parts.forEach((p, k) => { if (k) flush(false); line += p; });
    } else line += d.replace(/\s+/g, " ");
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    const next = src[lt + 1] ?? "";
    if (!/[a-z/!?]/i.test(next)) { text("<"); i = lt + 1; continue; } // "a < b" is text
    const gt = src.indexOf(">", lt + 1);
    if (gt < 0) break; // an unterminated tag: drop the rest
    const tag = src.slice(lt, gt + 1);
    const m = tag.match(/^<\s*(\/?)\s*([a-z][a-z0-9]*)/i);
    i = gt + 1;
    if (!m) continue; // <!doctype>, <?xml?>
    const close = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (!close && DROP.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      const endGt = end < 0 ? -1 : lower.indexOf(">", end);
      i = endGt < 0 ? src.length : endGt + 1;
      continue;
    }
    if (name === "blockquote") {
      flush();
      depth = Math.max(0, depth + (close ? -1 : 1));
      continue;
    }
    if (name === "pre") { flush(); pre = Math.max(0, pre + (close ? -1 : 1)); continue; }
    if (name === "li") { flush(); if (!close) line = "- "; continue; }
    if (name === "td" || name === "th") { if (!close && line.trim()) line += " "; continue; }
    if (name === "a") {
      if (!close) links.push(attr(tag, "href") ?? "");
      else {
        const href = (links.pop() ?? "").trim();
        if (/^(https?:\/\/|www\.)/i.test(href) && !line.includes(href)) line += ` (${decodeEntities(href)})`;
      }
      continue;
    }
    if (name === "br") flush(false);
    else if (BLOCK.has(name)) flush();
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
