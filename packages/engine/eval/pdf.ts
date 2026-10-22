// A minimal, valid PDF writer for the simulated corpus (WS-F): one Helvetica text block per page,
// correct xref offsets, no compression, deterministic bytes (no dates or ids). Enough for a PDF
// reader (and Claude's document input) to see the text; the deterministic extractor never reads PDFs.
import type { PdfSpec } from "./types.ts";

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");

export function buildPdf(spec: PdfSpec): Uint8Array {
  const n = spec.pages.length;
  // Objects: 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${spec.pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  spec.pages.forEach((lines, i) => {
    const stream = ["BT", "/F1 11 Tf", "14 TL", "56 760 Td", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
