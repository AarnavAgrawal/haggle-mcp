import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { create } from "tar";
import { extractPdfs } from "../src/parser/attachments.js";

const dir = mkdtempSync(join(tmpdir(), "qb-attach-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function makeArchive(): Promise<Buffer> {
  const src = join(dir, "src");
  mkdirSync(join(src, "parts"), { recursive: true });
  writeFileSync(join(src, "parts", "menu.pdf"), "%PDF-1.4 fake menu");
  writeFileSync(join(src, "parts", "logo.png"), "not a pdf");
  writeFileSync(join(src, "parts", "big.pdf"), "%PDF-1.4 " + "x".repeat(2000));
  const out = join(dir, "a.tar.gz");
  await create({ gzip: true, file: out, cwd: src }, ["parts/menu.pdf", "parts/logo.png", "parts/big.pdf"]);
  return readFileSync(out);
}

describe("extractPdfs", () => {
  it("returns only the requested PDFs", async () => {
    const archive = await makeArchive();
    const files = await extractPdfs(archive, [
      { tarPath: "parts/menu.pdf", contentType: "application/pdf", filename: "Menu.pdf" },
      { tarPath: "parts/logo.png", contentType: "image/png", filename: "logo.png" },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toBe("Menu.pdf");
    expect(files[0]!.data.toString()).toBe("%PDF-1.4 fake menu");
  });

  it("respects the total size cap", async () => {
    const archive = await makeArchive();
    const files = await extractPdfs(
      archive,
      [
        { tarPath: "parts/menu.pdf", contentType: "application/pdf", filename: null },
        { tarPath: "parts/big.pdf", contentType: "application/pdf", filename: null },
      ],
      100,
    );
    expect(files.map((f) => f.filename)).toEqual(["parts/menu.pdf"]);
  });

  it("returns nothing when no PDFs are listed", async () => {
    expect(await extractPdfs(await makeArchive(), [])).toEqual([]);
  });
});
