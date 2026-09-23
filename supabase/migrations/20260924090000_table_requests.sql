-- Table requests: the diner -> staff channel (phase A)
--
-- Before this, a diner sitting at a table had no way to ask a human for
-- anything. `/r/{slug}/table/{token}/staff` is a notice page for staff who
-- scan a table's QR code — it is not a request. Everything a diner could
-- do went through the cart or the AI waiter, and neither reaches a person.
--
-- WHAT A REQUEST IS. One table asking one thing: come over, or bring the
-- bill. Deliberately an enum-like `kind` rather than free text, because
-- the staff-facing surface is a list somebody glances at mid-service; a
-- free-text queue is a chat, and a chat needs someone watching it.
-- `note` exists for the AI to add one short line of context ("they asked
-- about the spice level") and is never required.
--
-- IDENTITY IS DERIVED, NEVER SUPPLIED. create_table_request() takes no
-- restaurant and no table. It reads the caller's own active customer
-- session, exactly as the order path does, so a diner cannot raise a
-- request against another restaurant's table by editing a payload. The
-- only thing the client chooses is which of two kinds to ask for.
--
-- TWO ANTI-ABUSE RULES, BOTH IN THE DATABASE:
--
--   1. One OPEN request per table per kind, enforced by a partial unique
--      index. A bored table tapping "Call waiter" ten times produces one
--      row. This is about staff attention, not storage: a queue that cries
--      wolf is a queue nobody reads.
--
--   2. A rolling cap on creations per session, which rule 1 alone cannot
--      give — cancel-and-recreate would otherwise loop forever.
--
-- Both live here rather than in the application because the application is
-- not the only caller: the AI waiter raises requests too, through the same
-- function.

create table public.table_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  -- Constrained by the composite foreign key below, which also pins the
  -- table to this row's restaurant. A second, single-column reference
  -- would add nothing but another cascade path.
  table_id uuid not null,
  -- Which visit asked. Kept for the rolling cap and so staff can tell two
  -- consecutive sittings apart; NULL once the session row is cleaned up.
  session_id uuid references public.customer_sessions (id) on delete set null,

  kind text not null,
  status text not null default 'open',
  note text,

  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- The staff member who dealt with it. NULL when a diner cancelled.
  resolved_by uuid references auth.users (id) on delete set null,

  constraint table_requests_kind_valid
    check (kind in ('waiter', 'bill')),
  constraint table_requests_status_valid
    check (status in ('open', 'resolved', 'cancelled')),
  -- resolved_at moves with the status and never independently of it.
  constraint table_requests_resolved_when_terminal
    check ((status = 'open') = (resolved_at is null)),
  constraint table_requests_note_length
    check (note is null or length(note) <= 200),
  -- A table always belongs to the same restaurant as its request. Without
  -- this composite reference the two columns could disagree.
  constraint table_requests_table_same_restaurant
    foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id)
    on delete cascade
);

comment on table public.table_requests is
  'A diner at a table asking staff for something. Created only by create_table_request(), which derives the restaurant and table from the caller''s own customer session.';

-- Rule 1. One open request per table per kind.
create unique index table_requests_one_open_per_table_kind
  on public.table_requests (table_id, kind)
  where status = 'open';

-- The staff-facing read: open requests for a restaurant, oldest first,
-- because the table that has waited longest is the one to serve next.
create index table_requests_open_idx
  on public.table_requests (restaurant_id, created_at)
  where status = 'open';

create index table_requests_session_idx
  on public.table_requests (session_id, created_at desc)
  where session_id is not null;

alter table public.table_requests enable row level security;

-- A diner sees their own session's requests, so their own UI can show
-- "asked for the bill" and offer to cancel it. They see nothing else,
-- including other tables in the same restaurant.
create policy "table_requests_select_own_session"
  on public.table_requests
  for select
  to authenticated
  using (
    session_id in (
      select id from public.customer_sessions
      where user_id = auth.uid()
    )
  );

-- Staff see their restaurant's requests. Any member, not only managers:
-- answering a table is exactly what a waiter or a cook does.
create policy "table_requests_select_members"
  on public.table_requests
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- No insert, update or delete policy. Every write goes through the
-- SECURITY DEFINER functions below, which is what keeps the derivation of
-- restaurant_id and table_id out of the client's hands.

-- Raising a request ---------------------------------------------------------

create or replace function public.create_table_request(
  p_kind text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions;
  v_recent integer;
  v_existing uuid;
  v_request_id uuid;
begin
  if p_kind not in ('waiter', 'bill') then
    raise exception 'TABLE_REQUEST_INVALID_KIND';
  end if;

  -- The caller's own active session, by auth.uid() — never a parameter.
  -- customer_sessions.user_id is unique, so this is at most one row; no
  -- ordering is needed to pick "the" session.
  select * into v_session
  from public.customer_sessions
  where user_id = auth.uid()
    and status = 'active'
    and expires_at > now();

  if v_session.id is null then
    raise exception 'TABLE_REQUEST_NO_SESSION';
  end if;

  -- Serialise per table so two taps cannot both pass the open-request
  -- check and race the unique index into an error nobody can read.
  perform 1 from public.tables where id = v_session.table_id for update;

  -- Rule 1, checked before rule 2: asking twice for the same thing is not
  -- abuse, it is impatience, and it should return the existing request
  -- rather than an error or a second row.
  select id into v_existing
  from public.table_requests
  where table_id = v_session.table_id
    and kind = p_kind
    and status = 'open';

  if v_existing is not null then
    return v_existing;
  end if;

  -- Rule 2. Counts creations, not open rows, so cancelling does not
  -- refund an attempt.
  select count(*) into v_recent
  from public.table_requests
  where session_id = v_session.id
    and created_at > now() - interval '1 hour';

  -- 20 an hour: generous for a real meal, where a table might legitimately
  -- ask three or four times, and low enough that a cancel-and-recreate
  -- loop stops quickly.
  if v_recent >= 20 then
    raise exception 'TABLE_REQUEST_RATE_LIMITED';
  end if;

  insert into public.table_requests (
    restaurant_id, table_id, session_id, kind, note
  )
  values (
    v_session.restaurant_id,
    v_session.table_id,
    v_session.id,
    p_kind,
    nullif(left(trim(coalesce(p_note, '')), 200), '')
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

comment on function public.create_table_request(text, text) is
  'Raises a service request for the caller''s own table. Restaurant and table come from the caller''s active customer session, never from arguments. Returns the existing open request when one of that kind is already waiting.';

-- Clearing a request --------------------------------------------------------

create or replace function public.resolve_table_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.table_requests;
begin
  select * into v_request from public.table_requests where id = p_request_id;
  if v_request.id is null then
    raise exception 'TABLE_REQUEST_NOT_FOUND';
  end if;
  if not public.is_restaurant_member(v_request.restaurant_id) then
    raise exception 'TABLE_REQUEST_FORBIDDEN';
  end if;
  if v_request.status <> 'open' then
    raise exception 'TABLE_REQUEST_NOT_OPEN';
  end if;

  update public.table_requests
  set status = 'resolved',
      resolved_at = now(),
      resolved_by = auth.uid()
  where id = p_request_id;
end;
$$;

comment on function public.resolve_table_request(uuid) is
  'Staff marks a request dealt with. Any member of the restaurant, because answering a table is what floor staff do.';

-- A diner taking it back: "never mind, we found someone". Distinct from
-- resolved so the two are not confused in any later report — one means a
-- person was served, the other means nobody had to be.
create or replace function public.cancel_table_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.table_requests;
begin
  select * into v_request from public.table_requests where id = p_request_id;
  if v_request.id is null then
    raise exception 'TABLE_REQUEST_NOT_FOUND';
  end if;

  -- Only the session that raised it.
  if v_request.session_id is null
    or not exists (
      select 1 from public.customer_sessions
      where id = v_request.session_id and user_id = auth.uid()
    ) then
    raise exception 'TABLE_REQUEST_FORBIDDEN';
  end if;

  if v_request.status <> 'open' then
    raise exception 'TABLE_REQUEST_NOT_OPEN';
  end if;

  update public.table_requests
  set status = 'cancelled', resolved_at = now()
  where id = p_request_id;
end;
$$;

-- What staff read -----------------------------------------------------------

-- Open requests with the table's human-readable number, which the staff
-- list needs and a plain select would make the client join for.
create or replace function public.get_open_table_requests(p_restaurant_id uuid)
returns table (
  id uuid,
  kind text,
  note text,
  created_at timestamptz,
  table_id uuid,
  table_number text,
  table_display_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_member(p_restaurant_id) then
    raise exception 'TABLE_REQUEST_FORBIDDEN';
  end if;

  return query
  select r.id, r.kind, r.note, r.created_at,
         t.id, t.table_number, t.display_name
  from public.table_requests r
  join public.tables t on t.id = r.table_id
  where r.restaurant_id = p_restaurant_id
    and r.status = 'open'
  order by r.created_at;
end;
$$;

comment on function public.get_open_table_requests(uuid) is
  'The staff-facing queue: open requests for a restaurant, oldest first, with the table number resolved.';

-- Grants --------------------------------------------------------------------
--
-- Supabase default privileges grant EXECUTE on every new public function
-- to anon, authenticated and service_role, and `revoke ... from public`
-- alone does NOT undo that — see 20260919090000. Revoked from anon
-- explicitly below.
--
-- `authenticated` KEEPS execute on all four, and that is correct rather
-- than an oversight: a diner who scanned a table QR is an anonymous auth
-- user, which is the `authenticated` role. Each function re-checks the
-- caller inside — by customer session for the diner ones, by
-- is_restaurant_member() for the staff ones.

revoke execute on function public.create_table_request(text, text) from public, anon;
revoke execute on function public.resolve_table_request(uuid) from public, anon;
revoke execute on function public.cancel_table_request(uuid) from public, anon;
revoke execute on function public.get_open_table_requests(uuid) from public, anon;
