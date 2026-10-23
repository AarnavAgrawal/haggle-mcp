import type { Metadata } from "next";
import Link from "next/link";
import { Contact, LegalPage } from "../terms/LegalPage";

export const metadata: Metadata = { title: "Privacy · Haggle" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This policy explains what [Company legal name] (&quot;Haggle&quot;) collects when you use Haggle, why, who processes it for us, and your choices. It
        also covers the businesses Haggle contacts for you.
      </p>

      <h2>What we collect from you</h2>
      <ul>
        <li>
          <strong>Account:</strong> your email address (or your Google account&apos;s email if you sign in with Google), your sign-in sessions, and when you
          accepted the Terms.
        </li>
        <li>
          <strong>Workspace settings:</strong> workspace name, spending cap, usual area, and an approver phone number if you add one.
        </li>
        <li>
          <strong>Chats:</strong> what you write to Haggle in the app and Haggle&apos;s replies.
        </li>
        <li>
          <strong>Deals:</strong> your requests (what, when, where, budget, requirements), the businesses contacted, quotes, your approvals (who approved,
          when, which quote, the amount and the channel) and whether you reported paying.
        </li>
      </ul>

      <h2>What we collect from businesses</h2>
      <p>
        When Haggle contacts a business for you, we store the messages sent and received (emails, texts, agent-to-agent messages) and, for phone calls, the
        call transcript and outcome. Business contact details (name, email, phone) are stored to reach them. From these conversations Haggle learns facts
        about the business, such as prices, minimums, deposit rules and how fast it replies, and uses them to give estimates to other Haggle users. Your
        identity and the details of your request are not shared with other users. When negotiating, Haggle may tell a business the amount of a competing
        quote, never who quoted it.
      </p>

      <h2>What we don&apos;t collect</h2>
      <p>
        No card or bank details. You pay businesses directly; Haggle never handles your payment. Payment instructions a business sends are stored as part of
        the conversation.
      </p>

      <h2>Who processes data for us</h2>
      <ul>
        <li>
          <strong>Anthropic</strong> (Claude): reads business replies and transcripts, drafts messages, and runs the in-app chat.
        </li>
        <li>
          <strong>Inkbox</strong>: sends and receives Haggle&apos;s email and text messages and places the AI phone calls (including producing call
          transcripts).
        </li>
        <li>
          <strong>Supabase</strong>: our database and sign-in provider.
        </li>
        <li>
          <strong>Cloudflare Turnstile</strong>, when enabled: checks that sign-ins come from a person, not a bot.
        </li>
        <li>
          <strong>Google</strong>, only if you choose &quot;Continue with Google&quot;.
        </li>
        <li>[Hosting provider(s) to be listed before launch.]</li>
      </ul>
      <p>We don&apos;t sell personal data and don&apos;t use it for advertising.</p>

      <h2>How long we keep it</h2>
      <p>
        We keep your data while your account is open. When you delete your account (Account page), we cancel your open deals, turn off your workspace, and
        delete your chats, workspace membership, Terms record and sign-in. Records of deals and of messages and calls with businesses stay on the Haggle server
        for [retention period to be set by counsel] for disputes, fraud prevention and legal obligations, then are deleted. Ask us to delete them sooner at{" "}
        <Contact />.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          <strong>Download your data</strong> on the <Link href="/account">Account</Link> page (your chats and your recent deals as JSON).
        </li>
        <li>
          <strong>Delete your account</strong> on the same page.
        </li>
        <li>
          For anything else (a full copy of deal records, correction, objection), email <Contact />.
        </li>
      </ul>

      <h2>Businesses</h2>
      <p>
        If Haggle contacted your business and you don&apos;t want to hear from it again, reply &quot;stop&quot; or email <Contact />: we stop contacting you
        and record that choice.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit. Access is limited to what each part of Haggle needs; for example, the web app can only act in the workspace you belong to.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We will post updates here and tell you about material changes. Questions: <Contact />.
      </p>
    </LegalPage>
  );
}
