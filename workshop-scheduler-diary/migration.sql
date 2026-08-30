-- Workshop Scheduler & Diary — dedicated bookings table
--
-- Run this once in the Supabase SQL editor for the shared build-tracker2026
-- project. Does NOT touch the existing `jobs` table — that table is shared
-- with other products on this project and has none of the columns this
-- app needs (no start/end time, title, bay, technician or notes columns
-- at all; its actual columns are customer/reg/model/stage/labor_value/
-- assigned_tech_id/is_clocked_in/seconds_logged/last_clock_timestamp,
-- which look built for a floor-clocking product, not a calendar/diary).
-- Also does not touch bt_trials or bt_subscriptions — those already exist
-- and are reused as-is via PRODUCT_ID = 'workshop-scheduler-diary'.

create table if not exists wsd_bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  service text,
  title text,
  reg text,
  bay text,
  technician text,
  start_time timestamptz,
  end_time timestamptz,
  internal_notes text,
  stage text not null default 'scheduled',
  access_key text,
  timeline jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table wsd_bookings enable row level security;

-- Owner-only access — matches how this app already scopes everything else
-- (plain user_id = auth.uid(), no shop/multi-staff concept in this app,
-- unlike e.g. Body Shop Pro or Electronics Repair).
drop policy if exists "wsd_bookings_owner" on wsd_bookings;
create policy "wsd_bookings_owner" on wsd_bookings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No anon RLS policy on this table at all. The customer-facing portal
-- link (?job=<id>&key=<access_key>, see renderJobs()/loadCustomerPortal())
-- is looked up through the SECURITY DEFINER function below instead, which
-- checks id+access_key itself and returns nothing on a mismatch. A
-- blanket anon SELECT policy here (e.g. "access_key is not null") would
-- let anyone with no key at all dump every booking in the table — RLS
-- can't see what filter the caller applied client-side, only which rows
-- exist at all.
create or replace function public.get_wsd_booking_by_key(p_id uuid, p_key text)
returns setof wsd_bookings
language sql
security definer
set search_path = public
as $$
  select * from public.wsd_bookings
  where id = p_id and p_key is not null and access_key = p_key;
$$;

revoke all on function public.get_wsd_booking_by_key(uuid, text) from public;
grant execute on function public.get_wsd_booking_by_key(uuid, text) to anon, authenticated;
