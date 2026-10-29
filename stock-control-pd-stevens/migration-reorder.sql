-- Stock Control (PD Stevens edition) — reorder levels and suppliers.
--
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once, and it does not change or remove any existing data.
--
-- The live Stock Control (/stock-control/) shares this table. It keeps working exactly as
-- before: it never asks for the new columns, and they are allowed to be empty.

-- 1. For each part: the stock level at (or below) which it needs reordering, the usual
--    quantity to order, and who you buy it from. All empty for every existing part.
alter table public.stock
  add column if not exists reorder_level numeric(12,2),
  add column if not exists reorder_qty   numeric(12,2),
  add column if not exists supplier      text;

-- 2. Keeps "what to order, by supplier" quick once the parts list runs to thousands of rows.
create index if not exists stock_owner_supplier_idx
  on public.stock (owner_id, supplier);

-- 3. Tell the API to notice the new columns straight away.
notify pgrst, 'reload schema';
