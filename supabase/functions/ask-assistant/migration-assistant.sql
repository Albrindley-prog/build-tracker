-- Saves each question and answer from the website assistant, so you can see what
-- customers actually ask (good for the FAQ and for deciding what to build next).
-- It also lets the assistant count questions per day and per visitor.
--
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste this -> Run.
-- Safe to run more than once.
--
-- Privacy: visitors' internet addresses are NOT stored - only a one-way scramble of
-- them (ip_hash), used to spot someone sending too many questions. The chat panel
-- tells visitors their chats are saved.

create table if not exists public.bt_assistant_chats (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  visitor_id    text,          -- random id the browser makes up, to group one person's questions
  ip_hash       text,          -- scrambled address, for rate limiting only
  question      text not null,
  answer        text,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  stop_reason   text
);

create index if not exists bt_assistant_chats_created_idx
  on public.bt_assistant_chats (created_at desc);
create index if not exists bt_assistant_chats_ip_idx
  on public.bt_assistant_chats (ip_hash, created_at desc);

-- Lock it down: with row level security on and no policies, the website and the
-- public can't read or write this table at all. Only the assistant function (which
-- uses the service key) and you (in the dashboard Table Editor) can.
alter table public.bt_assistant_chats enable row level security;

-- Optional tidy-up, run now and then: delete chats older than 90 days.
-- delete from public.bt_assistant_chats where created_at < now() - interval '90 days';
