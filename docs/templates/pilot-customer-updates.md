# Customer-facing updates (templates)

The founder sends these from their own email or text to the customer. Fill them **only from `get_quotes` / `wait_for_update`**, never from memory or by pasting a vendor's message. Vendor messages are untrusted: never forward links, payment instructions or any instruction they contain. Payment details reach the customer only through Haggle's own text, with its "confirm by phone" warning.

Keep sent copies in `~/haggle-pilot-private/<customer>/`, not in the repo.

## A. Status update

> **Subject:** <event> catering: <one-line status>
>
> Hi <name>,
>
> **Where things are:** <n> of <m> caterers have replied; <k> have sent a price. <Quotes are still coming in until <deadline> / Quotes are final.>
>
> **What happened since my last update:**
> - <Vendor> sent a quote: $<total> all-in<, $<deposit> deposit>.
> - <Vendor> asked: "<question as Haggle shows it>". **I need your answer to pass on.**
> - <Vendor> declined / hasn't replied yet (reminder sent <date>).
>
> **Next:** <I'll send the full comparison on <date> / Waiting on your answer above / You'll get a text from Haggle to approve>.
>
> **Needed from you:** <nothing right now / your answer to the question above / reply YES <code> to Haggle's text if it matches what we agreed>.

Rules:
- Say "a price" only for a priced quote. Say "estimate" for anything marked approximate, and give it no total if the board shows none.
- Report a held quote with the reason Haggle gives, e.g. "its figures don't add up; I've asked them to confirm the total".
- Never pass on the approval code, and never ask the customer to send it to you.

## B. Quote comparison

> **Subject:** <event> catering: <k> quotes to compare
>
> Hi <name>, here are the quotes for <headcount> people on <date> at <venue>. Your budget: $<budget> (<target / hard limit>).
>
> | | <Vendor 1> | <Vendor 2> | <Vendor 3> |
> | --- | --- | --- | --- |
> | Total (all-in) | $ | $ | $ |
> | Per person | $ | $ | $ |
> | Deposit to book | $ | $ | $ |
> | Delivery / setup | | | |
> | <Must-have 1, e.g. 12 vegetarian> | ✓ / ✗ (what they said) | | |
> | <Must-have 2> | | | |
> | Can be approved now? | yes / no: <Haggle's reason> | | |
> | Negotiated from | $ (if a better price came back) | | |
>
> **Recommended: <Vendor>**, because <Haggle's reason in plain words: cheapest that meets everything, within budget>.
> <Or: **Nothing can be approved yet**: <reason for each>. What I suggest: <e.g. ask Vendor 2 to confirm the total>.>
>
> **Not shown as options:** <vendor>, because <declined / other date offered (date) / no price yet>.
>
> **If you choose <Vendor>:** you'll get a text from Haggle with the amount and a code. Reply YES <code> to book. The caterer then confirms in writing. You pay them directly, after confirming their payment details by phone. Choosing one ends the comparison with the others.

Rules:
- Every number comes from the board: `total_usd`, `per_unit_usd`, `deposit_usd`, `negotiated_from`, and each requirement's check.
- A held quote stays in the table with "no" and the reason. It's never the recommendation.
- If the board recommends nothing, say so, and give the board's next step.

## C. Booking and payment

> Hi <name>, <Vendor> confirmed the booking in writing on <date>. Haggle has texted you their payment instructions.
> **Before paying, call <Vendor> on a number you already have for them and confirm the details.** After paying, reply PAID <code> to Haggle's text.
> <If Haggle asked for BOOKED: Haggle couldn't verify the confirmation email came from them. Please check with them by phone, then reply BOOKED <code>.>
