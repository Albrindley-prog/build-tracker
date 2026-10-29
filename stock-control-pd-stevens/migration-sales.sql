-- Stock Control (PD Stevens edition) — selling parts at the counter.
--
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once, and it does not change or remove any existing data.
--
-- What it adds:
--   * a "selling price" for each part (empty for every existing part — the live Stock
--     Control shares this table and keeps working exactly as before, it never asks for it)
--   * two new tables that keep every sale: one row per sale, and one row per part sold on it
--
-- Same safety rules as the rest of Stock Control: everyone in your team can use the sales
-- (owner or staff), nobody outside it can see them. Sales cannot be deleted from the app —
-- a mistake is "voided" instead, which puts the stock back and keeps the record.

-- 1. Selling price of a part, in pounds EXCLUDING VAT.
alter table public.stock
  add column if not exists sell_price numeric(12,2);

-- 2. One row per sale.
create table if not exists public.sc_sales (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  user_id       uuid references auth.users(id),             -- who made the sale
  sale_no       integer not null,                           -- 1, 2, 3 ... within your workspace
  sold_at       timestamptz not null default now(),
  customer_name text,
  account_ref   text,                                       -- their account code (e.g. for Sage)
  payment       text not null default 'cash' check (payment in ('cash', 'card', 'account')),
  reference     text,                                       -- their order number / a note
  vat_rate      numeric(5,2) not null default 20,
  net           numeric(12,2) not null,
  vat           numeric(12,2) not null,
  gross         numeric(12,2) not null,
  status        text not null default 'completed' check (status in ('completed', 'voided')),
  voided_at     timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists sc_sales_owner_no_idx   on public.sc_sales (owner_id, sale_no);
create index        if not exists sc_sales_owner_date_idx on public.sc_sales (owner_id, sold_at desc);

-- 3. One row per part sold on a sale. stock_id is deliberately NOT a foreign key, so deleting
--    a part later never rewrites the history of what was sold.
create table if not exists public.sc_sale_lines (
  id         uuid primary key default gen_random_uuid(),
  sale_id    uuid not null references public.sc_sales(id) on delete cascade,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  stock_id   uuid,
  sku        text not null,
  name       text not null,
  qty        numeric(12,2) not null,
  unit_price numeric(12,2) not null,                        -- excluding VAT
  line_net   numeric(12,2) not null
);

create index if not exists sc_sale_lines_sale_idx on public.sc_sale_lines (sale_id);

-- 4. Who can see / use them: every member of the workspace, nobody else.
--    (is_stock_owner() already exists — it was created by Stock Control's team set-up.)
alter table public.sc_sales      enable row level security;
alter table public.sc_sale_lines enable row level security;

drop policy if exists "sc_sales_owner" on public.sc_sales;
create policy "sc_sales_owner" on public.sc_sales
  for all
  using (is_stock_owner(owner_id))
  with check (is_stock_owner(owner_id));

drop policy if exists "sc_sale_lines_owner" on public.sc_sale_lines;
create policy "sc_sale_lines_owner" on public.sc_sale_lines
  for all
  using (is_stock_owner(owner_id))
  with check (is_stock_owner(owner_id));

-- 5. Not visible to the public, and no deleting from the app.
revoke all on public.sc_sales      from anon;
revoke all on public.sc_sale_lines from anon;
revoke all on public.sc_sales      from authenticated;
revoke all on public.sc_sale_lines from authenticated;
grant select, insert, update on public.sc_sales      to authenticated;
grant select, insert         on public.sc_sale_lines to authenticated;

-- 6. Tell the API to notice the new column and tables straight away.
notify pgrst, 'reload schema';
