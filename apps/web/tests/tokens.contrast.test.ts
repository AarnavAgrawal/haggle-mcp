// The "Ledger" palette (DESIGN.md "Tokens") must stay readable: WCAG AA (4.5:1) for every text token on
// the desk and the sheet, and for button text on the pen, in light and dark. Reads app/globals.css, so a
// token change that breaks contrast fails here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app/globals.css"), "utf8");

/** The `--name: #hex` declarations of one CSS block (the first `{...}` after `start`). */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, hex] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    if (name && hex) out[name] = hex.toLowerCase();
  }
  return out;
}

/** A token's hex, or a failure naming the missing token. */
function hexOf(t: Record<string, string>, name: string): string {
  const hex = t[name];
  if (!hex) throw new Error(`globals.css has no --${name}`);
  return hex;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function blockAfter(marker: string): string {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`globals.css has no "${marker}"`);
  const open = css.indexOf("{", css.indexOf(":root", at));
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  throw new Error(`unclosed block after "${marker}"`);
}

const light = tokens(blockAfter(":root"));
const dark = { ...light, ...tokens(blockAfter("@media (prefers-color-scheme: dark)")) };

function luminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const AA = 4.5;
const textPairs: Array<[string, string]> = [
  ["ink", "desk"],
  ["ink", "sheet"],
  ["ink-2", "desk"],
  ["ink-2", "sheet"],
  ["ink-3", "desk"],
  ["ink-3", "sheet"],
  ["on-pen", "pen"],
  ["on-pen", "pen-strong"],
  ["on-highlight", "highlight"],
];

describe("Ledger tokens: contrast", () => {
  it("parses the palette from globals.css", () => {
    expect(light.desk).toBe("#ecf1e8");
    expect(dark.desk).toBe("#14211a");
    for (const t of new Set(textPairs.flat())) {
      expect(light[t], `light --${t}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(dark[t], `dark --${t}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(light["red-ink"]).toBe("#c0271e");
    expect(dark["red-ink"]).toBe("#ff8a7a");
  });

  for (const [mode, t] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const [fg, bg] of textPairs) {
      it(`${mode}: --${fg} on --${bg} passes AA`, () => {
        expect(contrast(hexOf(t, fg), hexOf(t, bg))).toBeGreaterThanOrEqual(AA);
      });
    }
    // Marks and status are graphics or bold labels; they need at least 3:1 (WCAG 1.4.11) on both papers.
    for (const mark of ["pen", "red-ink", "signed", "hold", "risk"]) {
      for (const bg of ["desk", "sheet"]) {
        it(`${mode}: --${mark} on --${bg} is at least 3:1`, () => {
          expect(contrast(hexOf(t, mark), hexOf(t, bg))).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }

  it("has no blue left in the palette", () => {
    for (const [name, hex] of [...Object.entries(light), ...Object.entries(dark)]) {
      const [r, g, b] = rgb(hex);
      // Blue-dominant: the blue channel clearly above both red and green.
      expect(b - Math.max(r, g), `--${name} ${hex} reads blue`).toBeLessThan(16);
    }
  });
});
