-- 125_engine_business_hours (owner: Aarnav). A business's published opening hours and timezone, kept
-- with the business so calls and texts reach it only while it is open (not in the first or last 30
-- minutes of an opening interval, in its own timezone, inside the operator's call hours).
--   * job_businesses.opening_hours / timezone: the per-deal snapshot, taken when a found business is put
--     on a deal (its listing, fetched with Amazon Location IntendedUse=Storage, else its own website).
--   * workspace_vendors.opening_hours / timezone / business_ref: the same, kept when a found business is
--     added as a vendor; business_ref ("aws:<PlaceId>" / "place:<id>") is where they came from.
-- opening_hours is WeeklyHours JSON: { timezone, intervals: [{ day 0-6, startMinute, endMinute }],
-- display[], source }. Unknown hours stay null: the engine then keeps its usual contact window.
-- Additive only (nullable columns, no default); no existing check, trigger or policy changes. Safe to re-run.

alter table public.job_businesses add column if not exists opening_hours jsonb
  check (opening_hours is null or (jsonb_typeof(opening_hours) = 'object' and jsonb_typeof(opening_hours->'intervals') = 'array' and pg_column_size(opening_hours) <= 16384));
alter table public.job_businesses add column if not exists timezone text
  check (timezone is null or length(timezone) between 1 and 64);

alter table public.workspace_vendors add column if not exists opening_hours jsonb
  check (opening_hours is null or (jsonb_typeof(opening_hours) = 'object' and jsonb_typeof(opening_hours->'intervals') = 'array' and pg_column_size(opening_hours) <= 16384));
alter table public.workspace_vendors add column if not exists timezone text
  check (timezone is null or length(timezone) between 1 and 64);
alter table public.workspace_vendors add column if not exists business_ref text
  check (business_ref is null or length(business_ref) between 3 and 520);
