// Pull PDF menus out of Primitive's attachments archive (DESIGN.md §11.4).
// Primitive delivers all attachments of an email as one tar.gz; each
// attachment's metadata names its path inside the archive (tar_path).
import { Parser, type ReadEntry } from "tar";

export const MAX_PDF_BYTES = 5 * 1024 * 1024; // §11.2: cap attachments at 5 MB total

export interface PdfFile {
  filename: string;
  data: Buffer;
}

/**
 * Extract the PDFs named in `wanted` (by tar_path) from a tar.gz buffer.
 * Non-PDFs are skipped, and the total stays under `maxBytes`.
 */
export async function extractPdfs(
  archive: Buffer,
  wanted: { tarPath: string; contentType: string; filename: string | null }[],
  maxBytes = MAX_PDF_BYTES,
): Promise<PdfFile[]> {
  const pdfPaths = new Map(
    wanted
      .filter((w) => w.contentType === "application/pdf" || w.tarPath.toLowerCase().endsWith(".pdf"))
      .map((w) => [normalize(w.tarPath), w.filename ?? w.tarPath]),
  );
  if (pdfPaths.size === 0) return [];

  const files: PdfFile[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry: ReadEntry) => {
        const name = pdfPaths.get(normalize(entry.path));
        if (!name || entry.type !== "File" || total + entry.size > maxBytes) {
          entry.resume(); // drain entries we don't keep
          return;
        }
        total += entry.size;
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => files.push({ filename: name, data: Buffer.concat(chunks) }));
      },
    });
    parser.on("end", () => resolve());
    parser.on("error", reject);
    parser.end(archive);
  });

  return files;
}

const normalize = (p: string) => p.replace(/^\.\//, "");
