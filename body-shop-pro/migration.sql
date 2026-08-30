-- Body Shop Pro — fork onto its own dedicated tables
--
-- Run this once in the Supabase SQL editor for the shared build-tracker2026
-- project. This app previously read/wrote the shared `bs_jobs`/`bs_staff`
-- tables, which turned out to hold Workshop Tracker's real, live production
-- data (Alan's own bodyshop — real staff PINs/pay rates, real jobs, weeks
-- of history) scoped by `tenant_id`, with no column distinguishing which
-- product a row belonged to. Body Shop Pro scopes by `shop_id` instead,
-- which for the same signed-in user resolves to the same value as
-- Workshop Tracker's `tenant_id` — meaning the two products' data would
-- collide in the same rows the moment one account used both.
--
-- Investigation (2026-08-30) confirmed: of 16 bs_jobs rows and 10 bs_staff
-- rows live, only ONE bs_jobs row is Body-Shop-Pro-shaped (a one-time
-- dev-test row from 2026-06-08, "customer: alan brindley", no
-- bt_trials/bt_subscriptions row for product='body-shop-pro' ever created
-- for anyone) — everything else is Workshop Tracker's real data. That
-- stray row is NOT migrated here; Body Shop Pro starts these new tables
-- empty, exactly as if it were a brand new product (which, functionally,
-- it always has been — bs_jobs/bs_staff's RLS has required
-- tenant_id = auth.uid()::text since 2026-08-06, which Body Shop Pro's
-- code never sets, so its own reads/writes against those tables have been
-- silently failing anyway).
--
-- This migration does NOT touch bs_jobs, bs_staff, bs_customers, or any
-- Workshop Tracker table, query, or policy in any way — new tables only.

create table if not exists bsp_jobs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references auth.users(id) on delete cascade,
  job_number text,
  registration text,
  customer text,
  vehicle text,
  phone text,
  email text,
  status text,
  damage text,
  estimate numeric,
  date_in date,
  date_out date,
  progress integer not null default 0,
  notes text,
  parts jsonb not null default '[]',
  stages jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists bsp_staff (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists bsp_customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  company text,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now()
);

alter table bsp_jobs enable row level security;
alter table bsp_staff enable row level security;
alter table bsp_customers enable row level security;

-- Shop-wide access, not per-account: an owner's own shop_id is their own
-- user id (register() never sets shop_id in metadata, so the app's own
-- `shopId = meta.shop_id || currentUser.id` falls back to that); an
-- invited staff member's shop_id is embedded in THEIR OWN account's
-- metadata by inviteStaff() (`options.data.shop_id = shopId` at signup),
-- which Supabase mirrors into their JWT as user_metadata — so it can be
-- read straight off auth.jwt() with no extra table lookup (unlike
-- Electronics Repair's equivalent, which needed a join to `profiles`
-- because that app's shop_id doesn't live in the JWT).
create policy "bsp_jobs_shop" on bsp_jobs
  for all
  using (
    shop_id = auth.uid()
    or shop_id = nullif(auth.jwt() -> 'user_metadata' ->> 'shop_id', '')::uuid
  )
  with check (
    shop_id = auth.uid()
    or shop_id = nullif(auth.jwt() -> 'user_metadata' ->> 'shop_id', '')::uuid
  );

create policy "bsp_staff_shop" on bsp_staff
  for all
  using (
    shop_id = auth.uid()
    or shop_id = nullif(auth.jwt() -> 'user_metadata' ->> 'shop_id', '')::uuid
  )
  with check (
    shop_id = auth.uid()
    or shop_id = nullif(auth.jwt() -> 'user_metadata' ->> 'shop_id', '')::uuid
  );

create policy "bsp_customers_shop" on bsp_customers
  for all
  using (
    shop_id = auth.uid()
    or shop_id = nullif(auth.jwt() -> 'user_metadata' ->> 'shop_id', '')::uuid
  )
  with check (
    shop_id = auth.uid()
    or shop_id = nullif(auth.jwt() -> 'user_metadata' ->> 'shop_id', '')::uuid
  );
