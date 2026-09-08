-- Stock Control — multi-staff support (invite-by-email, shared full access)
--
-- Run this once in the Supabase SQL editor for the shared build-tracker2026
-- project. New tables/columns only — does not touch any other product's
-- tables (bs_*, bsp_*, repairs_electronics, tenant_admins, etc.).
--
-- Investigated first: Workshop Tracker's tenant_admins/tenant_admin_invites
-- is NOT reusable here — it has a global unique(user_id) index (one
-- workspace per person, no product dimension at all) and its own
-- send-invite-email function is explicitly documented as workshop-tracker-
-- only ("tenant_admin_invites doesn't exist for sibling products"). Body
-- Shop Pro / Electronics Repair's shop_id-in-JWT-metadata pattern was also
-- considered and rejected — user_metadata is client-writable via
-- auth.updateUser(), and Body Shop Pro's own RLS re-checks it on every
-- single request, so any signed-in user can set their own shop_id to
-- someone else's uuid and get full access to that shop's data (a live
-- issue, flagged separately, not fixed here). This migration instead
-- follows tenant_admins' actual safe pattern: membership lives in a
-- server-side table, only ever written by an owner-gated SECURITY DEFINER
-- RPC, never derived from anything the client can edit.
--
-- Safe to re-run — ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS /
-- DROP POLICY IF EXISTS / CREATE OR REPLACE throughout.

-- ---------------------------------------------------------------------
-- 1. owner_id on stock/stock_logs — the shared-workspace identity from
--    now on. user_id keeps its current meaning (who actually made this
--    specific change) and is left untouched; every query/RLS policy
--    scopes by owner_id instead. Backfilling owner_id = user_id for
--    every existing row means every account that exists today keeps
--    seeing exactly its own data, unchanged — sc_resolve_owner() below
--    is what turns that backfilled value into a real owner membership
--    row the first time each account loads the app after this runs.
-- ---------------------------------------------------------------------
alter table public.stock
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

alter table public.stock_logs
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

update public.stock      set owner_id = user_id where owner_id is null;
update public.stock_logs set owner_id = user_id where owner_id is null;

alter table public.stock      alter column owner_id set not null;
alter table public.stock_logs alter column owner_id set not null;

-- ---------------------------------------------------------------------
-- 2. sc_team_members — membership + role. One row per (owner, user).
--    unique(user_id): a login can belong to only one Stock Control
--    workspace, same rule tenant_admins already enforces for Workshop
--    Tracker, confirmed as the right default here too.
-- ---------------------------------------------------------------------
create table if not exists public.sc_team_members (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner', 'staff')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (owner_id, user_id)
);

create unique index if not exists sc_team_members_one_owner_per_user
  on public.sc_team_members (user_id);

create index if not exists sc_team_members_owner_id_idx
  on public.sc_team_members (owner_id);

-- ---------------------------------------------------------------------
-- 3. sc_team_invites — pending invitations, redeemed once by signup.
--    No automated email send for v1 — sc_create_invite() below just
--    returns the token; the owner copies the generated link and sends
--    it themselves. (An automated send would need a new Edge Function
--    deployed into the bms-system-main repo — the only place any of
--    these products' Edge Functions currently live — which is a bigger,
--    separate piece of work.)
-- ---------------------------------------------------------------------
create table if not exists public.sc_team_invites (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  invited_email text not null,
  token         text not null unique,
  invited_by    uuid not null references auth.users(id),
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '7 days')
);

create index if not exists sc_team_invites_owner_id_idx on public.sc_team_invites (owner_id);
create index if not exists sc_team_invites_token_idx    on public.sc_team_invites (token);

alter table public.sc_team_members enable row level security;
alter table public.sc_team_invites enable row level security;

-- ---------------------------------------------------------------------
-- 4. is_stock_owner() — every RLS policy below calls this. SECURITY
--    DEFINER so its own read of sc_team_members bypasses that table's
--    own RLS (needed for policy 5 below, which uses this same function
--    ON sc_team_members itself — without SECURITY DEFINER that would
--    recurse into itself and fail).
-- ---------------------------------------------------------------------
create or replace function public.is_stock_owner(p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sc_team_members
    where owner_id = p_owner_id and user_id = auth.uid()
  );
$$;

revoke all on function public.is_stock_owner(uuid) from public;
grant execute on function public.is_stock_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. sc_team_members / sc_team_invites RLS — any member can see their
--    own workspace's roster/invite list (so a staff member can see who
--    else has access), but no direct insert/update/delete for
--    authenticated on either table — every mutation goes through the
--    RPCs below instead, which enforce "owner only", the 5-seat cap,
--    and "never touch another workspace" in one place.
-- ---------------------------------------------------------------------
drop policy if exists member_select_sc_team_members on public.sc_team_members;
create policy member_select_sc_team_members on public.sc_team_members
  for select to authenticated
  using (is_stock_owner(owner_id));

drop policy if exists member_select_sc_team_invites on public.sc_team_invites;
create policy member_select_sc_team_invites on public.sc_team_invites
  for select to authenticated
  using (is_stock_owner(owner_id));

revoke insert, update, delete on public.sc_team_members from authenticated;
revoke insert, update, delete on public.sc_team_invites from authenticated;
revoke all on public.sc_team_members from anon;
revoke all on public.sc_team_invites from anon;

-- ---------------------------------------------------------------------
-- 6. stock / stock_logs RLS — shared full access for every member of
--    the workspace (owner or staff alike), scoped by owner_id instead
--    of user_id = auth.uid(). Whatever policy already exists on these
--    tables today (this repo has no prior migration file for Stock
--    Control, so its exact name isn't known from source) only needs to
--    allow at least user_id = auth.uid() for the app to have worked at
--    all so far — Postgres combines multiple permissive policies with
--    OR, so adding this one is a strict widening of who can already see
--    their own data, never a narrowing, regardless of what else is
--    already there.
-- ---------------------------------------------------------------------
alter table public.stock      enable row level security;
alter table public.stock_logs enable row level security;

drop policy if exists "stock_owner" on public.stock;
create policy "stock_owner" on public.stock
  for all
  using (is_stock_owner(owner_id))
  with check (is_stock_owner(owner_id));

drop policy if exists "stock_logs_owner" on public.stock_logs;
create policy "stock_logs_owner" on public.stock_logs
  for all
  using (is_stock_owner(owner_id))
  with check (is_stock_owner(owner_id));

-- ---------------------------------------------------------------------
-- 7. users table — this becomes "one row per workspace" (keyed by
--    owner_id) rather than "one row per login": it's what
--    daysRemaining()/hasActiveSubscription() read trial/subscription
--    state from, and that state must be the OWNER's, never an invited
--    staff member's own signup_date (otherwise every invited staff
--    login would mint its own fresh 30-day trial — a paywall bypass).
--
--    Widening SELECT so a staff member can read the owner's row, but
--    never write it. Also adding an INSERT policy that was missing from
--    the original version of this migration — getUserData()'s "create
--    row if missing" path runs for ANY brand-new owner hitting this
--    table for the first time (not just staff, who never hit it at
--    all — they always read an owner row that already exists), and
--    enabling RLS with a SELECT-only policy silently blocked that
--    insert outright (confirmed live: 403 on the insert, reproduced
--    2026-09-08 testing the invite flow). id = auth.uid() only — an
--    account only ever creates its OWN row.
-- ---------------------------------------------------------------------
alter table public.users enable row level security;

drop policy if exists "users_owner_visible" on public.users;
create policy "users_owner_visible" on public.users
  for select
  using (id = auth.uid() or is_stock_owner(id));

drop policy if exists "users_self_insert" on public.users;
create policy "users_self_insert" on public.users
  for insert
  with check (id = auth.uid());

-- ---------------------------------------------------------------------
-- 8. sc_resolve_owner() — get-or-create in one call. Every existing
--    account (backfilled above with owner_id = their own user_id on
--    their stock/stock_logs rows, but with NO sc_team_members row yet)
--    and every brand new signup both bootstrap through this, on first
--    call, as an owner of themselves — zero action needed from them.
--    An invited staff member instead already has a row by the time this
--    runs (inserted by sc_accept_invite() during signup), so this just
--    returns their existing owner_id without creating anything.
-- ---------------------------------------------------------------------
create or replace function public.sc_resolve_owner()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  select owner_id into v_owner_id
    from public.sc_team_members where user_id = auth.uid();

  if found then
    return v_owner_id;
  end if;

  insert into public.sc_team_members (owner_id, user_id, role)
    values (auth.uid(), auth.uid(), 'owner');

  return auth.uid();
end;
$$;

revoke all on function public.sc_resolve_owner() from public;
grant execute on function public.sc_resolve_owner() to authenticated;

-- ---------------------------------------------------------------------
-- 9. sc_create_invite(p_email) — owner-only.
-- ---------------------------------------------------------------------
create or replace function public.sc_create_invite(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id   uuid;
  v_seat_count int;
  v_token      text;
  v_invite_id  uuid;
begin
  select owner_id into v_owner_id
    from public.sc_team_members
    where user_id = auth.uid() and role = 'owner';

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Only the workspace owner can invite staff.');
  end if;

  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid email address.');
  end if;

  if exists (
    select 1 from public.sc_team_members sm
    join auth.users u on u.id = sm.user_id
    where sm.owner_id = v_owner_id and lower(u.email) = lower(p_email)
  ) then
    return jsonb_build_object('ok', false, 'error', 'That person already has access to this workspace.');
  end if;

  if exists (
    select 1 from public.sc_team_invites
    where owner_id = v_owner_id
      and lower(invited_email) = lower(p_email)
      and status = 'pending'
      and expires_at > now()
  ) then
    return jsonb_build_object('ok', false, 'error', 'There is already a pending invite for that email.');
  end if;

  select count(*) into v_seat_count from public.sc_team_members where owner_id = v_owner_id;
  select v_seat_count + count(*) into v_seat_count
    from public.sc_team_invites
    where owner_id = v_owner_id and status = 'pending' and expires_at > now();

  if v_seat_count >= 5 then
    return jsonb_build_object('ok', false, 'error', 'This workspace already has 5 seats in use (including pending invites).');
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.sc_team_invites (owner_id, invited_email, token, invited_by)
    values (v_owner_id, p_email, v_token, auth.uid())
    returning id into v_invite_id;

  return jsonb_build_object('ok', true, 'invite_id', v_invite_id, 'token', v_token);
end;
$$;

revoke all on function public.sc_create_invite(text) from public;
grant execute on function public.sc_create_invite(text) to authenticated;

-- ---------------------------------------------------------------------
-- 10. sc_accept_invite(p_token) — called by the invitee right after
--     their own signUp() succeeds. user_id in the inserted row always
--     comes from auth.uid() — the currently-authenticated caller —
--     never a client-supplied parameter, so redeeming a token only ever
--     grants access to whoever actually holds the invite link and
--     completed their own signup with it.
-- ---------------------------------------------------------------------
create or replace function public.sc_accept_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite     public.sc_team_invites%rowtype;
  v_seat_count int;
begin
  if exists (select 1 from public.sc_team_members where user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Your account already belongs to a workspace.');
  end if;

  select * into v_invite
    from public.sc_team_invites
    where token = p_token and status = 'pending' and expires_at > now();

  if not found then
    return jsonb_build_object('ok', false, 'error', 'This invite link is invalid or has expired. Ask the workspace owner to send a new one.');
  end if;

  select count(*) into v_seat_count
    from public.sc_team_members where owner_id = v_invite.owner_id;

  if v_seat_count >= 5 then
    update public.sc_team_invites set status = 'revoked' where id = v_invite.id;
    return jsonb_build_object('ok', false, 'error', 'This workspace has reached its 5 seat limit.');
  end if;

  insert into public.sc_team_members (owner_id, user_id, role, invited_by)
    values (v_invite.owner_id, auth.uid(), 'staff', v_invite.invited_by);

  update public.sc_team_invites set status = 'accepted' where id = v_invite.id;

  return jsonb_build_object('ok', true, 'owner_id', v_invite.owner_id);
end;
$$;

revoke all on function public.sc_accept_invite(text) from public;
grant execute on function public.sc_accept_invite(text) to authenticated;

-- ---------------------------------------------------------------------
-- 11. sc_revoke_invite / sc_remove_member — owner-only.
-- ---------------------------------------------------------------------
create or replace function public.sc_revoke_invite(p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  select owner_id into v_owner_id
    from public.sc_team_members
    where user_id = auth.uid() and role = 'owner';

  if not found then
    return false;
  end if;

  update public.sc_team_invites
    set status = 'revoked'
    where id = p_invite_id and owner_id = v_owner_id and status = 'pending';

  return found;
end;
$$;

revoke all on function public.sc_revoke_invite(uuid) from public;
grant execute on function public.sc_revoke_invite(uuid) to authenticated;

-- Owner-only. Revokes p_target_user_id's access to the owner's own
-- workspace — never cross-workspace, and never the owner themself (no
-- ownerless workspace; ownership transfer isn't part of this feature).
-- Nothing they previously added/adjusted (stock rows, log entries) is
-- affected — this only removes their future access. On their next
-- login, sc_resolve_owner() finds no membership row for them anymore
-- and bootstraps them fresh as the owner of their own (empty) new
-- workspace, rather than leaving them stuck with no access at all.
create or replace function public.sc_remove_member(p_target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  if p_target_user_id = auth.uid() then
    return false;
  end if;

  select owner_id into v_owner_id
    from public.sc_team_members
    where user_id = auth.uid() and role = 'owner';

  if not found then
    return false;
  end if;

  delete from public.sc_team_members
    where owner_id = v_owner_id and user_id = p_target_user_id;

  return found;
end;
$$;

revoke all on function public.sc_remove_member(uuid) from public;
grant execute on function public.sc_remove_member(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Verification — run after applying:
--
--   select owner_id, user_id, role from sc_team_members;
--   -- expect: one 'owner' row per existing account, owner_id = user_id
--
--   select count(*) from stock where owner_id is null;
--   select count(*) from stock_logs where owner_id is null;
--   -- expect: 0, 0 (the backfill + not-null constraint above guarantee this)
-- ---------------------------------------------------------------------
