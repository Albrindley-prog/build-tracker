-- Stock Control (PD Stevens edition) — lets the owner DELETE a sale from the Sales screen.
--
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once, and it does not change or remove any data.
--
-- Until now sales could only be voided (the record is kept). This allows the Delete button on the
-- Sales screen to remove a sale's record for good. The app only shows that button to the owner,
-- and it puts a completed sale's parts back into stock before removing it.

grant delete on public.sc_sales      to authenticated;
grant delete on public.sc_sale_lines to authenticated;

-- Tell the API to notice the change straight away.
notify pgrst, 'reload schema';
