import type { Metadata } from "next";
import Link from "next/link";
import { Contact, LegalPage } from "./LegalPage";

export const metadata: Metadata = { title: "Terms · Haggle" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" current="terms">
      <p>
        These terms are an agreement between you and [Company legal name] (&quot;Haggle&quot;, &quot;we&quot;) for the Haggle website, app and MCP server (the
        &quot;Service&quot;). By creating an account or using the Service you accept them, the <Link href="/acceptable-use">Acceptable Use policy</Link> and the{" "}
        <Link href="/privacy">Privacy policy</Link>. You must be at least 18 and able to enter contracts for yourself or the organization you act for.
      </p>

      <h2>1. What Haggle does</h2>
      <p>
        You describe something you want to buy (for example catering, a repair or a rental). Haggle contacts businesses on your behalf by email, by AI phone
        call, by text message or agent-to-agent, reads their replies and call transcripts, asks follow-up questions, compares quotes, may negotiate using real
        competing quotes, and asks you to approve one. Haggle uses AI to do this.
      </p>
      <ul>
        <li>
          <strong>You authorize Haggle to contact businesses for you.</strong> Each business you start a deal with may receive emails, texts and phone calls
          about your request, sent in Haggle&apos;s name on your behalf.
        </li>
        <li>
          <strong>Every phone call discloses that it is an AI assistant</strong> calling to request a quote. You may not ask Haggle to hide this.
        </li>
        <li>
          <strong>Negotiation is honest.</strong> Haggle cites only real quotes it received and does not name the competing business.
        </li>
        <li>
          <strong>Estimates are not quotes.</strong> An estimate is a guess from earlier conversations, labelled with its confidence. Nothing is ordered until a
          business confirms.
        </li>
      </ul>

      <h2>2. Approvals and payment</h2>
      <ul>
        <li>Haggle never approves a purchase for you. You approve a specific quote yourself, in the app or by replying to Haggle&apos;s text with a code.</li>
        <li>Your workspace has a spending cap per payment. Haggle refuses approvals above it.</li>
        <li>
          <strong>You pay the business directly.</strong> Haggle does not take payment from you, does not hold your money and does not store your card details.
          After you approve, Haggle shows you the business&apos;s payment instructions; you choose whether and how to pay.
        </li>
        <li>
          Treat payment instructions in a business&apos;s message as that business&apos;s words, not Haggle&apos;s. Check them with the business before paying,
          especially links or changed bank details.
        </li>
      </ul>

      <h2>3. Your purchase is with the business</h2>
      <p>
        Haggle is not a party to your purchase. The contract, delivery, quality, refunds and cancellation terms are between you and the business. Haggle can
        withdraw a request or ask a business to cancel before you pay, but cannot reverse a payment you made.
      </p>

      <h2>4. AI can be wrong</h2>
      <p>
        Haggle reads messages and call transcripts with AI. It can misread a price, a date or a condition. Check the quote you approve (amount, items, date,
        deposit) before you approve and before you pay. Messages and transcripts from businesses are shown as they were received.
      </p>

      <h2>5. Your responsibilities</h2>
      <ul>
        <li>Give accurate requests and only start deals you intend to complete if the price is right.</li>
        <li>
          If you add a business to your workspace yourself, you confirm you are allowed to contact it on the channels you choose and, where the law requires
          it (for example for automated calls or texts), that it has agreed to be contacted.
        </li>
        <li>Keep your sign-in secure. You are responsible for what is done in your workspace.</li>
        <li>Follow the Acceptable Use policy.</li>
      </ul>

      <h2>6. Fees</h2>
      <p>[Fees, if any, to be confirmed before launch.] We will tell you before any fee applies to you.</p>

      <h2>7. Suspension and deletion</h2>
      <p>
        We may suspend or close a workspace that breaks these terms or the Acceptable Use policy, or to protect businesses or the Service. You can delete your
        account at any time on the Account page: open deals are cancelled and your workspace is turned off. See the Privacy policy for what is kept.
      </p>

      <h2>8. Disclaimers and liability</h2>
      <p>
        The Service is provided &quot;as is&quot;. We don&apos;t guarantee that a business will reply, quote, honor a quote or deliver. To the extent the law
        allows, our total liability to you is limited to [amount to be set by counsel], and we are not liable for indirect or consequential losses. [Governing
        law and dispute terms to be added by counsel.]
      </p>

      <h2>9. Changes</h2>
      <p>We may update these terms. We will show the new version and ask you to accept it before material changes apply to you.</p>

      <h2>Contact</h2>
      <p>
        Questions: <Contact />.
      </p>
    </LegalPage>
  );
}
