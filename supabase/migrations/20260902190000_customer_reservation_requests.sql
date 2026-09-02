-- Customer-facing reservations: a diner asks, the restaurant decides.
--
-- create_reservation() has always required an owner/manager/staff role, so
-- a diner could not book at all. This adds the other half.
--
--
-- WHY A REQUEST RATHER THAN A BOOKING
--
-- A reservation needs a table, and nothing in this schema knows how many
-- people a table seats: `tables` has table_number, display_name and
-- is_active, and no capacity at all. A function that auto-assigned one
-- would therefore be guessing, and its confident 'confirmed' would put a
-- party of ten on a two-top and only reveal it when they walked in.
--
-- So a diner's booking arrives as 'pending' with no table, and a person
-- who can see the room assigns one. That is also how restaurants already
-- take online bookings, which matters more than the schema being tidy.
--
--
-- WHAT THIS COSTS
--
-- table_id becomes nullable, which is a real loss: it was a NOT NULL
-- column and every existing row had one. The check constraint below buys
-- most of it back — only a 'pending' row may have no table, so nothing
-- that was ever confirmed can lose one — but "nullable with a rule" is
-- weaker than "never null" and worth naming rather than glossing over.

alter table public.reservations
  alter column table_id drop not null;

alter table public.reservations
  drop constraint reservations_status_valid;

alter table public.reservations
  add constraint reservations_status_valid check (
    status in ('pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show')
  );

-- A table is optional only while nobody has accepted the booking. The
-- moment it is confirmed, seated or completed, it names a real table.
-- 'cancelled' is allowed either way: a request refused before anyone
-- assigned a table never had one to keep.
alter table public.reservations
  add constraint reservations_table_required_once_accepted check (
    table_id is not null or status in ('pending', 'cancelled')
  );

comment on column public.reservations.table_id is
  'The assigned table. Null only for a pending customer request that no one has accepted yet — see reservations_table_required_once_accepted.';


-- Assigning a table to a pending request has to be possible, and the
-- immutability trigger blocked changing table_id.
--
-- It happened to permit this already, but only by accident: the old test
-- was `new.table_id <> old.table_id`, and comparing anything to a NULL
-- old value yields NULL rather than true, so the branch quietly did not
-- fire. Depending on three-valued logic for a rule this important is how
-- a later reader "simplifies" it into a bug, so the intent is now written
-- down: a table may be filled in once, and never moved afterwards.
create or replace function public.enforce_reservation_immutable_fields()
returns trigger
language plpgsql
as $$
begin
  if new.restaurant_id <> old.restaurant_id
    or new.reservation_time <> old.reservation_time
  then
    raise exception 'reservations: restaurant and reservation time are immutable after creation — cancel and create a new reservation instead';
  end if;

  if old.table_id is not null and new.table_id is distinct from old.table_id then
    raise exception 'reservations: the table is immutable once assigned — cancel and create a new reservation instead';
  end if;

  return new;
end;
$$;


-- A pending request can only be accepted or turned down. It deliberately
-- cannot go straight to 'seated': seating someone requires a table, and a
-- pending row has none.
create or replace function public.is_valid_reservation_status_transition(
  from_status text,
  to_status text
)
returns boolean
language sql
immutable
as $$
  select case
    when from_status = 'pending' and to_status in ('confirmed', 'cancelled') then true
    when from_status = 'confirmed' and to_status in ('seated', 'cancelled', 'no_show') then true
    when from_status = 'seated' and to_status = 'completed' then true
    else false
  end
$$;


-- A diner may read the reservations they themselves requested, for as long
-- as their browser keeps the anonymous token that created them. Without
-- this, someone could book and then have no way to see what they booked —
-- reservations_select_front_of_house is staff-only.
create policy "reservations_select_own_request"
  on public.reservations
  for select
  to authenticated
  using (created_by = (select auth.uid()));


-- How many requests this caller has made here recently. Used by
-- request_reservation() below, and separately callable so the app can say
-- "you have a few open already" before showing a form.
create function public.count_recent_reservation_requests(
  target_restaurant_id uuid,
  window_minutes integer default 60
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.reservations r
  where r.restaurant_id = target_restaurant_id
    and r.created_by = auth.uid()
    and r.created_at > now() - make_interval(mins => window_minutes)
$$;

comment on function public.count_recent_reservation_requests(uuid, integer) is
  'How many reservations the calling user has created at this restaurant within the window. Scoped to auth.uid() so it can never count someone else''s. See docs/security.md#reservations.';

revoke execute on function public.count_recent_reservation_requests(uuid, integer) from public;
grant execute on function public.count_recent_reservation_requests(uuid, integer) to authenticated;


-- A diner asking for a table.
--
-- Deliberately NOT role-gated: this is the one reservation write a person
-- with no relationship to the restaurant may perform. Everything that
-- would otherwise be dangerous about that is constrained here rather than
-- left to the caller.
create function public.request_reservation(
  p_restaurant_id uuid,
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
  v_recent integer;
  v_reservation public.reservations%rowtype;
begin
  -- Anonymous is fine — a diner scanning a QR code is an anonymous auth
  -- user. Having no identity at all is not: created_by is what later lets
  -- them read their own booking back.
  if v_user_id is null then
    raise exception 'RESERVATION_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.restaurants where id = p_restaurant_id
  ) then
    raise exception 'RESERVATION_RESTAURANT_NOT_FOUND: no such restaurant' using errcode = 'P0002';
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
  -- An upper bound as well as a lower one: a party of 400 is not a
  -- booking, and without a ceiling the field is a way to make the
  -- dashboard unreadable.
  if p_party_size > 50 then
    raise exception 'RESERVATION_PARTY_TOO_LARGE: call the restaurant for a party this size'
      using errcode = '22023';
  end if;
  if p_reservation_time is null then
    raise exception 'RESERVATION_INVALID_TIME: reservation time is required' using errcode = '22023';
  end if;
  -- Staff may record a booking taken by phone a moment ago; a diner
  -- booking a table for last Tuesday is a mistake or a probe.
  if p_reservation_time <= now() then
    raise exception 'RESERVATION_TIME_IN_PAST: choose a time in the future' using errcode = '22023';
  end if;
  if p_reservation_time > now() + interval '365 days' then
    raise exception 'RESERVATION_TIME_TOO_FAR: choose a date within the next year' using errcode = '22023';
  end if;

  -- Rate limit inside the function rather than in the app. This is a
  -- write path any anonymous caller can reach directly, so a check that
  -- lives only in a server action is a check that can be skipped.
  v_recent := public.count_recent_reservation_requests(p_restaurant_id, 60);
  if v_recent >= 5 then
    raise exception 'RESERVATION_TOO_MANY_REQUESTS: too many booking requests — please call the restaurant'
      using errcode = '53400';
  end if;

  insert into public.reservations (
    restaurant_id, table_id, customer_name, customer_phone, customer_email,
    party_size, reservation_time, notes, created_by, status
  ) values (
    p_restaurant_id, null, trim(p_customer_name), trim(p_customer_phone),
    nullif(trim(coalesce(p_customer_email, '')), ''), p_party_size, p_reservation_time,
    nullif(trim(coalesce(p_notes, '')), ''), v_user_id, 'pending'
  )
  returning * into v_reservation;

  return v_reservation;
end;
$$;

comment on function public.request_reservation(uuid, text, text, text, integer, timestamptz, text) is
  'A diner requesting a table. Creates a pending reservation with no table assigned; staff accept it with confirm_reservation_request(). Not role-gated — the only reservation write an outsider may perform. See docs/security.md#reservations.';

revoke execute on function public.request_reservation(uuid, text, text, text, integer, timestamptz, text) from public;
grant execute on function public.request_reservation(uuid, text, text, text, integer, timestamptz, text) to authenticated;


-- Staff accepting a request, and choosing the table it happens at.
--
-- The 90-minute conflict check lives here rather than at request time
-- because until a table is chosen there is nothing to conflict with —
-- which is the whole reason a person does the choosing.
create function public.confirm_reservation_request(
  p_reservation_id uuid,
  p_table_id uuid
)
returns public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_reservation public.reservations%rowtype;
  v_conflict_exists boolean;
begin
  select * into v_reservation
  from public.reservations where id = p_reservation_id;

  if not found then
    raise exception 'RESERVATION_NOT_FOUND: no such reservation' using errcode = 'P0002';
  end if;

  v_role := public.current_restaurant_role(v_reservation.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'staff') then
    raise exception 'RESERVATION_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  if v_reservation.status <> 'pending' then
    raise exception 'RESERVATION_NOT_PENDING: this booking has already been dealt with'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.tables
    where id = p_table_id
      and restaurant_id = v_reservation.restaurant_id
      and is_active
  ) then
    raise exception 'RESERVATION_TABLE_NOT_FOUND: table not found for this restaurant';
  end if;

  -- Same lock and same window as create_reservation(): two staff members
  -- accepting two requests onto one table at the same moment would
  -- otherwise both look, see nothing, and both proceed.
  perform pg_advisory_xact_lock(hashtext(p_table_id::text));

  select exists (
    select 1 from public.reservations
    where table_id = p_table_id
      and status in ('confirmed', 'seated')
      and reservation_time > (v_reservation.reservation_time - interval '90 minutes')
      and reservation_time < (v_reservation.reservation_time + interval '90 minutes')
  ) into v_conflict_exists;

  if v_conflict_exists then
    raise exception 'RESERVATION_TABLE_CONFLICT: this table already has a reservation within 90 minutes of the requested time'
      using errcode = '23514';
  end if;

  update public.reservations
  set table_id = p_table_id,
      status = 'confirmed'
  where id = p_reservation_id
  returning * into v_reservation;

  return v_reservation;
end;
$$;

comment on function public.confirm_reservation_request(uuid, uuid) is
  'Staff accepting a pending customer request and assigning it a table, with the same 90-minute conflict check create_reservation() uses. See docs/security.md#reservations.';

revoke execute on function public.confirm_reservation_request(uuid, uuid) from public;
grant execute on function public.confirm_reservation_request(uuid, uuid) to authenticated;
