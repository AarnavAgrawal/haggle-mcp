-- 127_engine_vendor_category (owner: Aarnav). What each workspace vendor does ("plumbing", "catering"),
-- so a deal contacts only the workspace's vendors for that kind of request and never an unrelated one.
-- Before this, vendors had no category and deal treated every workspace vendor as a caterer: a
-- plumbing request found "no vendors" even with plumbers added.
--   * workspace_vendors.category: the request category it serves (apps/mcp/src/businesses.ts
--     CATEGORIES, e.g. catering, plumbing, electrical, repairs, cleaning, moving, printing, rentals,
--     photography, entertainment), set when the vendor is added (the search it came from, or the type
--     the user picked) and changeable on the Vendors page. Null = not set yet: the server infers it
--     from the vendor's name, and a vendor it can't place is never contacted by default.
-- Additive only (nullable column, no default); no existing check, trigger or policy changes. Safe to re-run.

alter table public.workspace_vendors add column if not exists category text
  check (category is null or category ~ '^[a-z][a-z_ ]{1,39}$');
