/**
 * Harbor Table's 2-page PDF quote. Page 1 is the friendly summary; the 30% deposit only appears
 * in the terms on page 2 — exactly what Haggle's parser must catch (flag: hidden_deposit).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { usd, type QuoteFacts } from "./logic.ts";
import type { Persona } from "./personas.ts";

export async function quotePdfBase64(p: Persona, f: QuoteFacts, now: Date = new Date()): Promise<string> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${p.name} quote`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.13, 0.16);
  const muted = rgb(0.4, 0.45, 0.5);

  // Page 1: summary
  const page1 = doc.addPage([612, 792]);
  let y = 730;
  const line = (page: typeof page1, text: string, size = 11, f = font, color = ink, x = 60) => {
    page.drawText(text, { x, y, size, font: f, color });
    y -= size + 9;
  };
  line(page1, p.name, 22, bold);
  line(page1, "Catering quote", 13, font, muted);
  y -= 8;
  line(page1, `Prepared ${now.toISOString().slice(0, 10)}${f.date ? ` for ${f.date}` : ""}`, 10, font, muted);
  line(page1, `Guests: ${f.quantity}`, 11);
  y -= 10;
  line(page1, "Menu", 13, bold);
  for (const item of f.items) line(page1, `-  ${item}`);
  y -= 10;
  line(page1, `Food (${f.quantity} x ${usd(f.foodSubtotal / f.quantity)})`, 11);
  if (f.negotiatedFrom !== undefined) line(page1, `Revised from ${usd(f.negotiatedFrom)}`, 11, font, muted);
  line(page1, `Total: ${usd(f.total)}`, 15, bold);
  y -= 6;
  line(page1, "Delivery and setup included. See page 2 for terms.", 10, font, muted);

  // Page 2: terms, with the deposit
  const page2 = doc.addPage([612, 792]);
  y = 730;
  line(page2, "Terms and conditions", 15, bold);
  y -= 4;
  const terms = [
    "1. This quote is valid for 7 days from the date prepared.",
    f.depositUsd !== undefined && f.depositPct !== undefined
      ? `2. A non-refundable deposit of ${Math.round(f.depositPct * 100)}% (${usd(f.depositUsd)}) is due on booking.`
      : "2. No deposit is required.",
    "3. Final headcount is due 72 hours before the event.",
    "4. Cancellations within 48 hours are charged in full.",
  ];
  for (const t of terms) line(page2, t, 10);

  return doc.saveAsBase64();
}
