-- Build Tracker — Row Level Security lockdown
-- Run this in the Supabase SQL editor for the shared build-tracker2026
-- project. Locks down bt_vehicles, bt_customers, bt_subscriptions and
-- bt_trials with RLS.
--
-- bt_subscriptions and bt_trials are SHARED across every product in this
-- project (Body Shop Pro, Electronics Repair, Stock Control, Purchase
-- Order System, Workshop Scheduler & Diary, Job Card & Workshop Log,
-- Quote Builder, Build Tracker) — this migration affects all of them, not
-- just Build Tracker. bt_vehicles and bt_customers are Build-Tracker-only
-- (confirmed by search — no other product file references them).

-- ── STEP 0 — audit what's there before you change anything ────────────────
-- Run this first. If it returns any policy whose name isn't one this
-- script creates below, note it — a leftover permissive policy (e.g. an
-- auto-generated "Enable read access for all users" using(true) from the
-- table editor) is OR'd together with the restrictive ones this script
-- adds, and would silently keep the table wide open even after this runs.
-- Drop anything unexpected before or after applying this script.

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where tablename in ('bt_vehicles','bt_customers','bt_subscriptions','bt_trials')
order by tablename, policyname;

-- Also confirm the shared trial RPC is SECURITY DEFINER before relying on
-- the SELECT-only bt_trials policy below — if it's SECURITY INVOKER, a
-- SELECT-only policy makes the RPC unable to write trial_start, which
-- breaks trial-starting for every product at once, not just Build Tracker.

select p.proname, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'start_trial_if_missing';
-- prosecdef = true  -> already SECURITY DEFINER, nothing to do.
-- prosecdef = false -> run this (adjust the argument type if it differs):
--   alter function public.start_trial_if_missing(text) security definer;

-- ── bt_vehicles ─────────────────────────────────────────────────────────
alter table bt_vehicles enable row level security;

drop policy if exists "bt_vehicles_owner" on bt_vehicles;
create policy "bt_vehicles_owner" on bt_vehicles
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── bt_customers ────────────────────────────────────────────────────────
alter table bt_customers enable row level security;

drop policy if exists "bt_customers_owner" on bt_customers;
create policy "bt_customers_owner" on bt_customers
  for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- No anon policy is added here on purpose. The public customer portal
-- (renderCustomerPortal() in build-tracker/index.html, no login required)
-- currently reads bt_customers/bt_vehicles directly with the anon key,
-- filtered client-side by .eq('token', token). RLS can't see what filter
-- the client sent — it only sees rows. An anon "using (true)" policy would
-- let anyone holding the anon key (which is public, embedded in every
-- page's source) bulk-download every customer's name/email/phone/token
-- with no filter at all, which defeats the point of a per-customer token.
--
-- Instead: two SECURITY DEFINER functions do the token check server-side
-- and return only the matching rows, bypassing RLS safely because the
-- function itself enforces the narrow filter. These need to exist BEFORE
-- you deploy the matching JS change (portal switches from
-- .from('bt_customers')/.from('bt_vehicles') to .rpc() calls) — see the
-- accompanying code change. Deploy both together; whichever lands first,
-- the portal will error for the gap until both are in place.

create or replace function public.get_customer_by_token(p_token uuid)
returns setof bt_customers
language sql
security definer
set search_path = public
as $$
  select * from bt_customers where token = p_token;
$$;
grant execute on function public.get_customer_by_token(uuid) to anon, authenticated;

create or replace function public.get_vehicles_by_customer_token(p_token uuid)
returns setof bt_vehicles
language sql
security definer
set search_path = public
as $$
  select v.*
  from bt_vehicles v
  join bt_customers c on c.id = v.customer_id
  where c.token = p_token;
$$;
grant execute on function public.get_vehicles_by_customer_token(uuid) to anon, authenticated;

-- ── bt_subscriptions (shared across every product) ─────────────────────
alter table bt_subscriptions enable row level security;

drop policy if exists "bt_subscriptions_read_own" on bt_subscriptions;
create policy "bt_subscriptions_read_own" on bt_subscriptions
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Deliberately SELECT-only — confirmed no product ever inserts/updates/
-- deletes this table client-side. Writes come from the Stripe webhook /
-- create-checkout-session Edge Function using the service_role key, which
-- bypasses RLS entirely regardless of policies here, so it is unaffected
-- by this lockdown. Do NOT add an authenticated write policy: a "for all
-- using (auth.uid() = user_id)" policy would let any signed-in user set
-- their own subscription to 'active' via `.from('bt_subscriptions')
-- .update(...)` from devtools.

-- ── bt_trials (shared across every product) ────────────────────────────
alter table bt_trials enable row level security;

drop policy if exists "bt_trials_read_own" on bt_trials;
create policy "bt_trials_read_own" on bt_trials
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Also deliberately SELECT-only, for the same reason the app moved trial
-- writes into start_trial_if_missing() in the first place (see the
-- comment above ensureTrialStarted() in every product's file: "a
-- signed-in user can no longer reset their own trial via devtools
-- calls"). See STEP 0 above — this policy only works if that RPC is
-- SECURITY DEFINER.
