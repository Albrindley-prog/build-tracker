-- Stock Control (Barcode edition) — location for each part + faster lookups.
--
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once, and it does not change or remove any existing data.
--
-- The live Stock Control (/stock-control/) shares this table. It keeps working exactly as
-- before: it never asks for the new column, and the column is allowed to be empty.

-- 1. Where the part lives (shelf, bin, aisle...). Empty for every existing row.
alter table public.stock
  add column if not exists location text;

-- 2. Indexes so looking up a scanned product code, and opening one item's movement
--    history, stay quick once the parts list runs to thousands of rows.
create index if not exists stock_owner_sku_idx
  on public.stock (owner_id, sku);

create index if not exists stock_logs_owner_item_date_idx
  on public.stock_logs (owner_id, item, date desc);

-- 3. Tell the API to notice the new column straight away.
notify pgrst, 'reload schema';
