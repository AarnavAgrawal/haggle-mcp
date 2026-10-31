import type { Metadata } from "next";
import Link from "next/link";
import { Contact, LegalPage } from "../terms/LegalPage";

export const metadata: Metadata = { title: "Acceptable Use · Haggle" };

export default function AcceptableUsePage() {
  return (
    <LegalPage title="Acceptable Use Policy" current="acceptable-use">
      <p>
        Haggle emails, calls and texts real businesses in your name. These rules protect those businesses and keep the Service usable for everyone. They are
        part of the <Link href="/terms">Terms</Link>.
      </p>

      <h2>Do</h2>
      <ul>
        <li>Ask for quotes only for things you genuinely intend to buy if the price and terms are right.</li>
        <li>Describe your request accurately: quantity, date, place and requirements.</li>
        <li>
          Add a business to your workspace only if you are allowed to contact it on the channels you choose, and, where the law requires it (for example for
          automated or AI calls and texts), only with its consent.
        </li>
        <li>Respect a business that says no, asks you to stop, or doesn&apos;t reply.</li>
      </ul>

      <h2>Don&apos;t</h2>
      <ul>
        <li>Use Haggle to harass, spam or flood a business, or to send fake or test requests to real businesses.</li>
        <li>Contact emergency services, hospitals, government lines or personal phone numbers that haven&apos;t agreed to be contacted.</li>
        <li>Request anything illegal where you or the business are, or regulated goods and services (weapons, drugs, alcohol or tobacco where restricted, adult content, gambling).</li>
        <li>Ask Haggle to deny being an AI, to impersonate a person or organization, or to make claims or promises you can&apos;t back up.</li>
        <li>Use Haggle to collect personal information about people, or to scrape or resell business data.</li>
        <li>
          Try to get around Haggle&apos;s safeguards: the spending cap, human approval of every purchase, call hours, rate limits, or the rule that Haggle
          only cites real competing quotes.
        </li>
        <li>Share your account, or use Haggle if you are under 18.</li>
      </ul>

      <h2>What happens if these rules are broken</h2>
      <p>
        We may stop a deal, suspend or close the workspace, and tell affected businesses that the requests were withdrawn. Report misuse at <Contact />.
      </p>
    </LegalPage>
  );
}
