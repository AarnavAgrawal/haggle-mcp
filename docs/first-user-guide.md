# Getting started with Haggle (pilot customers)

Haggle gets catering and small-event quotes for you from local vendors, by email, text and phone. It
compares the quotes, then books the one you approve. You talk to it through your AI assistant:
Claude, ChatGPT or Claude Code.

During the pilot:
- Haggle contacts only the vendors your operator set up with you, each of whom agreed to hear from Haggle.
- Nothing is booked until you approve it from your own phone.
- You pay the vendor directly. No money moves through Haggle.

## 1. Connect your assistant

Your operator gives you a private connection, through a password manager or another channel meant
for secrets. Treat it like a password. Never paste it into a chat, an email or a screenshot.

| Assistant | What you do |
| --- | --- |
| **Claude Code** | Run the `claude mcp add --transport http haggle ...` command from the connection details once, in a terminal. |
| **Claude** (web or desktop) | Settings → Connectors → add a custom connector, and paste the **connector URL** (`https://.../c/.../mcp`). Whether your Claude plan allows custom connectors is up to Anthropic; ask your operator if the option is missing. |
| **ChatGPT** | Add a custom connector (developer mode) with the **connector URL**. Availability depends on your ChatGPT plan; ask your operator if it is missing. |

To check the connection, ask: *"Is Haggle connected? What can it do?"* Every Haggle answer says
whether it is **live** (real vendors) or **DEMO** (simulated, nothing real). On your pilot it should
say live.

If your assistant reports `UNAUTHORIZED`, the connection details are wrong or were replaced. If it
reports `WORKSPACE_SUSPENDED`, your operator has paused your account. Contact your operator in
either case.

## 2. Ask for what you need

Describe the order the way you'd tell a colleague: what, how many, when, where, any dietary needs,
and your budget.

> Get catering quotes for our team offsite lunch: 60 people, Saturday November 14, delivered to
> 500 Howard St by 11:30am. 12 vegetarian, nut-free. Budget under $2,500.

> Use Harbor Table and Golden Grill only: breakfast for 25 next Friday at 8am, budget about $600.

> What happened with the lunch catering deal from last week?

Your assistant calls Haggle's `deal` tool and shows a deal board. You don't need to give vendor
emails or phone numbers: Haggle already has them for your vendors.

If something is unclear (a date it can't read, a missing headcount), your assistant asks you. Haggle
never guesses an amount or a detail.

## 3. What to expect

| When | What happens | What you do |
| --- | --- | --- |
| Right away | Haggle sends each vendor a quote request, during business hours only. Requests made in the evening go out the next business morning. | Nothing |
| Minutes to hours | Vendors reply. Haggle reads each reply, including attachments and call notes, and adds the quote to the deal board. | Nothing. Ask your assistant *"any quotes yet?"* whenever you like. |
| If a vendor asks something | The question shows up in your chat or comes to you by text. | Answer it. Haggle passes on only what you said. |
| Quotes are in | Haggle compares them on price, what's included, deposit and your must-haves. It may ask the vendors once for a better price, citing only real competing quotes. Approximate prices are marked as approximate. | Read the comparison. Ask *"why this one?"* or *"compare the top two"*. |
| You choose | Your assistant asks Haggle for your approval. Haggle **texts your phone** a summary and a code. | Reply `YES 4821` (your code) to book it, or `NO 4821` to decline. |
| After YES | Haggle asks the vendor to confirm the booking in writing. | Wait. If the vendor confirmed by text, or Haggle can't verify who sent its email, Haggle texts you: check with the vendor, then reply `BOOKED <code>`. |
| Booking confirmed | The vendor sends payment instructions. Haggle passes them on with a reminder to check them with the vendor before paying. | Pay the vendor directly (§4), then reply `PAID <code>`. |

To cancel a booking the vendor already confirmed, ask your assistant; Haggle then texts you a code and cancels only when you reply `CANCEL <code>`.

Your assistant can't approve for you. Approval comes only from the text to your phone, never from the
chat, so an AI can't book anything on its own.

## 4. Payment during the pilot

- **You pay the vendor yourself**, using the vendor's own payment method: card on its site, invoice,
  bank transfer. Haggle never takes your card details and never moves money.
- Pay only after Haggle tells you the vendor **confirmed the booking**. If the payment details came by
  email or text, confirm them with the vendor by phone first. Haggle never opens payment links.
- After paying, reply `PAID <code>` so Haggle knows. It records that **you reported** paying. It
  counts the payment as received only when the vendor confirms it.
- To cancel, tell your assistant *"cancel the catering deal"*. Before you've paid, Haggle tells the
  vendors that quoted, and nothing more is sent. After you've paid, Haggle can't refund anything:
  contact the vendor about its cancellation terms.

## 5. What Haggle never does

- It never pays, charges a card or moves money on the pilot.
- It never books anything without your `YES <code>` text. It never takes an approval from the chat,
  from the AI, or from a vendor.
- It never contacts businesses your operator didn't set up with their agreement. It never contacts
  anyone who asked to stop.
- It never follows links or instructions found in vendors' messages, and it never passes on payment
  requests as anything but information for you to check.
- It never invents prices, savings or details. Estimates are labelled as estimates, and
  negotiation cites only real quotes.
- It never pretends to be human. Calls and messages say they come from an AI assistant acting for a
  customer.
- It never shows your other deals to a vendor, or your deals and messages to other Haggle customers.
  One limit during the pilot: prices Haggle learns from vendors' quotes can feed the rough estimates
  (`ask`) it gives other customers. Those estimates are never presented as quotes.

## 6. Example session

> **You:** Get quotes for lunch for 40 people next Thursday at noon at our office, 12 vegetarian,
> under $1,800.
>
> **Assistant:** Haggle contacted 3 of your vendors (Harbor Table by email, Golden Grill by email,
> Sunset Kitchen by text). I'll check back for quotes.
>
> **You:** Any quotes yet?
>
> **Assistant:** Two so far: Harbor Table $1,150 all-in with a $345 deposit, and Golden Grill about
> $1,300 (approximate: delivery not confirmed). Sunset Kitchen hasn't replied. Harbor Table meets every
> requirement and is the cheapest.
>
> **You:** Go with Harbor Table.
>
> **Assistant:** Haggle texted your phone the approval request. Reply YES with the code to book it.
>
> *(Your phone, a text from Haggle that names the vendor, the total and the deposit, and ends like)*
> "... reply YES 4821 to approve. (HG-7KQ2)"

The wording of the texts varies with the deal. Two parts never change: the 4-digit code you reply
with, and the `HG-` deal code. If you have several deals open, put the deal code in your reply, for
example `YES 4821 HG-7KQ2`.

## 7. Help

- *"Show my deals"* lists them. *"Show the Harbor Table conversation"* shows every message on a deal.
- Something looks wrong, or a vendor says something unexpected: tell your operator. They can pause a
  deal, close it, or check with the vendor. They can't approve or pay for you either.
