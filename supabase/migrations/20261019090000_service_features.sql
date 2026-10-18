-- Three small things restaurants hit every week.
--
--   1. "Sold out until tomorrow". The kitchen runs out of lamb at 8pm and
--      shouldn't have to remember to switch it back on in the morning.
--      menu_items.available_again_at holds when it comes back: the
--      restaurant's next opening (next_opening_after()). A pg_cron job puts
--      due dishes back every minute (restore_menu_items_due()).
--
--   2. Holiday and special hours. restaurant_special_hours holds one row per
--      date: closed all day, or open only between two times. menu_on_now()
--      — the single "is this menu on right now" check behind the diner menu,
--      the AI waiter and the order_items backstop trigger — now also asks
--      special_hours_allow_now(), so a closed day closes ordering everywhere
--      at once. Diners see why through get_special_hours_today().
--
--   3. "Order another round" needs nothing new here: it re-adds the last
--      order's lines through the ordinary cart path, which re-prices and
--      re-checks every line (src/lib/cart/reorder-actions.ts).
--
-- The scheduler is guarded like 20261012090000_order_ring.sql: where
-- pg_cron isn't available (the PGlite test harness) it is skipped and
-- everything else still applies. It needs pg_cron only, not pg_net.


-- 1. Sold out until the next opening ---------------------------------------

alter table public.menu_items
  add column available_again_at timestamptz;

comment on column public.menu_items.available_again_at is
  'When a dish marked "sold out until tomorrow" comes back by itself (the restaurant''s next opening). Null when it is available, or sold out until someone says otherwise.';

-- Back in stock means no timer, whoever switched it back.
create function public.menu_items_clear_available_again_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.is_available then
    new.available_again_at := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.menu_items_clear_available_again_at() from public, anon, authenticated;

create trigger menu_items_clear_available_again_at
  before insert or update on public.menu_items
  for each row execute function public.menu_items_clear_available_again_at();

-- The plain switch now also clears any timer: "sold out" from here means
-- sold out until someone says otherwise.
create or replace function public.set_menu_item_availability(
  p_menu_item_id uuid,
  p_available boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_role text;
begin
  if p_available is null then
    raise exception 'SOLD_OUT_INVALID: say whether the dish is available'
      using errcode = '22023';
  end if;

  select mi.restaurant_id into v_restaurant_id
  from public.menu_items mi where mi.id = p_menu_item_id;

  if not found then
    raise exception 'SOLD_OUT_NOT_FOUND: no such dish' using errcode = 'P0002';
  end if;

  -- SECURITY DEFINER bypasses RLS, so this role check IS the access control.
  v_role := public.current_restaurant_role(v_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'SOLD_OUT_FORBIDDEN: only the kitchen or a manager can change this'
      using errcode = '42501';
  end if;

  update public.menu_items
  set is_available = p_available,
      available_again_at = null
  where id = p_menu_item_id;
end;
$$;


-- 2. Holiday and special hours ----------------------------------------------
-- (Before next_opening_after(), which skips closed days.)

create table public.restaurant_special_hours (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  -- A calendar date in the restaurant's timezone.
  day date not null,
  closed boolean not null default false,
  opens_at time,
  closes_at time,
  note text,
  created_at timestamptz not null default now(),

  constraint restaurant_special_hours_one_per_day unique (restaurant_id, day),
  -- Closed all day has no times; open has both, the same day, in order.
  -- '24:00' is a valid closing time, as in menu_hours.
  constraint restaurant_special_hours_shape check (
    (closed and opens_at is null and closes_at is null)
    or (not closed and opens_at is not null and closes_at is not null
        and closes_at > opens_at)
  ),
  constraint restaurant_special_hours_note_length
    check (note is null or char_length(note) <= 80)
);

comment on table public.restaurant_special_hours is
  'Dates a restaurant is closed, or open only between two times (holidays, private events). Overrides menu hours for that date: menu_on_now() asks special_hours_allow_now().';

alter table public.restaurant_special_hours enable row level security;

create policy "restaurant_special_hours_select_members" on public.restaurant_special_hours
  for select to authenticated using (public.is_restaurant_member(restaurant_id));
create policy "restaurant_special_hours_write_owner_manager" on public.restaurant_special_hours
  for all to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

-- Do today's special hours (if any) allow serving right now?
create function public.special_hours_allow_now(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select not s.closed
       and t.local_now::time >= s.opens_at
       and t.local_now::time < s.closes_at
    from public.restaurants r
    cross join lateral (select now() at time zone coalesce(r.timezone, 'UTC') as local_now) t
    join public.restaurant_special_hours s
      on s.restaurant_id = r.id and s.day = t.local_now::date
    where r.id = p_restaurant_id
  ), true)
$$;

revoke execute on function public.special_hours_allow_now(uuid) from public, anon, authenticated;

-- menu_on_now(), as in 20261004090000_multiple_menus.sql, and today's
-- special hours.
create or replace function public.menu_on_now(p_menu_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select m.is_published
      and public.special_hours_allow_now(m.restaurant_id)
      and (
        not exists (select 1 from public.menu_hours h where h.menu_id = m.id)
        or exists (
          select 1
          from public.menu_hours h,
               lateral (select now() at time zone coalesce(r.timezone, 'UTC') as local_now) t
          where h.menu_id = m.id
            and h.day_of_week = extract(dow from t.local_now)::smallint
            and t.local_now::time >= h.opens_at
            and t.local_now::time < h.closes_at
        )
      )
    from public.menus m
    join public.restaurants r on r.id = m.restaurant_id
    where m.id = p_menu_id
  ), false)
$$;

-- What diners are told: today's special hours, if there are any. Public,
-- like the menu itself; nothing here is private.
create function public.get_special_hours_today(target_restaurant_id uuid)
returns table (
  closed boolean,
  opens_at text,
  closes_at text,
  note text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.closed,
         to_char(s.opens_at, 'HH24:MI'),
         to_char(s.closes_at, 'HH24:MI'),
         s.note
  from public.restaurants r
  join public.restaurant_special_hours s
    on s.restaurant_id = r.id
   and s.day = (now() at time zone coalesce(r.timezone, 'UTC'))::date
  where r.id = target_restaurant_id
    and r.is_active
$$;

revoke execute on function public.get_special_hours_today(uuid) from public;
grant execute on function public.get_special_hours_today(uuid) to anon, authenticated;


-- 1, continued: when is "tomorrow"? -----------------------------------------

-- The restaurant's first opening on a later business day than p_from. A
-- business day starts at 04:00 local, so a dish marked sold out at 00:30
-- after a late service comes back at that same morning's opening.
--
-- A day's opening is the earliest opening (at or after 04:00 if any) of
-- its published menus; a published menu with no hours counts as 04:00.
-- Closed special days are skipped and special hours push the opening later.
-- With no opening in the next three weeks: 04:00 tomorrow.
create function public.next_opening_after(p_restaurant_id uuid, p_from timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_today date;
  v_day date;
  v_open time;
  v_special public.restaurant_special_hours%rowtype;
  v_at timestamptz;
begin
  select coalesce(r.timezone, 'UTC') into v_tz
  from public.restaurants r where r.id = p_restaurant_id;
  v_tz := coalesce(v_tz, 'UTC');

  -- The business day p_from falls in.
  v_today := ((p_from at time zone v_tz) - interval '4 hours')::date;

  for i in 1..21 loop
    v_day := v_today + i;

    select * into v_special
    from public.restaurant_special_hours s
    where s.restaurant_id = p_restaurant_id and s.day = v_day;

    if found and v_special.closed then
      continue;
    end if;

    if exists (
      select 1 from public.menus m
      where m.restaurant_id = p_restaurant_id
        and m.is_published
        and not exists (select 1 from public.menu_hours h where h.menu_id = m.id)
    ) then
      v_open := time '04:00';
    else
      select coalesce(min(h.opens_at) filter (where h.opens_at >= time '04:00'),
                      min(h.opens_at))
      into v_open
      from public.menu_hours h
      join public.menus m on m.id = h.menu_id
      where m.restaurant_id = p_restaurant_id
        and m.is_published
        and h.day_of_week = extract(dow from v_day)::smallint;
    end if;

    if v_open is null then
      continue; -- nothing opens that day
    end if;

    if v_special.id is not null and not v_special.closed then
      v_open := greatest(v_open, v_special.opens_at);
    end if;

    v_at := (v_day + v_open) at time zone v_tz;
    if v_at > p_from then
      return v_at;
    end if;
  end loop;

  return ((v_today + 1) + time '04:00') at time zone v_tz;
end;
$$;

comment on function public.next_opening_after(uuid, timestamptz) is
  'The restaurant''s first opening on a later business day (from 04:00 local) than the given moment, skipping closed special days. When a "sold out until tomorrow" dish comes back.';

revoke execute on function public.next_opening_after(uuid, timestamptz) from public, anon, authenticated;

-- "Sold out until tomorrow": who may, the same as the plain switch.
create function public.set_menu_item_sold_out_until_next_opening(p_menu_item_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_role text;
  v_back timestamptz;
begin
  select mi.restaurant_id into v_restaurant_id
  from public.menu_items mi where mi.id = p_menu_item_id;

  if not found then
    raise exception 'SOLD_OUT_NOT_FOUND: no such dish' using errcode = 'P0002';
  end if;

  -- SECURITY DEFINER bypasses RLS, so this role check IS the access control.
  v_role := public.current_restaurant_role(v_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'SOLD_OUT_FORBIDDEN: only the kitchen or a manager can change this'
      using errcode = '42501';
  end if;

  v_back := public.next_opening_after(v_restaurant_id, now());

  update public.menu_items
  set is_available = false,
      available_again_at = v_back
  where id = p_menu_item_id;

  return v_back;
end;
$$;

comment on function public.set_menu_item_sold_out_until_next_opening(uuid) is
  'Marks a dish sold out until the restaurant''s next opening, when restore_menu_items_due() puts it back. Owner, manager or kitchen. Returns when it comes back.';

revoke execute on function public.set_menu_item_sold_out_until_next_opening(uuid) from public, anon;
grant execute on function public.set_menu_item_sold_out_until_next_opening(uuid) to authenticated;

-- Puts back every dish whose time has come. Run by pg_cron, never by a
-- client.
create function public.restore_menu_items_due()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.menu_items
  set is_available = true
  where not is_available
    and available_again_at is not null
    and available_again_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.restore_menu_items_due() from public, anon, authenticated;

create index menu_items_available_again_at_idx
  on public.menu_items (available_again_at)
  where available_again_at is not null;

do $cron$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'menu items back: pg_cron not available here; scheduler skipped';
    return;
  end if;

  create extension if not exists pg_cron with schema pg_catalog;

  perform cron.schedule('menu-items-back', '* * * * *',
    'select public.restore_menu_items_due()');
end
$cron$;
