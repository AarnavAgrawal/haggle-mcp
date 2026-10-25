import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";
import "./landing.css";

export const metadata: Metadata = {
  title: "Haggle",
  description: "Quotes from real businesses by email, phone and text, negotiated and approved in one place.",
};

// Every page renders per request: proxy.ts mints a CSP nonce per request and Next can only put it on the
// scripts of a page it renders then. A prerendered page would ship inline scripts without the nonce,
// which the policy (no 'unsafe-inline' in script-src) blocks.
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
