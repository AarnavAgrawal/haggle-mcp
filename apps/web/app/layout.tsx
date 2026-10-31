import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Schibsted_Grotesk } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";
import "@/components/ui/ui.css";

export const metadata: Metadata = {
  title: "Haggle",
  description: "Quotes from real businesses by email, phone and text, negotiated and approved in one place.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef0f3" },
    { media: "(prefers-color-scheme: dark)", color: "#0c1220" },
  ],
};

// Two voices (DESIGN.md): Bricolage Grotesque for the wordmark, headings and every price (variable,
// with its optical-size and width axes); Schibsted Grotesk for everything else. next/font self-hosts
// the files, so the CSP's font-src 'self' covers them.
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"], variable: "--font-bricolage", display: "swap" });
const schibsted = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });

// Every page renders per request: proxy.ts mints a CSP nonce per request and Next can only put it on the
// scripts of a page it renders then. A prerendered page would ship inline scripts without the nonce,
// which the policy (no 'unsafe-inline' in script-src) blocks.
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en" className={`${bricolage.variable} ${schibsted.variable}`}>
      <body>{children}</body>
    </html>
  );
}
