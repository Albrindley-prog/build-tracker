-- Courtesy Car Manager — database setup
--
-- Run this once in the Supabase SQL editor for the shared build-tracker2026
-- project. It creates new ccm_* tables, functions and one private storage
-- bucket (ccm-files) only. It does NOT touch any other product's tables,
-- bt_trials or bt_subscriptions (reused as-is via PRODUCT_ID =
-- 'courtesy-car-manager'), or any existing policy.
--
-- Safe to re-run — CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- DROP POLICY IF EXISTS / ON CONFLICT throughout.
--
-- ── How "each garage only sees its own data" works ──────────────────────
-- Every row carries company_id (the garage). A login belongs to exactly one
-- garage via ccm_members, which only SECURITY DEFINER functions ever write
-- (same safe pattern as Stock Control's sc_team_members — never anything
-- the client can edit, unlike a shop_id kept in user_metadata). In version 1
-- every account is its own garage: ccm_resolve_company() makes the caller
-- the owner of a garage whose id is their own user id, on first load. Staff
-- logins later = an invite RPC that adds a 'staff' row; no data migration.
--
-- Every RLS policy is `company_id = (select ccm_my_company())`. The
-- `(select …)` wrapper makes Postgres evaluate it once per query, not per
-- row.
--
-- ── Why loans are written only through functions ─────────────────────────
-- Hand-over (ccm_check_out) and return (ccm_check_in) are SECURITY DEFINER
-- functions, and authenticated has no INSERT/UPDATE on the loan tables at
-- all. That makes the MOT/tax/insurance block and "car must be available"
-- impossible to bypass from the browser, stops two staff handing out the
-- same car at once, and means a signed agreement (mileage, fuel, damage,
-- terms, signature) can't be edited after the customer signed it.
--
-- ── Files ────────────────────────────────────────────────────────────────
-- Private bucket ccm-files, paths <company_id>/<loan_id>/...:
--   <company>/<loan>/out/...        hand-over photos, damage photos, signature
--   <company>/<loan>/in/...         return photos, damage photos
--   <company>/<loan>/handover.pdf   the signed agreement
-- Read/upload only inside your own garage's folder. No overwriting ever.
-- Delete only for photo retakes: before the hand-over is saved, or return
-- photos while the car is still out. Once saved, files are locked.
--
-- All "today" logic uses Europe/London, never server UTC.


-- =========================================================================
-- 1. Garage membership
-- =========================================================================
create table if not exists public.ccm_members (
  company_id uuid not null references auth.users(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

-- One garage per login (same rule Stock Control and Workshop Tracker use).
create unique index if not exists ccm_members_one_company_per_user
  on public.ccm_members (user_id);

-- The caller's garage id, or null if they haven't been set up yet (null
-- matches nothing, so an unset-up login sees nothing). SECURITY DEFINER so
-- its read of ccm_members isn't itself subject to ccm_members' RLS.
create or replace function public.ccm_my_company()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.ccm_members where user_id = auth.uid();
$$;

revoke all on function public.ccm_my_company() from public, anon;
grant execute on function public.ccm_my_company() to authenticated;


-- =========================================================================
-- 2. Settings (one row per garage)
-- =========================================================================
create table if not exists public.ccm_settings (
  company_id             uuid primary key references auth.users(id) on delete cascade,
  garage_name            text,
  garage_address         text,
  garage_phone           text,
  garage_email           text,
  terms_text             text not null default $terms$COURTESY CAR AGREEMENT — TERMS AND CONDITIONS

1. The vehicle is lent to you while your own vehicle is with us. It remains our property at all times.

2. Only the driver named on this agreement may drive the vehicle. The driver must hold a full, valid UK driving licence and meet the requirements of our motor insurance, and must tell us about any endorsements, disqualifications or medical conditions that affect their driving.

3. Return the vehicle by the date and time shown, with at least the same fuel level and in the same condition as at hand-over (fair wear and tear excepted). Late returns may be charged per day at the rate shown on this agreement.

4. Mileage above the allowance shown will be charged per mile at the rate shown. Fuel below the hand-over level will be charged per eighth of a tank at the rate shown.

5. You are responsible for all fines and charges incurred during the loan, including speeding, parking and bus lane penalties, congestion, clean air zone and toll charges. We will pass your details to the issuing authority and may charge an administration fee.

6. You are responsible for any loss of or damage to the vehicle during the loan, up to the amount of our insurance excess, and in full for any loss or damage our insurance does not cover. Damage recorded on this agreement at hand-over is not your responsibility.

7. Report any accident, damage, fault, theft or warning light to us immediately. Do not arrange repairs yourself.

8. The vehicle must not be used for hire or reward, driving tuition, racing, rallying or towing, or be taken outside the UK, without our written permission. No smoking or vaping in the vehicle.

9. Keep the vehicle locked when unattended and keep the keys secure. Never leave keys or documents in the vehicle.

10. We may ask for the vehicle back at any time, and may recover it if it is not returned as agreed.

11. The personal details on this agreement, including your driving licence details, are used only to manage this loan and to meet our legal obligations (for example, responding to a notice of intended prosecution).$terms$,
  mileage_allowance      integer       not null default 100   check (mileage_allowance >= 0),
  mileage_allowance_mode text          not null default 'per_day' check (mileage_allowance_mode in ('per_day', 'per_loan')),
  excess_mileage_rate    numeric(10,2) not null default 0.25  check (excess_mileage_rate >= 0),
  fuel_rate_per_eighth   numeric(10,2) not null default 10.00 check (fuel_rate_per_eighth >= 0),
  late_rate_per_day      numeric(10,2) not null default 25.00 check (late_rate_per_day >= 0),
  late_grace_minutes     integer       not null default 60    check (late_grace_minutes >= 0),
  created_at             timestamptz   not null default now(),
  updated_at             timestamptz   not null default now()
);


-- =========================================================================
-- 3. Customers
-- =========================================================================
create table if not exists public.ccm_customers (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references auth.users(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  phone      text,
  email      text,
  address    text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ccm_customers_company_name_idx
  on public.ccm_customers (company_id, lower(name));


-- =========================================================================
-- 4. Cars (the loan fleet)
-- =========================================================================
create table if not exists public.ccm_cars (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references auth.users(id) on delete cascade,
  reg               text not null check (length(trim(reg)) > 0),
  make              text,
  model             text,
  colour            text,
  mot_due           date,
  tax_due           date,
  insurance_due     date,
  service_due_date  date,
  service_due_miles integer check (service_due_miles >= 0),
  current_mileage   integer check (current_mileage >= 0),
  status            text not null default 'available' check (status in ('available', 'on_loan', 'off_road')),
  archived_at       timestamptz,
  notes             text,
  dvla              jsonb,
  dvla_fetched_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- A reg can only be in a garage's active fleet once (spaces/case ignored).
-- Archived cars don't count, so a re-acquired car can be added again.
create unique index if not exists ccm_cars_company_reg_active
  on public.ccm_cars (company_id, upper(regexp_replace(reg, '[^A-Za-z0-9]', '', 'g')))
  where archived_at is null;

create index if not exists ccm_cars_company_idx on public.ccm_cars (company_id);

-- Guard: a car only goes on/off loan through hand-over and return (the
-- ccm_check_out / ccm_check_in functions set ccm.via_rpc for the length of
-- their own transaction; nothing a browser sends can set it). Also tidies
-- the reg and refuses to archive a car that's out.
create or replace function public.ccm_cars_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.reg := upper(trim(new.reg));

  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if old.status = 'on_loan' and new.archived_at is not null and old.archived_at is null then
      raise exception '% is out on loan — check it back in before archiving it.', old.reg;
    end if;
  end if;

  if coalesce(current_setting('ccm.via_rpc', true), '') <> 'on' then
    if tg_op = 'INSERT' and new.status = 'on_loan' then
      raise exception 'A new car can''t start as On Loan — use Hand-over.';
    end if;
    if tg_op = 'UPDATE' and new.status is distinct from old.status
       and (old.status = 'on_loan' or new.status = 'on_loan') then
      raise exception 'Cars go on and off loan through Hand-over and Return only.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ccm_cars_guard on public.ccm_cars;
create trigger ccm_cars_guard
  before insert or update on public.ccm_cars
  for each row execute function public.ccm_cars_guard();

create or replace function public.ccm_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ccm_customers_touch on public.ccm_customers;
create trigger ccm_customers_touch
  before update on public.ccm_customers
  for each row execute function public.ccm_touch_updated_at();

drop trigger if exists ccm_settings_touch on public.ccm_settings;
create trigger ccm_settings_touch
  before update on public.ccm_settings
  for each row execute function public.ccm_touch_updated_at();


-- =========================================================================
-- 5. Loans and everything recorded against them
-- =========================================================================
-- car_id / customer_id use the default ON DELETE NO ACTION (checked at the
-- end of the statement), not RESTRICT: cars are archived, never deleted, and
-- a customer with loan history can't be deleted — but if a whole garage's
-- account is ever deleted, the company_id cascades still clear everything in
-- one go.
create table if not exists public.ccm_loans (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references auth.users(id) on delete cascade,
  loan_number          integer not null,
  car_id               uuid not null references public.ccm_cars(id),
  customer_id          uuid not null references public.ccm_customers(id),
  job_ref              text,
  customer_vehicle_reg text,
  licence_number       text not null,
  licence_check_code   text,
  out_at               timestamptz not null default now(),
  expected_back_at     timestamptz not null,
  returned_at          timestamptz,
  mileage_out          integer not null check (mileage_out >= 0),
  mileage_in           integer check (mileage_in >= 0),
  fuel_out             smallint not null check (fuel_out between 0 and 8),  -- eighths: 0 = empty, 8 = full
  fuel_in              smallint check (fuel_in between 0 and 8),
  terms_text           text not null,   -- exactly what the customer signed
  rates                jsonb not null,  -- allowance + rates as they stood at hand-over
  signature_path       text not null,
  handover_pdf_path    text,
  out_notes            text,
  in_notes             text,
  status               text not null default 'on_loan' check (status in ('on_loan', 'returned')),
  out_by               uuid references auth.users(id) on delete set null,
  in_by                uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  unique (company_id, loan_number),
  check (expected_back_at > out_at),
  check (mileage_in is null or mileage_in >= mileage_out),
  check (status <> 'returned' or (returned_at is not null and mileage_in is not null and fuel_in is not null))
);

-- A car can only have one open loan — the database refuses a second one
-- even if two phones press "Finish" at the same moment.
create unique index if not exists ccm_loans_one_open_per_car
  on public.ccm_loans (car_id) where status = 'on_loan';

create index if not exists ccm_loans_company_status_idx on public.ccm_loans (company_id, status);
create index if not exists ccm_loans_car_idx           on public.ccm_loans (car_id, out_at desc);
create index if not exists ccm_loans_customer_idx      on public.ccm_loans (customer_id);

create table if not exists public.ccm_damage_marks (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references auth.users(id) on delete cascade,
  loan_id      uuid not null references public.ccm_loans(id) on delete cascade,
  stage        text not null check (stage in ('out', 'in')),   -- recorded at hand-over or return
  mark_number  smallint not null,
  view         text not null check (view in ('top', 'left', 'right', 'front', 'rear')),
  x            numeric(5,4) not null check (x between 0 and 1),  -- position on that view, 0–1
  y            numeric(5,4) not null check (y between 0 and 1),
  note         text,
  photo_path   text,
  carried_over boolean not null default false,  -- known damage brought forward from the car's last loan
  created_at   timestamptz not null default now(),
  unique (loan_id, mark_number)
);

create index if not exists ccm_damage_marks_loan_idx on public.ccm_damage_marks (loan_id);

create table if not exists public.ccm_loan_photos (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references auth.users(id) on delete cascade,
  loan_id    uuid not null references public.ccm_loans(id) on delete cascade,
  stage      text not null check (stage in ('out', 'in')),
  kind       text not null check (kind in ('front', 'rear', 'left', 'right', 'dashboard', 'extra')),
  path       text not null,
  created_at timestamptz not null default now()
);

create index if not exists ccm_loan_photos_loan_idx on public.ccm_loan_photos (loan_id);

create table if not exists public.ccm_loan_charges (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references auth.users(id) on delete cascade,
  loan_id          uuid not null references public.ccm_loans(id) on delete cascade,
  type             text not null check (type in ('mileage', 'fuel', 'damage', 'late')),
  description      text,
  suggested_amount numeric(10,2) not null default 0 check (suggested_amount >= 0),  -- what the settings rates worked out
  amount           numeric(10,2) not null check (amount >= 0),                       -- what's actually charged (0 if waived)
  waived           boolean not null default false,
  reason           text,
  damage_mark_id   uuid references public.ccm_damage_marks(id) on delete set null,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  check (not waived or amount = 0),
  check ((not waived and amount = suggested_amount) or length(trim(coalesce(reason, ''))) > 0)
);

create index if not exists ccm_loan_charges_loan_idx on public.ccm_loan_charges (loan_id);


-- =========================================================================
-- 6. Row Level Security
-- =========================================================================
alter table public.ccm_members      enable row level security;
alter table public.ccm_settings     enable row level security;
alter table public.ccm_customers    enable row level security;
alter table public.ccm_cars         enable row level security;
alter table public.ccm_loans        enable row level security;
alter table public.ccm_damage_marks enable row level security;
alter table public.ccm_loan_photos  enable row level security;
alter table public.ccm_loan_charges enable row level security;

-- Nothing here is ever readable without signing in.
revoke all on public.ccm_members, public.ccm_settings, public.ccm_customers, public.ccm_cars,
              public.ccm_loans, public.ccm_damage_marks, public.ccm_loan_photos, public.ccm_loan_charges
  from anon;

-- Written only by the functions below — never directly from the browser.
revoke insert, update, delete on public.ccm_members, public.ccm_loans, public.ccm_damage_marks,
                                 public.ccm_loan_photos, public.ccm_loan_charges
  from authenticated;
revoke insert, delete on public.ccm_settings from authenticated;  -- created by ccm_resolve_company()
revoke delete on public.ccm_cars from authenticated;              -- cars are archived, never deleted

-- ccm_members: see your own garage's roster.
drop policy if exists ccm_members_select on public.ccm_members;
create policy ccm_members_select on public.ccm_members
  for select to authenticated
  using (company_id = (select public.ccm_my_company()));

-- ccm_settings: read and edit your own garage's settings.
drop policy if exists ccm_settings_select on public.ccm_settings;
create policy ccm_settings_select on public.ccm_settings
  for select to authenticated
  using (company_id = (select public.ccm_my_company()));

drop policy if exists ccm_settings_update on public.ccm_settings;
create policy ccm_settings_update on public.ccm_settings
  for update to authenticated
  using (company_id = (select public.ccm_my_company()))
  with check (company_id = (select public.ccm_my_company()));

-- ccm_customers: full access within your garage. (A customer with loan
-- history can't be deleted — the loans' foreign key refuses it.)
drop policy if exists ccm_customers_all on public.ccm_customers;
create policy ccm_customers_all on public.ccm_customers
  for all to authenticated
  using (company_id = (select public.ccm_my_company()))
  with check (company_id = (select public.ccm_my_company()));

-- ccm_cars: add/edit within your garage (delete is revoked above).
drop policy if exists ccm_cars_select on public.ccm_cars;
create policy ccm_cars_select on public.ccm_cars
  for select to authenticated
  using (company_id = (select public.ccm_my_company()));

drop policy if exists ccm_cars_insert on public.ccm_cars;
create policy ccm_cars_insert on public.ccm_cars
  for insert to authenticated
  with check (company_id = (select public.ccm_my_company()));

drop policy if exists ccm_cars_update on public.ccm_cars;
create policy ccm_cars_update on public.ccm_cars
  for update to authenticated
  using (company_id = (select public.ccm_my_company()))
  with check (company_id = (select public.ccm_my_company()));

-- Loans and their records: read-only from the browser, own garage only.
drop policy if exists ccm_loans_select on public.ccm_loans;
create policy ccm_loans_select on public.ccm_loans
  for select to authenticated
  using (company_id = (select public.ccm_my_company()));

drop policy if exists ccm_damage_marks_select on public.ccm_damage_marks;
create policy ccm_damage_marks_select on public.ccm_damage_marks
  for select to authenticated
  using (company_id = (select public.ccm_my_company()));

drop policy if exists ccm_loan_photos_select on public.ccm_loan_photos;
create policy ccm_loan_photos_select on public.ccm_loan_photos
  for select to authenticated
  using (company_id = (select public.ccm_my_company()));

drop policy if exists ccm_loan_charges_select on public.ccm_loan_charges;
create policy ccm_loan_charges_select on public.ccm_loan_charges
  for select to authenticated
  using (company_id = (select public.ccm_my_company()));


-- =========================================================================
-- 7. Functions the app calls
-- =========================================================================

-- ccm_resolve_company() — get-or-create in one call, run on every app load.
-- First time: makes the caller the owner of their own garage and creates
-- its settings row (garage name pre-filled from the company name they gave
-- at signup, if any). Afterwards: just returns their garage id.
create or replace function public.ccm_resolve_company()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_name    text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select company_id into v_company from public.ccm_members where user_id = auth.uid();

  if not found then
    insert into public.ccm_members (company_id, user_id, role)
      values (auth.uid(), auth.uid(), 'owner')
      on conflict do nothing;
    select company_id into v_company from public.ccm_members where user_id = auth.uid();
  end if;

  select nullif(trim(raw_user_meta_data ->> 'company_name'), '') into v_name
    from auth.users where id = auth.uid();

  insert into public.ccm_settings (company_id, garage_name)
    values (v_company, v_name)
    on conflict (company_id) do nothing;

  return v_company;
end;
$$;

revoke all on function public.ccm_resolve_company() from public, anon;
grant execute on function public.ccm_resolve_company() to authenticated;


-- ccm_check_out(p) — the hand-over. Everything is saved in one transaction:
-- either the whole loan (with its damage marks and photo records) is
-- saved and the car goes On Loan, or nothing is.
--
-- The app uploads photos + signature first, into <company>/<loan_id>/out/,
-- using a loan_id it generated, then calls this with:
--   { loan_id, car_id, customer_id, job_ref, customer_vehicle_reg,
--     licence_number, licence_check_code,
--     expected_back_local: 'YYYY-MM-DDTHH:MM' (UK wall-clock time),
--     mileage_out, fuel_out (0–8), notes, signature_path,
--     damage: [{ view, x, y, note, photo_path, carried_over }],
--     photos: [{ kind, path }] }
-- Calling it again with the same loan_id (e.g. a phone retrying after a
-- dropped connection) returns the already-saved loan instead of failing.
create or replace function public.ccm_check_out(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company   uuid := public.ccm_my_company();
  v_loan_id   uuid := (p ->> 'loan_id')::uuid;
  v_prefix    text;
  v_today     date := (now() at time zone 'Europe/London')::date;
  v_car       public.ccm_cars%rowtype;
  v_settings  public.ccm_settings%rowtype;
  v_existing  public.ccm_loans%rowtype;
  v_expected  timestamptz;
  v_mileage   integer := (p ->> 'mileage_out')::integer;
  v_fuel      integer := (p ->> 'fuel_out')::integer;
  v_licence   text := nullif(trim(p ->> 'licence_number'), '');
  v_signature text := nullif(trim(p ->> 'signature_path'), '');
  v_number    integer;
  v_item      jsonb;
  v_n         integer := 0;
begin
  if v_company is null then
    raise exception 'Your login isn''t linked to a garage yet — reload the page and try again.';
  end if;
  if v_loan_id is null then
    raise exception 'Missing loan id.';
  end if;
  v_prefix := v_company::text || '/' || v_loan_id::text || '/';

  -- One hand-over at a time per garage, so loan numbers stay sequential.
  perform pg_advisory_xact_lock(hashtext('ccm_check_out:' || v_company::text));

  select * into v_existing from public.ccm_loans where id = v_loan_id;
  if found then
    if v_existing.company_id <> v_company then
      raise exception 'Loan id already in use.';
    end if;
    return jsonb_build_object('loan_id', v_existing.id, 'loan_number', v_existing.loan_number,
                              'out_at', v_existing.out_at, 'already_saved', true);
  end if;

  select * into v_car from public.ccm_cars
    where id = (p ->> 'car_id')::uuid and company_id = v_company
    for update;
  if not found then
    raise exception 'Car not found.';
  end if;
  if v_car.archived_at is not null then
    raise exception '% has been archived.', v_car.reg;
  end if;
  if v_car.status <> 'available' then
    raise exception '% isn''t available — it''s %.', v_car.reg,
      case v_car.status when 'on_loan' then 'already on loan' else 'off road' end;
  end if;

  -- The legal block: MOT, tax and insurance must all be known and in date
  -- (a date that is today still counts as valid).
  if v_car.mot_due is null or v_car.tax_due is null or v_car.insurance_due is null then
    raise exception '% can''t go out until its MOT, tax and insurance dates are filled in.', v_car.reg;
  end if;
  if v_car.mot_due < v_today then
    raise exception '% can''t go out: its MOT expired on %.', v_car.reg, to_char(v_car.mot_due, 'DD/MM/YYYY');
  end if;
  if v_car.tax_due < v_today then
    raise exception '% can''t go out: its tax expired on %.', v_car.reg, to_char(v_car.tax_due, 'DD/MM/YYYY');
  end if;
  if v_car.insurance_due < v_today then
    raise exception '% can''t go out: its insurance expired on %.', v_car.reg, to_char(v_car.insurance_due, 'DD/MM/YYYY');
  end if;

  if not exists (select 1 from public.ccm_customers
                 where id = (p ->> 'customer_id')::uuid and company_id = v_company) then
    raise exception 'Customer not found.';
  end if;
  if v_licence is null then
    raise exception 'Enter the customer''s driving licence number.';
  end if;
  if v_mileage is null or v_mileage < 0 then
    raise exception 'Enter the mileage.';
  end if;
  if v_fuel is null or v_fuel not between 0 and 8 then
    raise exception 'Set the fuel level.';
  end if;

  -- The app sends the UK wall-clock time the customer agreed to; converting
  -- it here means BST/GMT is always right, whatever the phone's clock says.
  v_expected := ((p ->> 'expected_back_local')::timestamp) at time zone 'Europe/London';
  if v_expected is null or v_expected <= now() then
    raise exception 'The expected return time must be in the future.';
  end if;

  if v_signature is null or left(v_signature, length(v_prefix)) <> v_prefix then
    raise exception 'The customer''s signature is missing.';
  end if;

  select * into v_settings from public.ccm_settings where company_id = v_company;
  if not found or length(trim(coalesce(v_settings.terms_text, ''))) = 0 then
    raise exception 'Add your terms and conditions in Settings first.';
  end if;

  select coalesce(max(loan_number), 0) + 1 into v_number
    from public.ccm_loans where company_id = v_company;

  insert into public.ccm_loans (
    id, company_id, loan_number, car_id, customer_id, job_ref, customer_vehicle_reg,
    licence_number, licence_check_code, out_at, expected_back_at,
    mileage_out, fuel_out, terms_text, rates, signature_path, out_notes, status, out_by
  ) values (
    v_loan_id, v_company, v_number, v_car.id, (p ->> 'customer_id')::uuid,
    nullif(trim(p ->> 'job_ref'), ''), nullif(upper(trim(p ->> 'customer_vehicle_reg')), ''),
    upper(v_licence), nullif(upper(trim(p ->> 'licence_check_code')), ''), now(), v_expected,
    v_mileage, v_fuel, v_settings.terms_text,
    jsonb_build_object(
      'mileage_allowance',      v_settings.mileage_allowance,
      'mileage_allowance_mode', v_settings.mileage_allowance_mode,
      'excess_mileage_rate',    v_settings.excess_mileage_rate,
      'fuel_rate_per_eighth',   v_settings.fuel_rate_per_eighth,
      'late_rate_per_day',      v_settings.late_rate_per_day,
      'late_grace_minutes',     v_settings.late_grace_minutes
    ),
    v_signature, nullif(trim(p ->> 'notes'), ''), 'on_loan', auth.uid()
  );

  for v_item in select * from jsonb_array_elements(coalesce(p -> 'damage', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if nullif(v_item ->> 'photo_path', '') is not null
       and left(v_item ->> 'photo_path', length(v_prefix)) <> v_prefix then
      raise exception 'Damage photo %: wrong storage folder.', v_n;
    end if;
    insert into public.ccm_damage_marks (company_id, loan_id, stage, mark_number, view, x, y, note, photo_path, carried_over)
    values (v_company, v_loan_id, 'out', v_n, v_item ->> 'view',
            (v_item ->> 'x')::numeric, (v_item ->> 'y')::numeric,
            nullif(trim(v_item ->> 'note'), ''), nullif(v_item ->> 'photo_path', ''),
            coalesce((v_item ->> 'carried_over')::boolean, false));
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p -> 'photos', '[]'::jsonb)) loop
    if left(coalesce(v_item ->> 'path', ''), length(v_prefix)) <> v_prefix then
      raise exception 'Photo: wrong storage folder.';
    end if;
    insert into public.ccm_loan_photos (company_id, loan_id, stage, kind, path)
    values (v_company, v_loan_id, 'out', v_item ->> 'kind', v_item ->> 'path');
  end loop;

  perform set_config('ccm.via_rpc', 'on', true);
  update public.ccm_cars set status = 'on_loan', current_mileage = v_mileage where id = v_car.id;
  perform set_config('ccm.via_rpc', 'off', true);

  return jsonb_build_object('loan_id', v_loan_id, 'loan_number', v_number,
                            'out_at', (select out_at from public.ccm_loans where id = v_loan_id),
                            'already_saved', false);
end;
$$;

revoke all on function public.ccm_check_out(jsonb) from public, anon;
grant execute on function public.ccm_check_out(jsonb) to authenticated;


-- ccm_attach_handover_pdf(loan, path) — records where the signed agreement
-- PDF was uploaded. Only ever sets it once; a saved agreement can't be
-- swapped for a different file.
create or replace function public.ccm_attach_handover_pdf(p_loan_id uuid, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := public.ccm_my_company();
  v_loan    public.ccm_loans%rowtype;
begin
  select * into v_loan from public.ccm_loans where id = p_loan_id and company_id = v_company for update;
  if not found then
    raise exception 'Loan not found.';
  end if;
  if left(coalesce(p_path, ''), length(v_company::text || '/' || p_loan_id::text || '/'))
     <> v_company::text || '/' || p_loan_id::text || '/' then
    raise exception 'PDF: wrong storage folder.';
  end if;
  if v_loan.handover_pdf_path is null then
    update public.ccm_loans set handover_pdf_path = p_path where id = p_loan_id;
  end if;
end;
$$;

revoke all on function public.ccm_attach_handover_pdf(uuid, text) from public, anon;
grant execute on function public.ccm_attach_handover_pdf(uuid, text) to authenticated;


-- ccm_check_in(p) — the return. One transaction: records mileage/fuel in,
-- return photos, new damage and the agreed charges, closes the loan and
-- puts the car back to Available (or Off Road if staff chose that).
--   { loan_id, mileage_in, fuel_in (0–8), notes,
--     car_status_after: 'available' | 'off_road',
--     damage:  [{ view, x, y, note, photo_path }],          -- NEW damage only
--     photos:  [{ kind, path }],
--     charges: [{ type, description, suggested_amount, amount, waived, reason,
--                 damage_index }] }   -- damage_index = position in `damage`, from 0
-- Calling it again for an already-returned loan returns without changing it.
create or replace function public.ccm_check_in(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company   uuid := public.ccm_my_company();
  v_loan      public.ccm_loans%rowtype;
  v_prefix    text;
  v_mileage   integer := (p ->> 'mileage_in')::integer;
  v_fuel      integer := (p ->> 'fuel_in')::integer;
  v_after     text := coalesce(nullif(p ->> 'car_status_after', ''), 'available');
  v_item      jsonb;
  v_n         integer;
  v_mark_ids  uuid[] := '{}';
  v_mark_id   uuid;
  v_idx       integer;
  v_suggested numeric(10,2);
  v_amount    numeric(10,2);
  v_waived    boolean;
  v_reason    text;
begin
  if v_company is null then
    raise exception 'Your login isn''t linked to a garage yet — reload the page and try again.';
  end if;

  select * into v_loan from public.ccm_loans
    where id = (p ->> 'loan_id')::uuid and company_id = v_company
    for update;
  if not found then
    raise exception 'Loan not found.';
  end if;
  if v_loan.status = 'returned' then
    return jsonb_build_object('loan_id', v_loan.id, 'returned_at', v_loan.returned_at, 'already_returned', true);
  end if;
  v_prefix := v_company::text || '/' || v_loan.id::text || '/';

  if v_mileage is null then
    raise exception 'Enter the mileage.';
  end if;
  if v_mileage < v_loan.mileage_out then
    raise exception 'Mileage in (%) is lower than mileage out (%) — check the reading.', v_mileage, v_loan.mileage_out;
  end if;
  if v_fuel is null or v_fuel not between 0 and 8 then
    raise exception 'Set the fuel level.';
  end if;
  if v_after not in ('available', 'off_road') then
    raise exception 'After return the car must be Available or Off Road.';
  end if;

  select coalesce(max(mark_number), 0) into v_n from public.ccm_damage_marks where loan_id = v_loan.id;

  for v_item in select * from jsonb_array_elements(coalesce(p -> 'damage', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if nullif(v_item ->> 'photo_path', '') is not null
       and left(v_item ->> 'photo_path', length(v_prefix)) <> v_prefix then
      raise exception 'Damage photo %: wrong storage folder.', v_n;
    end if;
    insert into public.ccm_damage_marks (company_id, loan_id, stage, mark_number, view, x, y, note, photo_path, carried_over)
    values (v_company, v_loan.id, 'in', v_n, v_item ->> 'view',
            (v_item ->> 'x')::numeric, (v_item ->> 'y')::numeric,
            nullif(trim(v_item ->> 'note'), ''), nullif(v_item ->> 'photo_path', ''), false)
    returning id into v_mark_id;
    v_mark_ids := v_mark_ids || v_mark_id;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p -> 'photos', '[]'::jsonb)) loop
    if left(coalesce(v_item ->> 'path', ''), length(v_prefix)) <> v_prefix then
      raise exception 'Photo: wrong storage folder.';
    end if;
    insert into public.ccm_loan_photos (company_id, loan_id, stage, kind, path)
    values (v_company, v_loan.id, 'in', v_item ->> 'kind', v_item ->> 'path');
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p -> 'charges', '[]'::jsonb)) loop
    v_suggested := round(coalesce((v_item ->> 'suggested_amount')::numeric, 0), 2);
    v_waived    := coalesce((v_item ->> 'waived')::boolean, false);
    v_amount    := case when v_waived then 0 else round(coalesce((v_item ->> 'amount')::numeric, v_suggested), 2) end;
    v_reason    := nullif(trim(v_item ->> 'reason'), '');
    if (v_waived or v_amount <> v_suggested) and v_reason is null then
      raise exception 'Give a reason for the adjusted or waived % charge.', v_item ->> 'type';
    end if;
    v_idx := (v_item ->> 'damage_index')::integer;
    insert into public.ccm_loan_charges (company_id, loan_id, type, description, suggested_amount, amount,
                                         waived, reason, damage_mark_id, created_by)
    values (v_company, v_loan.id, v_item ->> 'type', nullif(trim(v_item ->> 'description'), ''),
            v_suggested, v_amount, v_waived, v_reason,
            case when v_idx is not null then v_mark_ids[v_idx + 1] end, auth.uid());
  end loop;

  update public.ccm_loans
    set status = 'returned', returned_at = now(), mileage_in = v_mileage, fuel_in = v_fuel,
        in_notes = nullif(trim(p ->> 'notes'), ''), in_by = auth.uid()
    where id = v_loan.id;

  perform set_config('ccm.via_rpc', 'on', true);
  update public.ccm_cars
    set status = v_after, current_mileage = greatest(coalesce(current_mileage, 0), v_mileage)
    where id = v_loan.car_id;
  perform set_config('ccm.via_rpc', 'off', true);

  return jsonb_build_object('loan_id', v_loan.id, 'returned_at', (select returned_at from public.ccm_loans where id = v_loan.id),
                            'already_returned', false);
end;
$$;

revoke all on function public.ccm_check_in(jsonb) from public, anon;
grant execute on function public.ccm_check_in(jsonb) to authenticated;


-- =========================================================================
-- 8. Private storage bucket for photos, signatures and PDFs
-- =========================================================================
-- 10 MB per file cap (photos are shrunk in the browser to ~150–300 KB), and
-- only JPEG/PNG images and PDFs are accepted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ccm-files', 'ccm-files', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists ccm_files_select on storage.objects;
create policy ccm_files_select on storage.objects
  for select to authenticated
  using (bucket_id = 'ccm-files'
         and (storage.foldername(name))[1] = (select public.ccm_my_company())::text);

drop policy if exists ccm_files_insert on storage.objects;
create policy ccm_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ccm-files'
              and (storage.foldername(name))[1] = (select public.ccm_my_company())::text);

-- No UPDATE policy on purpose: nothing in this bucket can be overwritten.
-- DELETE only for photo retakes (see header).
drop policy if exists ccm_files_delete on storage.objects;
create policy ccm_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'ccm-files'
         and (storage.foldername(name))[1] = (select public.ccm_my_company())::text
         and (
           not exists (select 1 from public.ccm_loans l
                       where l.id::text = (storage.foldername(name))[2])
           or ((storage.foldername(name))[3] = 'in'
               and exists (select 1 from public.ccm_loans l
                           where l.id::text = (storage.foldername(name))[2]
                             and l.status = 'on_loan'))
         ));


-- =========================================================================
-- Verification — run after applying (each should return what's described):
--
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename like 'ccm_%' order by 1;
--   -- expect: 8 rows, rowsecurity = true on every one
--
--   select id, public from storage.buckets where id = 'ccm-files';
--   -- expect: 1 row, public = false
--
--   select policyname from pg_policies
--   where schemaname = 'storage' and policyname like 'ccm_files_%' order by 1;
--   -- expect: ccm_files_delete, ccm_files_insert, ccm_files_select
-- =========================================================================
