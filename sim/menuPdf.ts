// A tiny, dependency-free PDF writer for the simulator's menu attachment
// (DESIGN.md §15: "Le Petit Four attaches a PDF menu"). One page, Helvetica,
// one line of text per entry. Enough for Claude's PDF reader to extract.

function escape(text: string): string {
  // PDF string literals: escape backslashes and parens; drop non-Latin-1.
  return text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");
}

export function makeMenuPdf(title: string, lines: string[]): Buffer {
  const content = [
    "BT",
    "/F1 18 Tf",
    "72 740 Td",
    `(${escape(title)}) Tj`,
    "/F1 12 Tf",
    "0 -30 Td",
    ...lines.flatMap((l) => [`(${escape(l)}) Tj`, "0 -18 Td"]),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
