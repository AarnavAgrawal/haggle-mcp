-- 102_engine_stripe.sql (owner: Yash). v5 payment rail: Stripe TEST MODE, beside the v3 x402 rail.
-- x402 rows keep every v3 rule (≤ $10, base-sepolia, exact USDC units, trusted in-thread challenge).
-- Stripe rows:
--   * network 'stripe-test' only (the server also refuses any key that isn't sk_test_);
--   * a charge needs an idempotency key, and money is 'settled' only with a PaymentIntent id;
--   * 'charging' = request sent to Stripe (resumable with the same idempotency key);
--   * amount ≤ $10,000 hard ceiling here; the real limit is the approval's cap (settings ≤ operator
--     ceiling), and the approval-match trigger still requires amount = approved payment_cents.

alter table public.payments add column rail text not null default 'x402' check (rail in ('x402','stripe'));
alter table public.payments add column idempotency_key text unique;
alter table public.payments add column stripe_payment_intent_id text unique check (stripe_payment_intent_id is null or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$');

alter table public.payments drop constraint payments_status_check;
alter table public.payments add constraint payments_status_check check (status in
  ('awaiting_invoice','invoice_received','signed','sent','settled','rejected','expired','failed','charging'));

alter table public.payments drop constraint payments_network_check;
alter table public.payments add constraint payments_network_check check (
  (rail = 'x402' and network = 'base-sepolia') or (rail = 'stripe' and network = 'stripe-test'));

alter table public.payments drop constraint payments_amount_cents_check;
alter table public.payments add constraint payments_amount_cents_check check (
  amount_cents > 0 and ((rail = 'x402' and amount_cents <= 1000) or (rail = 'stripe' and amount_cents <= 1000000)));

-- x402: exact cents <-> USDC base units. Stripe: amount_base_units holds the cents (USD minor units).
alter table public.payments drop constraint payments_check;
alter table public.payments add constraint payments_units_check check (
  (rail = 'x402' and amount_base_units = (amount_cents::numeric * 10000)::text) or (rail = 'stripe' and amount_base_units = amount_cents::text));

alter table public.payments drop constraint payments_check1;
alter table public.payments add constraint payments_settled_proof_check check (
  status <> 'settled' or (rail = 'x402' and settle_tx is not null) or (rail = 'stripe' and stripe_payment_intent_id is not null));

alter table public.payments drop constraint payments_check2;
alter table public.payments add constraint payments_x402_challenge_check check (
  rail <> 'x402' or status not in ('signed','sent','settled') or (challenge_step_id is not null and challenge_trusted and challenge_thread_matched));
alter table public.payments add constraint payments_x402_status_check check (rail <> 'x402' or status <> 'charging');
alter table public.payments add constraint payments_stripe_status_check check (
  rail <> 'stripe' or status in ('charging','settled','failed','rejected'));
alter table public.payments add constraint payments_stripe_key_check check (rail <> 'stripe' or idempotency_key is not null);

-- Money can only move (sign/send/charge/settle) for an approved (or already used) approval.
create or replace function public.haggle_payment_matches_approval() returns trigger
language plpgsql set search_path = '' as $$
declare a record;
begin
  select * into a from public.approvals where id = new.approval_id;
  if a.job_id <> new.job_id or a.business_id <> new.business_id or a.payment_cents <> new.amount_cents then
    raise exception 'payment does not match its approval';
  end if;
  if new.status in ('signed','sent','settled','charging') and a.status not in ('approved','used') then
    raise exception 'payment requires an approved approval';
  end if;
  return new;
end;
$$;

-- Caps: the x402 $10 ceiling now lives on x402 payment rows; jobs/approvals allow Stripe deposits.
alter table public.jobs drop constraint jobs_payment_cap_cents_check;
alter table public.jobs add constraint jobs_payment_cap_cents_check check (payment_cap_cents > 0 and payment_cap_cents <= 1000000);
alter table public.approvals drop constraint approvals_cap_cents_check;
alter table public.approvals add constraint approvals_cap_cents_check check (cap_cents > 0 and cap_cents <= 1000000);
