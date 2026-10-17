// Pull attachments out of Primitive's attachments archive (one tar.gz per email; each
// attachment's metadata names its tar_path).
//
// Adapted from quote-broker@8a68559 src/parser/attachments.ts (Partner). Changes for Haggle v3:
// generalised from PDFs to an allowlist of kinds, so the same reader also returns the
// `quote.json` / `interaction.json` protocol parts, each with its own size cap.
import { Parser, type ReadEntry } from "tar";

export const MAX_PDF_BYTES = 5 * 1024 * 1024; // total across PDFs in one email
export const MAX_JSON_BYTES = 64 * 1024; // per JSON part (Primitive caps interaction.json at 64 KiB)
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // total across images in one email (photo of a price sheet)

/** Images the parser can read (Claude vision); image/jpg is normalised to image/jpeg. */
export const IMAGE_CONTENT_TYPES: Record<string, string> = { "image/png": "image/png", "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/gif": "image/gif", "image/webp": "image/webp" };
const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export type AttachmentKind = "pdf" | "json" | "image";

/** The image media type for an attachment (by content type, else extension), or null. */
export function imageContentType(contentType: string, filename: string | null): string | null {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (IMAGE_CONTENT_TYPES[ct]) return IMAGE_CONTENT_TYPES[ct]!;
  const name = (filename ?? "").toLowerCase();
  const ext = Object.keys(IMAGE_EXT).find((e) => name.endsWith(e));
  return ext ? IMAGE_EXT[ext]! : null;
}

export interface WantedAttachment {
  tarPath: string;
  contentType: string;
  filename: string | null;
}

export interface ExtractedFile {
  kind: AttachmentKind;
  filename: string;
  data: Buffer;
  /** Images only: the normalised media type (image/png, image/jpeg, image/gif, image/webp). */
  contentType?: string;
}

export type PdfFile = ExtractedFile & { kind: "pdf" };
export type ImageFile = ExtractedFile & { kind: "image"; contentType: string };

export function attachmentKind(a: WantedAttachment): AttachmentKind | null {
  const ct = a.contentType.toLowerCase().split(";")[0]!.trim();
  const name = (a.filename ?? a.tarPath).toLowerCase();
  if (ct === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (ct === "application/json" || name.endsWith(".json")) return "json";
  if (imageContentType(ct, name)) return "image";
  return null;
}

/**
 * Extract the allowed attachments named in `wanted` (by tar_path) from a tar.gz buffer.
 * Anything else is skipped; PDFs stay under `maxPdfBytes` in total, JSON parts under
 * `maxJsonBytes` each.
 */
export async function extractAttachments(
  archive: Buffer,
  wanted: WantedAttachment[],
  limits: { maxPdfBytes?: number; maxJsonBytes?: number } = {},
): Promise<ExtractedFile[]> {
  const maxPdf = limits.maxPdfBytes ?? MAX_PDF_BYTES;
  const maxJson = limits.maxJsonBytes ?? MAX_JSON_BYTES;
  const byPath = new Map<string, { kind: AttachmentKind; name: string }>();
  for (const w of wanted) {
    const kind = attachmentKind(w);
    // Legacy Primitive archives: PDFs and JSON parts only (images are read on the Inkbox path).
    if (kind && kind !== "image") byPath.set(normalize(w.tarPath), { kind, name: w.filename ?? w.tarPath });
  }
  if (byPath.size === 0) return [];

  const files: ExtractedFile[] = [];
  let pdfTotal = 0;

  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry: ReadEntry) => {
        const hit = byPath.get(normalize(entry.path));
        const tooBig = !hit || (hit.kind === "pdf" ? pdfTotal + entry.size > maxPdf : entry.size > maxJson);
        if (!hit || entry.type !== "File" || tooBig) {
          entry.resume(); // drain entries we don't keep
          return;
        }
        if (hit.kind === "pdf") pdfTotal += entry.size;
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => files.push({ kind: hit.kind, filename: hit.name, data: Buffer.concat(chunks) }));
      },
    });
    parser.on("end", () => resolve());
    parser.on("error", reject);
    parser.end(archive);
  });

  return files;
}

export async function extractPdfs(archive: Buffer, wanted: WantedAttachment[], maxBytes = MAX_PDF_BYTES): Promise<PdfFile[]> {
  const files = await extractAttachments(
    archive,
    wanted.filter((w) => attachmentKind(w) === "pdf"),
    { maxPdfBytes: maxBytes },
  );
  return files as PdfFile[];
}

const normalize = (p: string) => p.replace(/^\.\//, "");
