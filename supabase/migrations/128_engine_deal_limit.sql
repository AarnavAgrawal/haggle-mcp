-- 128_engine_deal_limit (owner: Aarnav). The spending limit belongs to the deal, not the workspace.
-- A deal's limit is set when it starts, from the budget the user gave (or the limit they stated), and
-- capped by the server ceiling (HAGGLE_GLOBAL_PAYMENT_CAP_CENTS). With no budget it stays open and is
-- decided at approval (the workspace's default limit for new deals). Pay requires amount <= approved
-- <= the deal's limit <= the server ceiling. Only a human (the web app's signed-in owner) or the
-- operator raises a deal's limit; the agent may only lower it.
--   * jobs.payment_cap_cents: now nullable (null = no limit set yet, decided at approval). The existing
--     check (> 0 and <= 1000000, from 102) passes null and still bounds any value.
--   * jobs.cap_set_by: who set the current limit ('budget', 'agent', 'operator', 'web:<user>', ...).
--   * jobs.cap_set_at: when. Every change is also a 'limit_set' job event (from, to, by).
-- Additive only (a dropped not-null and two nullable columns); no check, trigger or policy changes.
-- Older code still writes a limit on every job and ignores the new columns. Safe to re-run.
-- Rollback: code first; set a value on null rows before restoring not null.

alter table public.jobs alter column payment_cap_cents drop not null;
alter table public.jobs add column if not exists cap_set_by text
  check (cap_set_by is null or char_length(cap_set_by) between 1 and 160);
alter table public.jobs add column if not exists cap_set_at timestamptz;
