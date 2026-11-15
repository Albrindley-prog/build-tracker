-- Automatically deletes website-assistant chats older than 90 days, every day.
-- This keeps the promise in the privacy notice (privacy.html: chats kept "up to 90 days").
--
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste this -> Run.
-- Safe to run more than once (running it again just replaces the same job).
--
-- Needs migration-assistant.sql to have been run first (it makes the table).
-- If the "create extension" line gives an error, switch the extension on instead:
-- Dashboard -> Integrations -> Cron -> Enable, then run this file again.
--
-- What it does: at 03:17 every night (UK winter time; 04:17 in summer) it runs one
-- delete on public.bt_assistant_chats. Nothing else is touched.
-- It deletes anything older than 89 days, not 90, because it only runs once a day: a chat
-- is then gone by the time it is 90 days old, so "up to 90 days" in the notice stays true.
--
-- To check it ran:   select * from cron.job_run_details order by start_time desc limit 5;
-- To see the job:    select jobname, schedule, command from cron.job;
-- To stop it:        select cron.unschedule('delete-old-assistant-chats');

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'delete-old-assistant-chats',   -- the job's name (re-running replaces the old job)
  '17 3 * * *',                   -- every day at 03:17 (server time is UTC)
  $$ delete from public.bt_assistant_chats where created_at < now() - interval '89 days' $$
);
