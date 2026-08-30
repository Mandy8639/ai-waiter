-- Reservations (product decisions from scoping — see docs/security.md#reservations):
--
-- 1. Staff-only entry in v1 — no customer-facing booking page. Every
--    reservation is created by an owner/manager/staff member via the
--    dashboard, on behalf of a phone-in/walk-in customer. Kitchen role is
--    excluded (front-of-house concern, not food prep — mirrors the
--    owner/manager/kitchen split order-splitting/merging already uses in
--    the other direction).
--
-- 2. A reservation is assigned a specific table at creation time, and
--    create_reservation() rejects a booking that would double-book that
--    table within a 90-MINUTE ASSUMED SEATING WINDOW of another
--    confirmed/seated reservation (fixed v1 constant — search this file
--    for "90 minutes" if it ever needs to become configurable per
--    restaurant). No party-size-vs-table-capacity validation in v1 —
--    staff pick an appropriately sized table themselves.
--
-- 3. Status lifecycle: confirmed -> seated -> completed, plus cancelled
--    and no_show (both reachable only from confirmed). All terminal
--    states (completed/cancelled/no_show) free the table for new
--    bookings at that slot, since the conflict check only looks at
--    confirmed/seated reservations.
--
-- v1 explicitly does NOT support: editing table_id or reservation_time
-- after creation (cancel and create a new reservation instead — see the
-- immutable-fields trigger below), a separate reservation-status audit
-- trail (order_status_history has no reservation equivalent yet), or any
-- Realtime sync on the reservations list (it's a planning tool, not a
-- live board like the kitchen display).
--
-- Every write path is a SECURITY DEFINER function, mirroring
-- order_ticket_groups'/orders' own "no direct client UPDATE" philosophy
-- (see 20260829100000_order_ticket_groups.sql and
-- 20260823100200_orders.sql) — RLS grants SELECT only.

-- tables (restaurant_id, id) is already unique — see
-- 20260822090000_table_public_tokens.sql, which added it for the QR-token
-- feature's own tenant-scoped FK — reused here for the same purpose.
create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  table_id uuid not null,
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  party_size integer not null,
  reservation_time timestamptz not null,
  status text not null default 'confirmed',
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reservations_table_same_restaurant
    foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id)
    on delete restrict,
  constraint reservations_status_valid check (
    status in ('confirmed', 'seated', 'completed', 'cancelled', 'no_show')
  ),
  constraint reservations_party_size_positive check (party_size > 0),
  constraint reservations_customer_name_not_blank check (length(trim(customer_name)) > 0),
  constraint reservations_customer_phone_not_blank check (length(trim(customer_phone)) > 0),
  constraint reservations_notes_length check (notes is null or length(notes) <= 500)
);

comment on table public.reservations is
  'Staff-entered table bookings. table_id/reservation_time are immutable after creation (see enforce_reservation_immutable_fields) — cancel and create a new reservation to reschedule. See docs/security.md#reservations.';

create index reservations_restaurant_id_time_idx
  on public.reservations (restaurant_id, reservation_time);
create index reservations_table_id_time_idx
  on public.reservations (table_id, reservation_time);

create trigger trg_reservations_set_updated_at
  before update on public.reservations
  for each row
  execute function public.set_updated_at();

alter table public.reservations enable row level security;

create policy "reservations_select_front_of_house"
  on public.reservations
  for select
  to authenticated
  using (public.current_restaurant_role(restaurant_id) in ('owner', 'manager', 'staff'));

-- No INSERT/UPDATE/DELETE policy for any role: only the SECURITY DEFINER
-- functions below ever write here (create_reservation(),
-- update_reservation_details(), transition_reservation_status()) —
-- matching order_ticket_groups' function-only-write philosophy. No
-- DELETE at all in v1 — cancel via status instead, keeping a permanent
-- record of what was booked.

-- The reservation state machine, expressed as data (mirrors
-- is_valid_order_status_transition()'s exact shape/purpose) — the single
-- source of truth both the structural trigger and
-- transition_reservation_status() read from.
--
--   confirmed -> seated -> completed
--   confirmed -> cancelled
--   confirmed -> no_show
--
-- Deliberately NOT allowed: skipping straight to completed/cancelled/
-- no_show from seated (a seated party has shown up — from there the only
-- forward move is completed), and anything out of a terminal state
-- (completed/cancelled/no_show).
create function public.is_valid_reservation_status_transition(
  from_status text,
  to_status text
)
returns boolean
language sql
immutable
as $$
  select case
    when from_status = 'confirmed' and to_status in ('seated', 'cancelled', 'no_show') then true
    when from_status = 'seated' and to_status = 'completed' then true
    else false
  end
$$;

comment on function public.is_valid_reservation_status_transition(text, text) is
  'The reservation state machine''s legal-transition table. confirmed -> seated -> completed, plus confirmed -> cancelled/no_show. Used by both the structural trigger and transition_reservation_status().';

-- Defense in depth (same rationale as enforce_order_status_transition()):
-- fires on EVERY update to reservations, not just ones through
-- transition_reservation_status(), so a bug in that function or any
-- future privileged write path still cannot produce an illegal status.
create function public.enforce_reservation_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status <> old.status
    and not public.is_valid_reservation_status_transition(old.status, new.status)
  then
    raise exception 'invalid reservation status transition: % -> %', old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.enforce_reservation_status_transition() is
  'Trigger: the structural half of the reservation state machine — rejects any UPDATE that would set an illegal status, regardless of who or what issues it.';

create trigger trg_reservations_enforce_status_transition
  before update on public.reservations
  for each row
  execute function public.enforce_reservation_status_transition();

-- table_id/reservation_time drive the double-booking check in
-- create_reservation() — changing either after the fact without
-- re-running that check could silently create a conflict, so v1 simply
-- disallows changing them at all (cancel and create a new reservation
-- instead). restaurant_id is immutable for the same reason every other
-- table in this schema treats tenant identity as immutable.
create function public.enforce_reservation_immutable_fields()
returns trigger
language plpgsql
as $$
begin
  if new.restaurant_id <> old.restaurant_id
    or new.table_id <> old.table_id
    or new.reservation_time <> old.reservation_time
  then
    raise exception 'reservations: restaurant, table, and reservation time are immutable after creation — cancel and create a new reservation instead';
  end if;
  return new;
end;
$$;

comment on function public.enforce_reservation_immutable_fields() is
  'Trigger: rejects any UPDATE that changes a reservation''s tenant/table/time fields, regardless of role or write path. See docs/security.md#reservations.';

create trigger trg_reservations_enforce_immutable_fields
  before update on public.reservations
  for each row
  execute function public.enforce_reservation_immutable_fields();

-- The only path that creates a reservation. SECURITY DEFINER to run the
-- double-booking check and insert atomically under an advisory lock
-- (concurrent bookings for the SAME table serialize; different tables
-- never contend) — cheap insurance against a rare but real race between
-- two staff members booking the same table at once.
create function public.create_reservation(
  p_restaurant_id uuid,
  p_table_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_party_size integer,
  p_reservation_time timestamptz,
  p_notes text
)
returns public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_reservation public.reservations%rowtype;
  v_conflict_exists boolean;
begin
  if v_user_id is null then
    raise exception 'RESERVATION_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  v_role := public.current_restaurant_role(p_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'staff') then
    raise exception 'RESERVATION_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.tables
    where id = p_table_id and restaurant_id = p_restaurant_id and is_active
  ) then
    raise exception 'RESERVATION_TABLE_NOT_FOUND: table not found for this restaurant';
  end if;

  if trim(coalesce(p_customer_name, '')) = '' then
    raise exception 'RESERVATION_INVALID_NAME: customer name is required' using errcode = '22023';
  end if;
  if trim(coalesce(p_customer_phone, '')) = '' then
    raise exception 'RESERVATION_INVALID_PHONE: customer phone is required' using errcode = '22023';
  end if;
  if p_party_size is null or p_party_size <= 0 then
    raise exception 'RESERVATION_INVALID_PARTY_SIZE: party size must be positive' using errcode = '22023';
  end if;
  if p_reservation_time is null then
    raise exception 'RESERVATION_INVALID_TIME: reservation time is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_table_id::text));

  -- 90-minute assumed seating window (v1 fixed constant — see this
  -- file's header comment). Two equal-length intervals starting at t1/t2
  -- overlap iff |t1 - t2| < duration; expressed here without abs() as a
  -- symmetric BETWEEN-style range so it reads directly off the column.
  select exists (
    select 1 from public.reservations
    where table_id = p_table_id
      and status in ('confirmed', 'seated')
      and reservation_time > (p_reservation_time - interval '90 minutes')
      and reservation_time < (p_reservation_time + interval '90 minutes')
  ) into v_conflict_exists;

  if v_conflict_exists then
    raise exception 'RESERVATION_TABLE_CONFLICT: this table already has a reservation within 90 minutes of the requested time'
      using errcode = '23514';
  end if;

  insert into public.reservations (
    restaurant_id, table_id, customer_name, customer_phone, customer_email,
    party_size, reservation_time, notes, created_by, status
  ) values (
    p_restaurant_id, p_table_id, trim(p_customer_name), trim(p_customer_phone),
    nullif(trim(coalesce(p_customer_email, '')), ''), p_party_size, p_reservation_time,
    nullif(trim(coalesce(p_notes, '')), ''), v_user_id, 'confirmed'
  )
  returning * into v_reservation;

  return v_reservation;
end;
$$;

comment on function public.create_reservation(uuid, uuid, text, text, text, integer, timestamptz, text) is
  'Books a table for a customer. Rejects a double-booking within a 90-minute assumed seating window of another confirmed/seated reservation on the same table. owner/manager/staff only. See docs/security.md#reservations.';

revoke execute on function public.create_reservation(uuid, uuid, text, text, text, integer, timestamptz, text) from public;
grant execute on function public.create_reservation(uuid, uuid, text, text, text, integer, timestamptz, text) to authenticated;

-- Edits a reservation's contact/party-size/notes fields only — never
-- table_id/reservation_time/status (see enforce_reservation_immutable_fields
-- and transition_reservation_status() respectively).
create function public.update_reservation_details(
  p_reservation_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_party_size integer,
  p_notes text
)
returns public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_role text;
begin
  if v_user_id is null then
    raise exception 'RESERVATION_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  select * into v_reservation from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND: reservation not found';
  end if;

  v_role := public.current_restaurant_role(v_reservation.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'staff') then
    raise exception 'RESERVATION_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  if trim(coalesce(p_customer_name, '')) = '' then
    raise exception 'RESERVATION_INVALID_NAME: customer name is required' using errcode = '22023';
  end if;
  if trim(coalesce(p_customer_phone, '')) = '' then
    raise exception 'RESERVATION_INVALID_PHONE: customer phone is required' using errcode = '22023';
  end if;
  if p_party_size is null or p_party_size <= 0 then
    raise exception 'RESERVATION_INVALID_PARTY_SIZE: party size must be positive' using errcode = '22023';
  end if;

  update public.reservations
  set customer_name = trim(p_customer_name),
      customer_phone = trim(p_customer_phone),
      customer_email = nullif(trim(coalesce(p_customer_email, '')), ''),
      party_size = p_party_size,
      notes = nullif(trim(coalesce(p_notes, '')), '')
  where id = p_reservation_id
  returning * into v_reservation;

  return v_reservation;
end;
$$;

comment on function public.update_reservation_details(uuid, text, text, text, integer, text) is
  'Edits a reservation''s customer/party-size/notes fields only. Table and time cannot be changed here — see enforce_reservation_immutable_fields(). owner/manager/staff only.';

revoke execute on function public.update_reservation_details(uuid, text, text, text, integer, text) from public;
grant execute on function public.update_reservation_details(uuid, text, text, text, integer, text) to authenticated;

-- The only path that changes a reservation's status.
create function public.transition_reservation_status(
  p_reservation_id uuid,
  p_target_status text
)
returns public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_role text;
begin
  if v_user_id is null then
    raise exception 'RESERVATION_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  if p_target_status is null
    or p_target_status not in ('confirmed', 'seated', 'completed', 'cancelled', 'no_show')
  then
    raise exception 'RESERVATION_INVALID_STATUS: unknown target status';
  end if;

  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND: reservation not found';
  end if;

  v_role := public.current_restaurant_role(v_reservation.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'staff') then
    raise exception 'RESERVATION_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  if not public.is_valid_reservation_status_transition(v_reservation.status, p_target_status) then
    raise exception 'RESERVATION_INVALID_TRANSITION: cannot move a reservation from % to %',
      v_reservation.status, p_target_status
      using errcode = '23514';
  end if;

  update public.reservations
  set status = p_target_status
  where id = p_reservation_id
  returning * into v_reservation;

  return v_reservation;
end;
$$;

comment on function public.transition_reservation_status(uuid, text) is
  'The only path that changes a reservation''s status. owner/manager/staff can perform any structurally-valid transition (no per-role matrix — this is a front-of-house action, not a kitchen-workflow one). See docs/security.md#reservations.';

revoke execute on function public.transition_reservation_status(uuid, text) from public;
grant execute on function public.transition_reservation_status(uuid, text) to authenticated;
