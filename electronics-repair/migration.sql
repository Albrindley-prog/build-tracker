-- Electronics Repair — finish the migration to repairs_electronics
--
-- Run this once in the Supabase SQL editor for the shared build-tracker2026
-- project. repairs_electronics already exists (device_type, brand, model,
-- fault, customer_name, ticket_ref, status, cost, user_id, created_at) —
-- this only adds what this app's progress-tracking UI needs on top of
-- that, and fixes its RLS so a shop's staff can share one shop's tickets
-- (see below).
--
-- Not touched: bt_trials/bt_subscriptions (reused as-is via PRODUCT_ID =
-- 'electronics-repair'), and the bare `customers`/`jobs` tables this app
-- used to read/write — those are being dropped from this app entirely,
-- not migrated.

alter table repairs_electronics
  add column if not exists stages jsonb not null default '[]',
  add column if not exists parts jsonb not null default '[]',
  add column if not exists notes text;

-- ---------------------------------------------------------------------
-- RLS: shop-wide sharing, not per-user.
--
-- This app scopes every other table (jobs, customers, profiles) by
-- shop_id, with every staff member's profiles.shop_id pointing at their
-- shop's owner's own user id — so "does this row belong to my shop" is
-- "does its user_id match MY profiles.shop_id", not "does it match my
-- own auth.uid()". repairs_electronics.user_id is being repurposed the
-- same way (the app writes profiles.shop_id into it, not the signed-in
-- user's own id) rather than adding a separate shop_id column, matching
-- the trick already used elsewhere in this app.
--
-- Whatever policy already exists on this table today only allows
-- user_id = auth.uid() (confirmed empirically: a second staff account
-- writing a row with another user's id as user_id was rejected with
-- 42501). Postgres combines multiple permissive RLS policies with OR, so
-- this doesn't need to know that policy's name to supersede it — adding
-- the shop-membership policy below is enough on its own to grant the
-- broader access this app needs; the old narrower policy (if still
-- present) just becomes redundant, not a conflict.
-- ---------------------------------------------------------------------
drop policy if exists "repairs_electronics_shop" on repairs_electronics;
create policy "repairs_electronics_shop" on repairs_electronics
  for all
  using (user_id in (select shop_id from public.profiles where id = auth.uid()))
  with check (user_id in (select shop_id from public.profiles where id = auth.uid()));

-- ---------------------------------------------------------------------
-- Customer-facing progress link (?client=<id>, see openJob()'s "Client
-- Progress Link" box). This app has never used a separate secret for
-- this — the ticket's own uuid id IS the capability token (same
-- unguessable-122-bit-random security profile as a generated access key
-- would be), so this preserves that exact existing behaviour rather than
-- inventing a new scheme. No blanket anon SELECT policy is added though
-- — RLS can't see what filter the caller applied, so "anon can read
-- every row" would let anyone with no id at all dump the whole table.
-- This RPC checks the specific id server-side and returns nothing for
-- one that doesn't exist.
-- ---------------------------------------------------------------------
create or replace function public.get_repair_by_id(p_id uuid)
returns setof repairs_electronics
language sql
security definer
set search_path = public
as $$
  select * from public.repairs_electronics where id = p_id;
$$;

revoke all on function public.get_repair_by_id(uuid) from public;
grant execute on function public.get_repair_by_id(uuid) to anon, authenticated;
