-- Stock Control (PD Stevens edition) — stillages (warehouses) and customer orders that reserve parts.
--
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once, and it does not change or remove any existing data.
--
-- What it adds (all new tables — nothing existing is touched):
--   * sc_stillages       the stillages / warehouses (e.g. "Stillage 1" ... "Stillage 6")
--   * sc_stillage_stock  how many of each part are in each stillage
--   * sc_orders          customer orders that set parts aside
--   * sc_order_lines     the parts (and how many) each order has set aside
--
-- Same safety rules as the rest of Stock Control: everyone in your team can use them
-- (owner or staff), nobody outside it can see them. Stillages and orders are never deleted from
-- the app: a stillage is hidden and an order is cancelled instead, so there is always a record.
--
-- How it fits together: a part's quantity in Stock Control stays the total you hold. The stillage
-- rows say where some or all of it is (anything not placed in a stillage is simply "not placed").
-- An open order sets parts aside: that stock still counts as yours, but it is not free to sell to
-- anyone else until the order is sold, cancelled or changed.

-- 1. The stillages.
create table if not exists public.sc_stillages (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  sort_order integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists sc_stillages_owner_name_idx on public.sc_stillages (owner_id, name);

-- 2. How many of each part are in each stillage. Deleting a part (or "Clear all data") removes its rows.
create table if not exists public.sc_stillage_stock (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  stillage_id uuid not null references public.sc_stillages(id) on delete cascade,
  stock_id    uuid not null references public.stock(id) on delete cascade,
  qty         numeric(12,2) not null check (qty > 0),
  unique (stillage_id, stock_id)
);
create index if not exists sc_stillage_stock_owner_idx on public.sc_stillage_stock (owner_id);
create index if not exists sc_stillage_stock_part_idx  on public.sc_stillage_stock (stock_id);

-- 3. Customer orders that reserve parts.
create table if not exists public.sc_orders (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  user_id    uuid references auth.users(id),
  order_no   integer not null,                       -- 1, 2, 3 ... (shown as ORD-0001)
  customer   text not null,
  reference  text,                                   -- their order number / a note
  status     text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  sale_no    integer,                                -- the sale it was fulfilled by
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create unique index if not exists sc_orders_owner_no_idx     on public.sc_orders (owner_id, order_no);
create index        if not exists sc_orders_owner_status_idx on public.sc_orders (owner_id, status);

-- 4. The parts each order has set aside. stock_id is deliberately NOT a foreign key, so deleting a
--    part later never rewrites the history of what was ordered.
create table if not exists public.sc_order_lines (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sc_orders(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  stock_id uuid,
  sku      text not null,
  name     text not null,
  qty      numeric(12,2) not null check (qty > 0)
);
create index if not exists sc_order_lines_order_idx on public.sc_order_lines (order_id);

-- 5. Who can see / use them: every member of the workspace, nobody else.
--    (is_stock_owner() already exists — it was created by Stock Control's team set-up.)
alter table public.sc_stillages      enable row level security;
alter table public.sc_stillage_stock enable row level security;
alter table public.sc_orders         enable row level security;
alter table public.sc_order_lines    enable row level security;

drop policy if exists "sc_stillages_owner" on public.sc_stillages;
create policy "sc_stillages_owner" on public.sc_stillages
  for all using (is_stock_owner(owner_id)) with check (is_stock_owner(owner_id));

drop policy if exists "sc_stillage_stock_owner" on public.sc_stillage_stock;
create policy "sc_stillage_stock_owner" on public.sc_stillage_stock
  for all using (is_stock_owner(owner_id)) with check (is_stock_owner(owner_id));

drop policy if exists "sc_orders_owner" on public.sc_orders;
create policy "sc_orders_owner" on public.sc_orders
  for all using (is_stock_owner(owner_id)) with check (is_stock_owner(owner_id));

drop policy if exists "sc_order_lines_owner" on public.sc_order_lines;
create policy "sc_order_lines_owner" on public.sc_order_lines
  for all using (is_stock_owner(owner_id)) with check (is_stock_owner(owner_id));

-- 6. Not visible to the public. Stillages and orders themselves cannot be deleted from the app.
--    Only two kinds of row can: "what is in a stillage" (when a part is moved out) and the parts on
--    an order that is still open (when you change what is set aside).
revoke all on public.sc_stillages      from anon;
revoke all on public.sc_stillage_stock from anon;
revoke all on public.sc_orders         from anon;
revoke all on public.sc_order_lines    from anon;
revoke all on public.sc_stillages      from authenticated;
revoke all on public.sc_stillage_stock from authenticated;
revoke all on public.sc_orders         from authenticated;
revoke all on public.sc_order_lines    from authenticated;
grant select, insert, update         on public.sc_stillages      to authenticated;
grant select, insert, update, delete on public.sc_stillage_stock to authenticated;
grant select, insert, update         on public.sc_orders         to authenticated;
grant select, insert, update, delete on public.sc_order_lines    to authenticated;

-- 7. Tell the API to notice the new tables straight away.
notify pgrst, 'reload schema';
