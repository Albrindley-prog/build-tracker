-- Purchase Order System — Supabase schema migration
-- Run this once in the Supabase SQL editor for the shared build-tracker2026
-- project (the same project already used by Body Shop Pro, Workshop
-- Scheduler & Diary, Stock Control, etc.). It does not touch bt_trials or
-- bt_subscriptions — those already exist and are reused as-is via
-- PRODUCT_ID = 'purchase-order-system'.

-- Suppliers
create table if not exists spo_suppliers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  contact text,
  email text,
  phone text,
  payment_terms_days int not null default 30,
  account text,
  lead_time_days int not null default 0,
  address text,
  created_at timestamptz not null default now()
);
alter table spo_suppliers enable row level security;
create policy "spo_suppliers_owner" on spo_suppliers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Purchase orders
-- supplier_id is ON DELETE SET NULL (not cascade/restrict) to match the
-- app's existing behaviour: deleting a supplier has always been allowed
-- even if it has orders — getSupplierName() already renders "Unknown" for
-- an order whose supplier is gone.
create table if not exists spo_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid references spo_suppliers(id) on delete set null,
  ref text not null,
  order_date date,
  due_date date,
  payment_terms_days int not null default 30,
  status text not null default 'draft',
  goods_in text not null default 'no',
  notes text,
  total numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table spo_purchase_orders enable row level security;
create policy "spo_purchase_orders_owner" on spo_purchase_orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Purchase order line items
-- user_id is duplicated here (not just derived via the parent PO) purely to
-- keep the RLS policy simple and uniform with every other table.
create table if not exists spo_purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references spo_purchase_orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  qty numeric not null default 0,
  price numeric(10,2) not null default 0,
  notes text
);
alter table spo_purchase_order_items enable row level security;
create policy "spo_purchase_order_items_owner" on spo_purchase_order_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Price history — an independent, append-only log. The app has always kept
-- these entries even after the purchase order that generated them is
-- deleted, so this table is NOT cascade-deleted from spo_purchase_orders.
create table if not exists spo_price_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid references spo_suppliers(id) on delete set null,
  item_name text not null,
  price numeric(10,2) not null,
  recorded_date date not null default current_date,
  created_at timestamptz not null default now()
);
alter table spo_price_history enable row level security;
create policy "spo_price_history_owner" on spo_price_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- PO reference-number counter — one row per user, incremented only when a
-- new PO is actually saved (matches the app's original behaviour of never
-- reusing a number, even if a later order is deleted).
create table if not exists spo_counters (
  user_id uuid primary key references auth.users(id) on delete cascade,
  next_po_number int not null default 1
);
alter table spo_counters enable row level security;
create policy "spo_counters_owner" on spo_counters
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
