#!/usr/bin/env python3
"""Regenerate the buyer-side PDF fixtures (text-only, multi-page, no dependencies).

Usage: python3 -I scripts/fixtures/make_pdf_fixtures.py
Writes into fixtures/buyer/attachments/. Output is deterministic (no timestamps).
"""
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "fixtures" / "buyer" / "attachments"


def pdf_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_pdf(path: Path, pages: list[list[str]]) -> None:
    objects: list[bytes] = []

    def add(obj: str | bytes) -> int:
        objects.append(obj.encode("latin-1") if isinstance(obj, str) else obj)
        return len(objects)

    font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id_placeholder = len(objects) + 1
    add("")  # Pages object, filled in below
    page_ids = []
    for lines in pages:
        ops = ["BT", "/F1 11 Tf", "14 TL", "56 740 Td"]
        for line in lines:
            ops.append(f"({pdf_escape(line)}) Tj T*")
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        page_ids.append(
            add(
                f"<< /Type /Page /Parent {pages_id_placeholder} 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {content} 0 R >>"
            )
        )
    kids = " ".join(f"{p} 0 R" for p in page_ids)
    objects[pages_id_placeholder - 1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()
    catalog = add(f"<< /Type /Catalog /Pages {pages_id_placeholder} 0 R >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


FIXTURES = {
    # Trap 4: the deposit only appears on page 2.
    "golden-gate-quote-hidden-deposit.pdf": [
        [
            "Golden Gate Kitchen - Catering Quote",
            "Prepared for: Haggle job request, Thursday October 22, 2026",
            "",
            "28 x Chicken shawarma plate          $24.00     $672.00",
            "12 x Falafel plate (vegetarian)      $22.00     $264.00",
            "Delivery to San Francisco            included",
            "",
            "Subtotal                                        $936.00",
            "Total (tax included)                          $1,016.00",
            "",
            "See page 2 for terms.",
        ],
        [
            "Terms and conditions",
            "",
            "1. A non-refundable deposit of 30% of the total ($304.80) is due",
            "   at booking to hold the date.",
            "2. Balance due on delivery.",
            "3. Quote valid until October 19, 2026.",
            "4. Cancellations within 48 hours forfeit the deposit.",
        ],
    ],
    # Additional: fee details spread over three pages.
    "sunset-bistro-multipage-fees.pdf": [
        [
            "Sunset Bistro - Event Catering Proposal",
            "40 boxed lunches, of which 14 vegetarian",
            "Boxed lunch                     40 x $22.50     $900.00",
            "Continued on next page.",
        ],
        [
            "Service charges",
            "Delivery and setup fee                           $60.00",
            "Service charge (8%)                              $72.00",
        ],
        [
            "Tax",
            "Sales tax is not included above and will be added at 8.5%",
            "on the food subtotal.",
            "Quote valid for 5 days from issue.",
        ],
    ],
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, pages in FIXTURES.items():
        write_pdf(OUT / name, pages)
        print(f"wrote {OUT / name}")


if __name__ == "__main__":
    main()
