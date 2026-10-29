-- Stock Control (PD Stevens edition) — purchase orders and goods in.
--
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once, and it does not change or remove any existing data.
--
-- What it adds: two new tables. One row per purchase order, and one row per part on it
-- (how many were ordered, how many have arrived so far). Nothing existing is touched.
--
-- Same safety rules as the rest of Stock Control: everyone in your team can use them
-- (owner or staff), nobody outside it can see them. Orders cannot be deleted from the app —
-- an order that is no longer wanted is "cancelled" instead, so there is always a record.

-- 1. One row per purchase order.
create table if not exists public.sc_purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  user_id     uuid references auth.users(id),            -- who raised it
  po_no       integer not null,                          -- 1, 2, 3 ... within your workspace (shown as PO-0001)
  supplier    text not null,
  status      text not null default 'open' check (status in ('open', 'partial', 'received', 'cancelled')),
  notes       text,
  total       numeric(12,2) not null default 0,          -- what it was ordered for (quantity x cost)
  created_at  timestamptz not null default now(),
  received_at timestamptz                                -- when the last of it arrived / it was closed
);

create unique index if not exists sc_po_owner_no_idx     on public.sc_purchase_orders (owner_id, po_no);
create index        if not exists sc_po_owner_status_idx on public.sc_purchase_orders (owner_id, status);

-- 2. One row per part on an order. stock_id is deliberately NOT a foreign key, so deleting a
--    part later never rewrites the history of what was ordered.
create table if not exists public.sc_po_lines (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references public.sc_purchase_orders(id) on delete cascade,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  stock_id     uuid,
  sku          text not null,
  name         text not null,
  qty_ordered  numeric(12,2) not null,
  qty_received numeric(12,2) not null default 0,
  unit_cost    numeric(12,2) not null default 0
);

create index if not exists sc_po_lines_po_idx on public.sc_po_lines (po_id);

-- 3. Who can see / use them: every member of the workspace, nobody else.
--    (is_stock_owner() already exists — it was created by Stock Control's team set-up.)
alter table public.sc_purchase_orders enable row level security;
alter table public.sc_po_lines        enable row level security;

drop policy if exists "sc_po_owner" on public.sc_purchase_orders;
create policy "sc_po_owner" on public.sc_purchase_orders
  for all
  using (is_stock_owner(owner_id))
  with check (is_stock_owner(owner_id));

drop policy if exists "sc_po_lines_owner" on public.sc_po_lines;
create policy "sc_po_lines_owner" on public.sc_po_lines
  for all
  using (is_stock_owner(owner_id))
  with check (is_stock_owner(owner_id));

-- 4. Not visible to the public, and no deleting from the app.
revoke all on public.sc_purchase_orders from anon;
revoke all on public.sc_po_lines        from anon;
revoke all on public.sc_purchase_orders from authenticated;
revoke all on public.sc_po_lines        from authenticated;
grant select, insert, update on public.sc_purchase_orders to authenticated;
grant select, insert, update on public.sc_po_lines        to authenticated;

-- 5. Tell the API to notice the new tables straight away.
notify pgrst, 'reload schema';
