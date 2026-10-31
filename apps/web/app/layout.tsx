import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Haggle",
  description: "Quotes from real businesses by email, phone and text, negotiated and approved in one place.",
};

// One family, two voices: text at normal width, prices and the wordmark expanded (the wdth axis).
// next/font self-hosts the files, so the CSP's font-src 'self' covers them.
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });

// Every page renders per request: proxy.ts mints a CSP nonce per request and Next can only put it on the
// scripts of a page it renders then. A prerendered page would ship inline scripts without the nonce,
// which the policy (no 'unsafe-inline' in script-src) blocks.
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en" className={archivo.variable}>
      <body>{children}</body>
    </html>
  );
}
