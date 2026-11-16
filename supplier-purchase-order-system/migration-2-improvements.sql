-- Supplier & Purchase Orders — upgrade 2 (improvements)
--
-- Run this once in the Supabase SQL editor, BEFORE the new version of the page is published.
-- It only ADDS things: no existing table, column or row is removed or rewritten (apart from
-- the one back-fill in step 3). It is safe to run more than once, and the page that is live
-- today keeps working after it has been run.
--
-- It does not touch bt_trials, bt_subscriptions or any other app's tables.

-- ── 1. Order lines: job/reg reference, VAT rate, how many have arrived, display order ──
-- vat_rate defaults to 0 so every existing line keeps exactly the total it has today.
alter table spo_purchase_order_items add column if not exists job_ref text;
alter table spo_purchase_order_items add column if not exists vat_rate numeric(5,2) not null default 0;
alter table spo_purchase_order_items add column if not exists qty_received numeric not null default 0;
alter table spo_purchase_order_items add column if not exists position int not null default 0;

-- ── 2. Orders: VAT breakdown and the date everything arrived ──
-- "total" stays the grand total. subtotal / vat_total are empty on old orders (shown as no VAT).
alter table spo_purchase_orders add column if not exists subtotal numeric(10,2);
alter table spo_purchase_orders add column if not exists vat_total numeric(10,2);
alter table spo_purchase_orders add column if not exists delivered_date date;

-- ── 3. Back-fill: orders already marked "Full Delivery" have received every line ──
update spo_purchase_order_items i
   set qty_received = i.qty
  from spo_purchase_orders p
 where p.id = i.purchase_order_id
   and p.goods_in = 'yes'
   and i.qty_received = 0
   and i.qty > 0;

-- ── 4. Your business details (printed on purchase orders). One row per account. ──
create table if not exists spo_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  business_name text check (business_name is null or char_length(business_name) <= 500),
  address text check (address is null or char_length(address) <= 10000),
  phone text check (phone is null or char_length(phone) <= 500),
  email text check (email is null or char_length(email) <= 500),
  vat_number text check (vat_number is null or char_length(vat_number) <= 500),
  default_vat_rate numeric(5,2) not null default 20 check (default_vat_rate >= 0 and default_vat_rate <= 100),
  updated_at timestamptz not null default now()
);
alter table spo_settings enable row level security;
drop policy if exists "spo_settings_owner" on spo_settings;
create policy "spo_settings_owner" on spo_settings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 5. Returns and credits ──
-- Kept when the order or supplier it came from is deleted (the link is just cleared),
-- so money owed back is never lost from the list by accident.
create table if not exists spo_returns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid references spo_suppliers(id) on delete set null,
  purchase_order_id uuid references spo_purchase_orders(id) on delete set null,
  item_name text not null check (char_length(item_name) between 1 and 500),
  qty numeric not null default 1 check (qty > 0 and qty <= 1000000),
  amount numeric(10,2) not null default 0 check (amount >= 0),
  reason text not null default 'other'
    check (reason in ('wrong_part', 'damaged', 'not_needed', 'warranty', 'surcharge', 'other')),
  status text not null default 'to_return' check (status in ('to_return', 'returned', 'credited')),
  returned_date date,
  credit_ref text check (credit_ref is null or char_length(credit_ref) <= 500),
  credited_date date,
  notes text check (notes is null or char_length(notes) <= 10000),
  created_at timestamptz not null default now()
);
alter table spo_returns enable row level security;
drop policy if exists "spo_returns_owner" on spo_returns;
create policy "spo_returns_owner" on spo_returns
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 6. The database checks values itself, not just the page ──
-- Each of the five existing tables gets a guard that runs whenever a row is added or changed:
--   * a new row must be inside the rules;
--   * a row that is inside the rules cannot be changed to be outside them;
--   * a row that was ALREADY outside the rules before this upgrade is left alone, so an old odd
--     row can still be edited, received or deleted exactly as it can today.
-- (A plain CHECK constraint was not used because it would block any later change to such an old
--  row, including clearing its supplier when that supplier is deleted.)

create or replace function spo_items_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  r record;
  ok boolean;
begin
  for pass in 1..2 loop
    if pass = 1 then r := new;
    elsif tg_op = 'UPDATE' then r := old;
    else exit;
    end if;
    ok := coalesce(
      r.qty >= 0 and r.qty <= 1000000
      and r.price >= 0
      and r.vat_rate >= 0 and r.vat_rate <= 100
      and r.qty_received >= 0
      and char_length(r.name) <= 500
      and char_length(coalesce(r.job_ref, '')) <= 500
      and char_length(coalesce(r.notes, '')) <= 10000, false);
    if pass = 1 and ok then return new; end if;
    if pass = 2 and not ok then return new; end if;
  end loop;
  raise exception 'spo_purchase_order_items violates the value rules (quantity, price, VAT or text length)' using errcode = '23514';
end $$;

create or replace function spo_orders_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  r record;
  ok boolean;
begin
  for pass in 1..2 loop
    if pass = 1 then r := new;
    elsif tg_op = 'UPDATE' then r := old;
    else exit;
    end if;
    ok := coalesce(
      r.status in ('draft', 'sent', 'confirmed', 'delivered', 'invoiced')
      and r.goods_in in ('no', 'partial', 'yes')
      and r.total >= 0
      and coalesce(r.subtotal, 0) >= 0
      and coalesce(r.vat_total, 0) >= 0
      and r.payment_terms_days >= 0 and r.payment_terms_days <= 3650
      and char_length(r.ref) <= 500
      and char_length(coalesce(r.notes, '')) <= 10000, false);
    if pass = 1 and ok then return new; end if;
    if pass = 2 and not ok then return new; end if;
  end loop;
  raise exception 'spo_purchase_orders violates the value rules (status, totals or text length)' using errcode = '23514';
end $$;

create or replace function spo_suppliers_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  r record;
  ok boolean;
begin
  for pass in 1..2 loop
    if pass = 1 then r := new;
    elsif tg_op = 'UPDATE' then r := old;
    else exit;
    end if;
    ok := coalesce(
      char_length(r.name) between 1 and 500
      and r.payment_terms_days >= 0 and r.payment_terms_days <= 3650
      and r.lead_time_days >= 0 and r.lead_time_days <= 3650
      and char_length(coalesce(r.contact, '')) <= 500
      and char_length(coalesce(r.email, '')) <= 500
      and char_length(coalesce(r.phone, '')) <= 500
      and char_length(coalesce(r.account, '')) <= 500
      and char_length(coalesce(r.address, '')) <= 10000, false);
    if pass = 1 and ok then return new; end if;
    if pass = 2 and not ok then return new; end if;
  end loop;
  raise exception 'spo_suppliers violates the value rules (name, terms or text length)' using errcode = '23514';
end $$;

create or replace function spo_price_history_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  r record;
  ok boolean;
begin
  for pass in 1..2 loop
    if pass = 1 then r := new;
    elsif tg_op = 'UPDATE' then r := old;
    else exit;
    end if;
    ok := coalesce(r.price >= 0 and char_length(r.item_name) <= 500, false);
    if pass = 1 and ok then return new; end if;
    if pass = 2 and not ok then return new; end if;
  end loop;
  raise exception 'spo_price_history violates the value rules (price or text length)' using errcode = '23514';
end $$;

create or replace function spo_counters_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  r record;
  ok boolean;
begin
  for pass in 1..2 loop
    if pass = 1 then r := new;
    elsif tg_op = 'UPDATE' then r := old;
    else exit;
    end if;
    ok := coalesce(r.next_po_number >= 1 and r.next_po_number <= 100000000, false);
    if pass = 1 and ok then return new; end if;
    if pass = 2 and not ok then return new; end if;
  end loop;
  raise exception 'spo_counters violates the value rules (order number)' using errcode = '23514';
end $$;

drop trigger if exists spo_items_guard_trg on spo_purchase_order_items;
create trigger spo_items_guard_trg before insert or update on spo_purchase_order_items
  for each row execute function spo_items_guard();

drop trigger if exists spo_orders_guard_trg on spo_purchase_orders;
create trigger spo_orders_guard_trg before insert or update on spo_purchase_orders
  for each row execute function spo_orders_guard();

drop trigger if exists spo_suppliers_guard_trg on spo_suppliers;
create trigger spo_suppliers_guard_trg before insert or update on spo_suppliers
  for each row execute function spo_suppliers_guard();

drop trigger if exists spo_price_history_guard_trg on spo_price_history;
create trigger spo_price_history_guard_trg before insert or update on spo_price_history
  for each row execute function spo_price_history_guard();

drop trigger if exists spo_counters_guard_trg on spo_counters;
create trigger spo_counters_guard_trg before insert or update on spo_counters
  for each row execute function spo_counters_guard();

-- ── 7. Indexes so lists stay quick as the data grows ──
create index if not exists spo_items_po_idx on spo_purchase_order_items (purchase_order_id);
create index if not exists spo_items_user_idx on spo_purchase_order_items (user_id);
create index if not exists spo_orders_user_idx on spo_purchase_orders (user_id);
create index if not exists spo_price_history_user_idx on spo_price_history (user_id);
create index if not exists spo_returns_user_idx on spo_returns (user_id);
